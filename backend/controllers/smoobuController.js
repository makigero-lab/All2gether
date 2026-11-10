/**
 * Controller: Smoobu — Conversão de Reservas em Tarefas (HF4)
 *
 * Reimplementação moderna da lógica de conversão de reservas Smoobu em
 * tarefas de limpeza, recuperada do histórico Git (commit pré-F0 681f807)
 * e adaptada ao schema atual do projeto.
 *
 * Diferenças vs código original (pré-F0):
 *   - REUTILIZA utils/loadBalancer.js (em vez de lógica inline duplicada).
 *     O loadBalancer.js atual tem a MESMA assinatura do determinarUtilizadorAtribuido
 *     original e inclui Algoritmo VIP + SLA 480min + Haversine + guardas NaN.
 *   - Recria os campos Propriedade.smoobu_id e Tarefa.smoobu_reserva_id
 *     (removidos em F0, essenciais para match e idempotência).
 *   - Usa SMOOBU_API_KEY global (process.env) — o projeto é single-tenant
 *     satélite; não recria Empresa.smoobu_api_key (multi-tenant legacy).
 *   - Mantém o padrão anti-timeout do Smoobu: resposta 200 imediata +
 *     processamento assíncrono via setImmediate.
 *
 * Regras de negócio preciosas (preservadas do original):
 *   - Tarefa agendada no dia do CHECK-OUT (departure), não no check-in.
 *     Se o webhook não trouxer departure, enriquece via REST API do Smoobu.
 *     Se mesmo assim não houver departure, fallback para arrival.
 *   - 1 tarefa por reserva (tipo 'limpeza'); não há check_in/check_out separados.
 *   - Idempotência por smoobu_reserva_id (não cria duplicados).
 *   - Cancelamento = soft delete (estado 'cancelada', liberta staff, mantém histórico).
 *   - Atualização revalida disponibilidade do staff no novo dia (sem shuffle completo).
 *   - 3 estados iniciais: 'atribuida' | 'nao_atribuida' (SLA excedido) | 'por_atribuir'.
 *   - Snapshot de checklist_dinamica do ModeloChecklist da propriedade.
 *   - Notificação fire-and-forget ao staff atribuído.
 *   - Tarefas concluídas são intocáveis (trabalho já feito).
 *
 * Robustez (anti-crash, herdada do original):
 *   - Toda a lógica de domínio corre dentro de try/catch no processarReservaSmoobu.
 *   - Falhas no load balancer → tarefa criada como 'por_atribuir'.
 *   - Falhas no scheduler → hora default 10:00 UTC (= 11:00 local UTC+1).
 *   - Falhas no enriquecimento → fallback para arrival.
 *   - Falhas na notificação → silenciadas (fire-and-forget).
 */

const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const ContactoHospede = require('../models/ContactoHospede');
const { registarAuditoria } = require('../utils/auditoria');
const { decidirPessoas } = require('../utils/pessoasCasa');
const WebhookLog = require('../models/WebhookLog');
const Ausencia = require('../models/Ausencia');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const { determinarUtilizadorAtribuido, determinarEquipaAtribuida } = require('../utils/loadBalancer');
const { diagnosticarFaltaDeStaff, planearAtribuicao, preencherVagaTarefa } = require('../utils/atribuicaoAutomatica');
const { idsEquipa: idsEquipaTarefa, retirarMembroDoc: retirarMembroTarefa } = require('../utils/equipaTarefa');
const {
  obterRangeDia,
  calcularInicioTarefaUtilizador,
  calcularInicioEquipa,
} = require('../utils/scheduler');
const { minutosLocais } = require('../utils/horario');
const { avisarGestores } = require('../utils/notificar');
const { inicioAutomaticoSemToque } = require('../utils/cicloTarefa');

/**
 * Avisa os gestores de que limpezas ficaram por atribuir. Com `opcoes.porAtribuir` (array)
 * só acumula (a sincronização envia UM aviso agregado no fim); sem ele envia já.
 * Best-effort: nunca lança.
 */
async function avisarPorAtribuirSmoobu(empresaId, item, opcoes = {}) {
  if (Array.isArray(opcoes.porAtribuir)) { opcoes.porAtribuir.push({ empresaId, ...item }); return; }
  await enviarAvisoPorAtribuir(empresaId, [item]);
}

async function enviarAvisoPorAtribuir(empresaId, itens) {
  try {
    if (!itens.length) return;
    const fmt = (d) => new Date(d).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Lisbon' });
    const texto = itens.length === 1
      ? `"${itens[0].nome}" (${fmt(itens[0].dia)}) ficou por atribuir: ${itens[0].motivo || 'sem motivo registado'}.`
      : `${itens.length} limpezas do Smoobu ficaram por atribuir (${itens.slice(0, 3).map((i) => `${i.nome} ${fmt(i.dia)}`).join(', ')}${itens.length > 3 ? '…' : ''}). Vê o motivo em cada tarefa.`;
    await avisarGestores(empresaId, '⚠️ Limpeza por atribuir', texto, '/gestor/tarefas');
  } catch (e) {
    console.error('⚠️  [Smoobu] aviso de por atribuir:', e.message);
  }
}

// Constantes de ações do Smoobu (com variantes legacy).
const ACOES_CRIAR = [
  'newReservation',
  'new_reservation',
  'reservation_created',
  'created',
];
const ACOES_ATUALIZAR = [
  'updateReservation',
  'update_reservation',
  'reservation_updated',
  'updated',
];
const ACOES_CANCELAR = [
  // Nomes oficiais da documentação do Smoobu (docs.smoobu.com › Webhooks).
  'cancelReservation',
  'deleteReservation',
  // Variantes legacy / de outros formatos.
  'cancellation',
  'cancel',
  'reservation_cancelled',
  'cancelled',
  'reservation_canceled',
  'canceled',
  'reservation_deleted',
  'deleted',
];

/**
 * Extrai os dados relevantes de um payload Smoobu.
 * Muito defensiva — cobre dezenas de variantes de nomes de campos
 * (camelCase, snake_case, kebab-case, aninhados, achatados).
 *
 * @param {object} payload - payload bruto recebido do Smoobu.
 * @returns {{
 *   action: string,
 *   smoobuPropId: string|null,
 *   dataCheckInRaw: string|null,
 *   dataCheckOutRaw: string|null,
 *   reservaId: string|null,
 *   detalhesReserva: { checkin: string|null, checkout: string|null, pax: number|null, nome_hospede: string|null }
 *   content: object
 * }}
 */
function extrairDadosReserva(payload) {
  const data = (payload && payload.data) || {};
  const content =
    (payload && payload.content) || payload || {};

  // action / type (default newReservation se ausente).
  const action =
    (payload && payload.action) ||
    (payload && payload.type) ||
    (content && content.action) ||
    'newReservation';

  // ID do apartamento Smoobu (match de propriedade).
  const smoobuPropIdRaw =
    data.apartment?.id ??
    data.apartmentId ??
    data.apartment_id ??
    data.propertyId ??
    data.property_id ??
    data.propriedade_id ??
    content.apartment?.id ??
    content.apartmentId ??
    content.apartment_id ??
    content.propertyId ??
    content.property_id ??
    content.propriedade_id ??
    null;
  const smoobuPropId = smoobuPropIdRaw != null ? String(smoobuPropIdRaw) : null;

  // Datas de check-in (arrival) e check-out (departure).
  const dataCheckInRaw =
    data.arrival ??
    data.check_in ??
    data.checkIn ??
    data.data_check_in ??
    data.startDate ??
    content.arrival ??
    content.check_in ??
    content.checkIn ??
    content.startDate ??
    null;
  const dataCheckOutRaw =
    data.departure ??
    data.check_out ??
    data.checkOut ??
    data.endDate ??
    content.departure ??
    content.check_out ??
    content.checkOut ??
    content.endDate ??
    null;

  // ID da reserva (idempotência).
  const reservaIdRaw =
    data.id ??
    data.reservationId ??
    data.reservation_id ??
    content.id ??
    content.reservationId ??
    content.reservation_id ??
    null;
  const reservaId = reservaIdRaw != null ? String(reservaIdRaw) : null;

  // Detalhes da reserva (checkin/checkout/pax/nome_hospede).
  const checkin =
    dataCheckInRaw != null ? String(dataCheckInRaw) : null;
  const checkout =
    dataCheckOutRaw != null ? String(dataCheckOutRaw) : null;

  // pax (número de hóspedes) — cobre variants e soma adults+children.
  let pax =
    data.guests ??
    data.numPeople ??
    data.numberOfGuests ??
    data.pax ??
    content.guests ??
    content.numPeople ??
    content.numberOfGuests ??
    content.pax ??
    null;
  if (pax == null) {
    const adults = Number(data.adults ?? content.adults ?? 0) || 0;
    const children = Number(data.children ?? content.children ?? 0) || 0;
    if (adults > 0 || children > 0) pax = adults + children;
  }
  pax = Number.isFinite(Number(pax)) ? Number(pax) : null;

  // nome_hospede — cobre guestName, guest_name, guest-name (kebab), guest.name,
  // guest.firstName+lastName, firstName+lastName, name, etc.
  let nomeHospede =
    data.guestName ??
    data.guest_name ??
    data['guest-name'] ??
    data.guest?.name ??
    data.guest?.firstName ??
    data.firstName ??
    data.first_name ??
    data.name ??
    content.guestName ??
    content.guest_name ??
    content['guest-name'] ??
    content.guest?.name ??
    content.guest?.firstName ??
    content.firstName ??
    content.first_name ??
    content.name ??
    null;

  // Composição firstName + lastName (se só veio firstName).
  if (!nomeHospede) {
    const fName = data.guest?.firstName ?? data.firstName ?? content.firstName ?? null;
    const lName = data.guest?.lastName ?? data.lastName ?? content.lastName ?? null;
    if (fName || lName) {
      nomeHospede = [fName, lName].filter(Boolean).join(' ').trim() || null;
    }
  }

  nomeHospede =
    nomeHospede != null ? String(nomeHospede).trim().slice(0, 200) : null;

  // Tipo da reserva no Smoobu ('reservation' | 'modification of booking' |
  // 'cancellation'). Um updateReservation com type 'cancellation' é um cancelamento.
  const tipoReserva = String(data.type ?? content.type ?? '');

  // Campos adicionais (docs.smoobu.com): horas, composição, notas, contacto.
  // Nota: 'check-in'/'check-out' (com hífen) são HORAS; as datas vêm em arrival/departure.
  const texto = (v, max) => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t ? t.slice(0, max) : null;
  };
  const inteiro = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const primeiro = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

  const detalhesReserva = {
    checkin,
    checkout,
    pax,
    nome_hospede: nomeHospede,
    hora_checkin: texto(primeiro(data['check-in'], content['check-in']), 20),
    hora_checkout: texto(primeiro(data['check-out'], content['check-out']), 20),
    adultos: inteiro(primeiro(data.adults, content.adults)),
    criancas: inteiro(primeiro(data.children, content.children)),
    notas_hospede: texto(primeiro(data.notice, content.notice), 2000),
    tipo_reserva: texto(tipoReserva, 60),
  };

  // Email/telefone: dados pessoais, guardados à parte (ContactoHospede), só admin.
  const contactoHospede = {
    email: texto(primeiro(data.email, content.email), 254),
    telefone: texto(primeiro(data.phone, content.phone), 50),
  };

  // Bloqueio de calendário (sem hóspede): não gera limpeza.
  const bloqueadaRaw = primeiro(data['is-blocked-booking'], content['is-blocked-booking']);
  const bloqueada = bloqueadaRaw === true || bloqueadaRaw === 'true' || bloqueadaRaw === 1 || bloqueadaRaw === '1';

  return {
    action: String(action),
    smoobuPropId,
    dataCheckInRaw: dataCheckInRaw != null ? String(dataCheckInRaw) : null,
    dataCheckOutRaw: dataCheckOutRaw != null ? String(dataCheckOutRaw) : null,
    reservaId,
    tipoReserva,
    detalhesReserva,
    contactoHospede,
    bloqueada,
    content,
  };
}

/** Junta `extra` a `base` preenchendo só os campos de `base` que estão vazios. */
function preencherVazios(base, extra) {
  const r = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if ((r[k] === null || r[k] === undefined || r[k] === '') && v !== null && v !== undefined && v !== '') {
      r[k] = v;
    }
  }
  return r;
}

/** Só os campos definidos (não nulos) — para atualizar sem apagar dados já guardados. */
function apenasDefinidos(obj) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

/**
 * Guarda/atualiza o email e o telefone do hóspede na coleção ContactoHospede
 * (separada das tarefas; só o admin os pode ler). Best-effort.
 */
async function guardarContactoHospede(tarefa, contacto) {
  try {
    const c = apenasDefinidos(contacto);
    if (!tarefa || (!c.email && !c.telefone)) return;
    const checkout = tarefa.detalhes_reserva?.checkout || tarefa.data;
    await ContactoHospede.findOneAndUpdate(
      { tarefa_id: tarefa._id },
      {
        $set: {
          empresa_id: tarefa.empresa_id,
          ...c,
          expira_em: ContactoHospede.calcularExpiracao(checkout),
          retencao_dias: ContactoHospede.RETENCAO_DIAS,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error('⚠️  [Smoobu] falha ao guardar contacto do hóspede (não bloqueia):', err.message);
  }
}

/**
 * Enriquece uma reserva fazendo GET à REST API do Smoobu.
 * Usado quando o webhook não traz departure ou nome_hospede (o webhook
 * oficial do Smoobu só envia arrival; departure exige chamada REST).
 *
 * Best-effort: se falhar (API key em falta, rede, 4xx/5xx), devolve null
 * e o chamador faz fallback para arrival.
 *
 * @param {string} reservaId - ID da reserva no Smoobu.
 * @param {import('mongoose').Types.ObjectId} [empresaId] - para ler a chave da BD (HF6).
 * @returns {Promise<object|null>} { departure, arrival, pax, nome_hospede } ou null.
 */
async function enriquecerReservaSmoobu(reservaId, empresaId) {
  const { chave: apiKey } = await obterApiKeySmoobu(empresaId);
  if (!apiKey || !reservaId) {
    console.warn(
      '⚠️  [Smoobu] enriquecerReservaSmoobu: API key em falta ou reservaId vazio — fallback para dados do webhook.'
    );
    return null;
  }

  try {
    const res = await fetch(
      `https://login.smoobu.com/api/reservations/${encodeURIComponent(reservaId)}`,
      {
        method: 'GET',
        headers: { 'Api-Key': apiKey.trim(), Accept: 'application/json' },
        signal: AbortSignal.timeout(15000), // 15s timeout
      }
    );

    if (!res.ok) {
      console.warn(
        `⚠️  [Smoobu] enriquecerReservaSmoobu: REST API devolveu ${res.status} ${res.statusText} para reserva ${reservaId}.`
      );
      return null;
    }

    const body = await res.json();
    const reserva = body?.data ?? body ?? {};

    const departure =
      reserva.departure ??
      reserva.end_date ??
      reserva.endDate ??
      null;
    const arrival =
      reserva.arrival ??
      reserva.start_date ??
      reserva.startDate ??
      null;
    const pax =
      reserva.guests ??
      reserva.numPeople ??
      reserva.numberOfGuests ??
      null;
    let nomeHospede =
      reserva.guestName ??
      reserva.guest_name ??
      reserva['guest-name'] ??
      reserva.guest?.name ??
      reserva.customerName ??
      reserva.customer?.name ??
      reserva.bookedForName ??
      reserva.name ??
      null;
    if (!nomeHospede) {
      const fName = reserva.guest?.firstName ?? reserva.firstName ?? null;
      const lName = reserva.guest?.lastName ?? reserva.lastName ?? null;
      if (fName || lName) {
        nomeHospede = [fName, lName].filter(Boolean).join(' ').trim() || null;
      }
    }
    if (nomeHospede) nomeHospede = String(nomeHospede).trim().slice(0, 200);

    // Campos adicionais (horas, composição, notas, contacto, bloqueio): reaproveita
    // o extrator do webhook, pois a REST devolve o mesmo objeto de reserva.
    const extra = extrairDadosReserva({ data: reserva });

    return {
      departure: departure != null ? String(departure) : null,
      arrival: arrival != null ? String(arrival) : null,
      pax: Number.isFinite(Number(pax)) ? Number(pax) : null,
      nome_hospede: nomeHospede,
      detalhes: extra.detalhesReserva,
      contacto: extra.contactoHospede,
      bloqueada: extra.bloqueada,
      // A REST do Smoobu pode devolver o tipo (cancellation) e/ou um status.
      cancelada:
        /cancel/i.test(String(extra.tipoReserva ?? '')) ||
        /cancel/i.test(String(reserva.status ?? reserva.bookingStatus ?? '')),
    };
  } catch (err) {
    console.warn(
      `⚠️  [Smoobu] enriquecerReservaSmoobu: falha ao buscar reserva ${reservaId}: ${err.message}`
    );
    return null;
  }
}

/**
 * Procura em WebhookLog um evento ANTERIOR de cancelamento desta reserva
 * (ação de cancelamento, ou updateReservation com type "cancellation").
 * Cobre o id como string ou número no payload e exclui o log atual.
 * Logs de autenticação falhada (payload não confiável) são ignorados.
 *
 * @returns {Promise<boolean>}
 */
async function existeCancelamentoAnterior(reservaId, empresaId, logAtualId = null) {
  if (!reservaId) return false;
  const ids = [String(reservaId)];
  if (/^\d+$/.test(String(reservaId)) && Number.isSafeInteger(Number(reservaId))) {
    ids.push(Number(reservaId));
  }
  const filtro = {
    ...(logAtualId ? { _id: { $ne: logAtualId } } : {}),
    empresa_id: { $in: [empresaId, null] },
    erro_msg: { $not: /^Autentica/ },
    'payload.data.id': { $in: ids },
    $or: [
      { 'payload.action': { $in: ACOES_CANCELAR } },
      { 'payload.action': { $in: ACOES_ATUALIZAR }, 'payload.data.type': /cancel/i },
    ],
  };
  return Boolean(await WebhookLog.exists(filtro));
}

/** Erro 11000 do índice único (smoobu_reserva_id, empresa_id). */
function ehDuplicadoReserva(err) {
  return Boolean(
    err &&
      err.code === 11000 &&
      (err.keyPattern?.smoobu_reserva_id !== undefined ||
        /smoobu_reserva_id/.test(String(err.message)))
  );
}

/**
 * Cria uma tarefa de limpeza a partir de uma reserva Smoobu.
 *
 * Fluxo:
 *   1. Idempotência: se já existe tarefa com este smoobu_reserva_id,
 *      reativa se estava cancelada, ou devolve a existente (sem duplicar).
 *   2. Match de propriedade por smoobu_id.
 *   3. Valida propriedade ativa + empresa ativa.
 *   4. Calcula tempo de limpeza (payload > propriedade > default 45).
 *   5. Load balancer (VIP + SLA 480min + Haversine) — best-effort.
 *   6. Scheduler sequencial (hora de início) — best-effort, fallback 10:00 UTC.
 *   7. Snapshot de checklist_dinamica do ModeloChecklist.
 *   8. Cria Tarefa com estado 'atribuida' | 'nao_atribuida' | 'por_atribuir'.
 *   9. Notifica o staff atribuído (fire-and-forget).
 *
 * @param {string} reservaId
 * @param {string} smoobuPropId
 * @param {string} dataTarefaRaw - "YYYY-MM-DD" (já departure || arrival).
 * @param {object} detalhesReserva - { checkin, checkout, pax, nome_hospede }.
 * @param {object} content - payload fallback para tempo_limpeza_minutos.
 * @returns {Promise<Tarefa|null>}
 */
async function criarTarefaPorReserva(
  reservaId,
  smoobuPropId,
  dataTarefaRaw,
  detalhesReserva,
  content,
  empresaRestrita = null,
  contacto = null,
  opcoes = {}
) {
  if (!smoobuPropId || !dataTarefaRaw) {
    throw new Error(
      'Payload do Smoobu inválido: propriedade (apartment.id) ou data em falta.'
    );
  }

  const range = obterRangeDia(dataTarefaRaw);
  if (!range) {
    throw new Error(`Data de tarefa inválida: ${dataTarefaRaw}`);
  }

  // 1. Idempotência: procura tarefa existente por smoobu_reserva_id.
  if (reservaId) {
    const existente = await Tarefa.findOne({ smoobu_reserva_id: reservaId });
    if (existente) {
      if (existente.estado === 'cancelada') {
        // Reserva re-ativada no Smoobu: reutiliza o fluxo de update (atualiza data,
        // apartamento e detalhes, e volta a passar pelo load balancer).
        const reativada = await atualizarTarefaPorReserva(
          reservaId,
          smoobuPropId,
          dataTarefaRaw,
          detalhesReserva,
          content,
          empresaRestrita,
          contacto,
          opcoes
        );
        console.log(
          `🔄 [Smoobu] tarefa ${existente._id} reativada (reserva ${reservaId} re-ativada).`
        );
        return reativada || existente;
      }
      // Webhook duplicado — sem ação.
      return existente;
    }
  }

  // 1b. Reserva já arquivada (tarefa concluída/cancelada há mais de 3 meses): um webhook
  // tardio/duplicado não pode recriar a limpeza.
  if (reservaId && (await TarefaArquivo.exists({ smoobu_reserva_id: String(reservaId) }))) {
    console.log(`ℹ️  [Smoobu] reserva ${reservaId} já arquivada — ignorada.`);
    return null;
  }

  // 2. Match de propriedade por smoobu_id.
  const propriedade = await Propriedade.findOne({
    smoobu_id: smoobuPropId,
    // SEGURANÇA (multi-tenant): se o webhook foi autenticado por uma empresa,
    // só pode afetar propriedades dessa empresa.
    ...(empresaRestrita ? { empresa_id: empresaRestrita } : {}),
  });
  if (!propriedade) {
    throw new Error(
      `Propriedade Smoobu ${smoobuPropId} não encontrada na BD. Importa/sincroniza as propriedades Smoobu primeiro.`
    );
  }

  // 3. Valida propriedade ativa.
  if (!propriedade.ativo) {
    throw new Error(
      `Propriedade "${propriedade.nome}" está suspensa (ativo: false). Tarefa não criada.`
    );
  }

  const empresaId = propriedade.empresa_id;

  // 3b. Valida empresa ativa (best-effort — não bloqueia se a verificação falhar).
  try {
    const Empresa = require('../models/Empresa');
    const empresa = await Empresa.findById(empresaId).select('ativa').lean();
    if (empresa && empresa.ativa === false) {
      throw new Error(
        `Empresa inativa. Webhooks rejeitados. Propriedade "${propriedade.nome}".`
      );
    }
  } catch (empErr) {
    if (empErr.message && empErr.message.includes('Empresa inativa')) throw empErr;
    console.error(
      '⚠️  [Smoobu] verificação de empresa ativa falhou (continua):',
      empErr.message
    );
  }

  // 3c. Cancelamento que chegou ANTES da reserva (webhooks fora de ordem): se há um
  //     evento de cancelamento anterior, confirma o estado real no Smoobu.
  //     - cancelada/bloqueada: não cria a tarefa;
  //     - ativa: cria normalmente;
  //     - consulta falhou: CRIA com alerta (uma limpeza a mais é melhor que uma em falta).
  let alertaCancelamentoPrevio = null;
  if (reservaId && (await existeCancelamentoAnterior(reservaId, empresaId, opcoes.logId))) {
    const confirmado = await enriquecerReservaSmoobu(reservaId, empresaId);
    const consultaOk = Boolean(confirmado && (confirmado.arrival || confirmado.departure));
    if (consultaOk && (confirmado.cancelada || confirmado.bloqueada)) {
      const nota = `Ignorada: cancelamento recebido antes da reserva e confirmado no Smoobu (reserva ${reservaId}).`;
      console.log(`ℹ️  [Smoobu] ${nota}`);
      if (opcoes.logId) {
        await WebhookLog.findByIdAndUpdate(opcoes.logId, { erro_msg: nota }).catch(() => {});
      }
      return null;
    }
    if (!consultaOk) {
      alertaCancelamentoPrevio =
        'Cancelamento recebido antes da reserva e não foi possível confirmar no Smoobu — verificar se a limpeza é necessária';
      console.warn(`⚠️  [Smoobu] reserva ${reservaId}: ${alertaCancelamentoPrevio}.`);
    }
  }

  // 4. Tempo de limpeza (payload > propriedade > default 45).
  const tempoLimpeza =
    content.tempo_limpeza_minutos ??
    content.cleaning_minutes ??
    propriedade.tempo_limpeza_minutos ??
    45;

  // HF23/HF24 — Número de hóspedes para cálculo dinâmico de lavandaria.
  // CRÍTICO: se pax for 0, null ou undefined (plataforma não enviou), faz
  // fallback para a capacidade_hospedes da propriedade. O operador ?? só
  // cobre null/undefined — precisamos de cobrir também 0 (falsy mas != null).
  let numHospedes = detalhesReserva.pax;
  if (numHospedes == null || numHospedes === 0) {
    // pax veio vazio/zero — usa a capacidade da propriedade.
    numHospedes = propriedade.capacidade_hospedes ?? null;
  }

  // 5. Atribuição HÍBRIDA (HF11 — Many-to-One + Load Balancer + HF12 flexibilidade VIP).
  //    Estratégia:
  //      (a) Se a propriedade TEM funcionario_preferencial_id e ele NÃO está
  //          de folga → atribui diretamente a ele. MAS (HF12) se o VIP só
  //          conseguir começar depois das 14h (carga alta), faz fallback ao
  //          LB para garantir que a casa fica pronta cedo.
  //      (b) Se a propriedade NÃO TEM staff exclusivo, OU se o staff exclusivo
  //          está de folga/inativo, OU se o VIP só começa tarde → faz fallback
  //          para o Load Balancer (determinarUtilizadorAtribuido — HF12 com
  //          Earliest Start Time).
  //      (c) Se o Load Balancer também não encontrar ninguém → por_atribuir
  //          (com alerta explicativo).
  //    Alertas (para o gestor intervir manualmente):
  //      - "Equipa exclusiva de folga (motivo)" — mas com fallback ao LB bem-sucedido
  //        NÃO gera alerta (a tarefa foi atribuída a outra pessoa).
  //      - "Equipa exclusiva de folga (motivo) — sem substituto disponível" — se o
  //        LB também falhou.
  //      - "Sem equipa disponível (load balancer não encontrou ninguém)" — se a
  //        propriedade não tem preferencial e o LB falhou.
  //      - "Equipa exclusiva sobrecarregada (início após 14h) — redistribuído" —
  //        se o VIP só começava tarde e o LB encontrou alguém mais cedo (alerta
  //        informativo, não bloqueante).

  // HF12 — Limiar de hora para fallback do VIP. Se o VIP só conseguir começar
  // a tarefa depois desta hora, faz fallback ao LB para paralelizar.
  // 14:00 locais (Europe/Lisbon, com hora de verão).
  const VIP_LIMITE_MINUTOS_LOCAIS = 14 * 60;

  const staffExclusivoId = propriedade.funcionario_preferencial_id;

  let utilizadorAtribuido = null;
  let tempoViagemMinutos = 0;
  let alertaTarefa = null;
  let tentouLoadBalancer = false;
  let equipaCompleta = []; // membros da equipa quando staff_necessario > 1
  let vipSobrecarregado = false; // HF12: VIP só começava tarde → fallback ao LB

  // (a) Tenta atribuir ao staff exclusivo se existir e não estiver de folga.
  if (staffExclusivoId) {
    const staffExclusivo = await Utilizador.findById(staffExclusivoId).lean();
    if (!staffExclusivo || !staffExclusivo.ativo || staffExclusivo.eliminado_em) {
      // Staff exclusivo inativo/eliminado → fallback ao LB.
      console.warn(
        `⚠️  [Smoobu] staff exclusivo ${staffExclusivoId} inativo/eliminado — fallback para load balancer.`
      );
    } else {
      // Verifica folgas no dia do check-out.
      const diaSemana = range.start.getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb
      const folgaFixa =
        Array.isArray(staffExclusivo.dias_folga) &&
        staffExclusivo.dias_folga.includes(diaSemana);

      // Folgas rotativas: verifica se há uma entrada com data no mesmo dia.
      let folgaRotativa = false;
      let motivoFolga = '';
      if (Array.isArray(staffExclusivo.folgas_rotativas)) {
        const diaCheckOutStr = range.start.toISOString().slice(0, 10);
        for (const fr of staffExclusivo.folgas_rotativas) {
          if (fr.data) {
            const diaFolgaStr = new Date(fr.data).toISOString().slice(0, 10);
            if (diaFolgaStr === diaCheckOutStr) {
              folgaRotativa = true;
              motivoFolga = fr.motivo || '';
              break;
            }
          }
        }
      }

      // Ausências (férias/baixa aprovadas ou falta súbita) também tornam o VIP indisponível.
      let ausenciaVIP = false;
      if (!folgaFixa && !folgaRotativa) {
        ausenciaVIP = !!(await Ausencia.exists({
          utilizador_id: staffExclusivoId,
          estado: { $in: ['aprovada', 'pendente_emergencia'] },
          data_inicio: { $lt: range.end },
          data_fim: { $gte: range.start },
        }));
        if (ausenciaVIP) motivoFolga = 'ausência';
      }

      if (folgaFixa || folgaRotativa || ausenciaVIP) {
        // Equipa exclusiva de folga/ausente → fallback ao LB.
        const motivo = (folgaRotativa || ausenciaVIP) && motivoFolga ? ` (${motivoFolga})` : '';
        console.log(
          `📋 [Smoobu] staff exclusivo ${staffExclusivoId} de folga no dia ` +
            `${range.start.toISOString().slice(0, 10)} (fixa=${folgaFixa}, ` +
            `rotativa=${folgaRotativa})${motivo} — fallback para load balancer.`
        );
        // Guarda o motivo para o alerta caso o LB também falhe.
        alertaTarefa = `Equipa exclusiva de folga${motivo}`;
      } else {
        // HF12 — Staff exclusivo disponível. Verifica se consegue começar cedo.
        // Se só conseguir começar depois das 14h (carga alta), faz fallback ao LB.
        try {
          const resultadoSchedulerVIP = await calcularInicioTarefaUtilizador(
            staffExclusivoId,
            range.start,
            propriedade.coordenadas,
            Number(tempoLimpeza) || 45,
            null,
            propriedade._id
          );
          const inicioVIP = resultadoSchedulerVIP.data;

          if (!resultadoSchedulerVIP.cabe || minutosLocais(inicioVIP) >= VIP_LIMITE_MINUTOS_LOCAIS) {
            // VIP sobrecarregado — não cabe no horário ou só começaria depois das 14h locais.
            vipSobrecarregado = true;
            console.log(
              `⏰ [HF12] staff exclusivo ${staffExclusivoId} ` +
                (resultadoSchedulerVIP.cabe ? `só começaria às ${inicioVIP.toISOString()} (≥14h locais)` : 'não cabe no horário') +
                ` — fallback ao load balancer para paralelizar.`
            );
          } else {
            // VIP disponível e começa cedo → atribui diretamente.
            utilizadorAtribuido = staffExclusivoId;
          }
        } catch (err) {
          // Se o scheduler falhar, atribui ao VIP anyway (não bloqueia).
          console.warn(
            `⚠️  [HF12] scheduler falhou para VIP ${staffExclusivoId}: ${err.message} — atribui ao VIP.`
          );
          utilizadorAtribuido = staffExclusivoId;
        }
      }
    }
  }

  // (b) Fallback ao Load Balancer se não há staff exclusivo ou ele está de folga/sobrecarregado.
  if (!utilizadorAtribuido) {
    tentouLoadBalancer = true;
    try {
      // HF21 — Se a propriedade exige múltiplos staff, usa determinarEquipaAtribuida.
      const staffNecessario = Number(propriedade.staff_necessario) || 1;
      let equipaResultado = null;

      if (staffNecessario > 1) {
        // Múltiplos staff — usa a nova função de equipa.
        const resultadoEquipa = await determinarEquipaAtribuida(
          empresaId,
          range,
          propriedade.coordenadas,
          Number(tempoLimpeza) || 45,
          vipSobrecarregado ? null : propriedade._id,
          staffNecessario
        );
        if (resultadoEquipa && resultadoEquipa.equipa.length > 0) {
          equipaResultado = resultadoEquipa;
          // O utilizador_id principal é o vencedor #1 (retrocompatibilidade).
          utilizadorAtribuido = resultadoEquipa.equipa[0].utilizadorId;
          equipaCompleta = resultadoEquipa.equipa.map((m) => m.utilizadorId);
          tempoViagemMinutos = Number(resultadoEquipa.equipa[0].tempoViagem) || 0;
          // Se a equipa é insuficiente, gera alerta.
          if (resultadoEquipa.insuficiente) {
            alertaTarefa = `Equipa parcial: ${resultadoEquipa.equipa.length}/${staffNecessario} elementos disponíveis`;
          }
          console.log(
            `👥 [HF21] Equipa de ${resultadoEquipa.equipa.length}/${staffNecessario} atribuída.`
          );
        }
      } else {
        // 1 staff — comportamento original.
        const resultadoLB = await determinarUtilizadorAtribuido(
          empresaId,
          range,
          propriedade.coordenadas,
          Number(tempoLimpeza) || 45,
          vipSobrecarregado ? null : propriedade._id
        );
        if (resultadoLB) {
          utilizadorAtribuido = resultadoLB.utilizadorId;
          tempoViagemMinutos = Number(resultadoLB.tempoViagem) || 0;
        }
      }

      // Limpa alerta de folga se o LB encontrou substituto.
      if (utilizadorAtribuido && alertaTarefa && !vipSobrecarregado && !equipaResultado?.insuficiente) {
        console.log(
          `✅ [Smoobu] load balancer encontrou substituto ${utilizadorAtribuido} ` +
            `para a tarefa (staff exclusivo estava de folga).`
        );
        alertaTarefa = null;
      }
      // HF12: VIP sobrecarregado + LB encontrou alguém.
      if (vipSobrecarregado && utilizadorAtribuido) {
        alertaTarefa = `Equipa exclusiva sobrecarregada (início após 14h) — redistribuído para ${utilizadorAtribuido}`;
        console.log(
          `✅ [HF12] load balancer redistribuiu tarefa para ${utilizadorAtribuido} ` +
            `(VIP estava sobrecarregado).`
        );
      }
    } catch (err) {
      console.error(
        '⚠️  [Smoobu] erro no load balancer (tarefa será criada sem atribuição):',
        err.message
      );
    }
  }

  // staff_necessario > 1 com staff exclusivo atribuído direto: completa a equipa com o
  // motor partilhado (antes ficava só o VIP e ninguém sabia que faltava gente).
  const staffNecessarioProp = Math.max(1, Number(propriedade.staff_necessario) || 1);
  if (utilizadorAtribuido && staffNecessarioProp > 1 && !tentouLoadBalancer) {
    equipaCompleta = [utilizadorAtribuido];
    try {
      const extra = await determinarEquipaAtribuida(
        empresaId, range, propriedade.coordenadas, Number(tempoLimpeza) || 45, propriedade._id,
        staffNecessarioProp - 1, new Set([String(utilizadorAtribuido)])
      );
      for (const m of extra?.equipa || []) equipaCompleta.push(m.utilizadorId);
    } catch (errEq) {
      console.warn('⚠️  [Smoobu] não foi possível completar a equipa do staff exclusivo:', errEq.message);
    }
  }
  let pessoasEmFalta = utilizadorAtribuido
    ? Math.max(0, staffNecessarioProp - Math.max(1, equipaCompleta.length))
    : 0;
  if (pessoasEmFalta > 0 && !alertaTarefa) {
    alertaTarefa = `Equipa parcial: ${staffNecessarioProp - pessoasEmFalta}/${staffNecessarioProp} elementos disponíveis`;
  }

  // (c) Se mesmo após o LB não há utilizador atribuído, define o alerta final.
  if (!utilizadorAtribuido) {
    if (tentouLoadBalancer && !alertaTarefa) {
      // Sem staff exclusivo e LB não encontrou ninguém.
      alertaTarefa = 'Sem equipa disponível (load balancer não encontrou ninguém)';
    } else if (alertaTarefa) {
      // Equipa exclusiva de folga E LB não encontrou substituto.
      alertaTarefa = `${alertaTarefa} — sem substituto disponível`;
    } else {
      alertaTarefa = 'Sem equipa disponível';
    }
  }

  // 6. Scheduler sequencial (hora de início) — só se há staff atribuído.
  let dataAgendada;
  let tempoViagemScheduler = 0;
  let motivoSemHorario = null;
  if (utilizadorAtribuido) {
    try {
      // Equipa de 2+: começa quando TODOS conseguem (mesmo cálculo de todos os caminhos).
      const resultadoScheduler = await calcularInicioEquipa(
        equipaCompleta.length > 0 ? equipaCompleta : [utilizadorAtribuido],
        range.start,
        propriedade.coordenadas,
        Number(tempoLimpeza) || 45,
        null,
        propriedade._id
      );
      if (!resultadoScheduler.cabe) {
        // Nunca se inventa uma hora: sem lugar no horário, fica por atribuir com o motivo real.
        motivoSemHorario = resultadoScheduler.motivo;
        utilizadorAtribuido = null;
        pessoasEmFalta = 0;
        equipaCompleta = [];
        tentouLoadBalancer = true;
        alertaTarefa = motivoSemHorario;
        dataAgendada = new Date(range.start);
        dataAgendada.setUTCHours(10, 0, 0, 0);
      } else {
        dataAgendada = resultadoScheduler.data;
        tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
      }
    } catch (err) {
      // Fallback: 10:00 UTC (= 11:00 local UTC+1, Portugal inverno).
      dataAgendada = new Date(range.start);
      dataAgendada.setUTCHours(10, 0, 0, 0);
    }
  } else {
    // Sem staff atribuído: 10:00 UTC default.
    dataAgendada = new Date(range.start);
    dataAgendada.setUTCHours(10, 0, 0, 0);
  }

  // Tempo de viagem final: prioridade do scheduler (se calculou), senão do LB.
  const tempoViagemFinal =
    tempoViagemScheduler > 0 ? tempoViagemScheduler : tempoViagemMinutos;

  // 7. Snapshot de checklist_dinamica do ModeloChecklist (best-effort).
  let checklistDinamicaWebhook = [];
  if (propriedade.modelo_checklist_id) {
    try {
      const ModeloChecklist = require('../models/ModeloChecklist');
      const modeloChk = await ModeloChecklist.findById(
        propriedade.modelo_checklist_id
      ).lean();
      if (modeloChk && Array.isArray(modeloChk.seccoes)) {
        checklistDinamicaWebhook = modeloChk.seccoes.map((sec) => ({
          nome: sec.nome,
          items: (sec.items || []).map((item) => ({
            texto: typeof item === 'string' ? item : String(item),
            concluido: false,
          })),
        }));
      }
    } catch (chkErr) {
      console.error(
        '⚠️  [Smoobu] falha ao snapshot checklist_dinamica (continua sem):',
        chkErr.message
      );
    }
  }

  // 8. Estado inicial (HF11 — sistema híbrido, 3 possibilidades).
  //    'atribuida' se alguém foi atribuído (staff exclusivo ou LB).
  //    'nao_atribuida' se o LB tentou mas não encontrou ninguém (SLA excedido).
  //    'por_atribuir' se o LB não chegou a tentar (erro interno) ou se
  //    não havia staff exclusivo nem LB (caso raro).
  const estadoInicial = utilizadorAtribuido
    ? 'atribuida'
    : tentouLoadBalancer
    ? 'nao_atribuida' // LB tentou mas não encontrou ninguém.
    : 'por_atribuir'; // erro no LB (não chegou a tentar).

  // HF24 — Motivo de não atribuição (para o gestor saber porquê).
  let motivoNaoAtribuicao = null;
  if (!utilizadorAtribuido) {
    if (staffExclusivoId && !tentouLoadBalancer) {
      // Staff exclusivo estava de folga/inativo e não chegou ao LB.
      motivoNaoAtribuicao = alertaTarefa || 'Equipa exclusiva indisponível';
    } else if (tentouLoadBalancer) {
      // LB tentou mas não encontrou ninguém.
      motivoNaoAtribuicao = 'Nenhum elemento da equipa disponível (todos ocupados, de folga ou de férias)';
    } else {
      motivoNaoAtribuicao = 'Erro no load balancer — atribuição não tentada';
    }
  }

  // Estado e motivo REAIS (mesmo diagnóstico dos outros caminhos): lotação ->
  // 'nao_atribuida'; sem equipa / ausência / folga -> 'por_atribuir'.
  let estadoFinal = estadoInicial;
  if (!utilizadorAtribuido && tentouLoadBalancer) {
    const diag = await diagnosticarFaltaDeStaff(empresaId, range, propriedade._id, null, Number(tempoLimpeza) || 45);
    estadoFinal = diag.estado;
    motivoNaoAtribuicao = motivoSemHorario || diag.motivo;
  }

  if (alertaCancelamentoPrevio) {
    alertaTarefa = alertaTarefa
      ? `${alertaCancelamentoPrevio} | ${alertaTarefa}`
      : alertaCancelamentoPrevio;
  }

  // 9. Cria a Tarefa (com alerta se aplicável).
  // HF21 — Se houver equipa atribuída (múltiplos staff), preenche equipa_atribuida.
  // Guarda a equipa COMPLETA (antes só o 1.º elemento; os restantes nunca viam a tarefa).
  const equipaIds = equipaCompleta.length > 0
    ? equipaCompleta
    : utilizadorAtribuido ? [utilizadorAtribuido] : [];

  let novaTarefa;
  try {
  novaTarefa = await Tarefa.create({
    empresa_id: empresaId,
    propriedade_id: propriedade._id,
    smoobu_reserva_id: reservaId || undefined,
    utilizador_id: utilizadorAtribuido,
    equipa_atribuida: equipaIds.length > 0 ? equipaIds : undefined, // HF21
    data: dataAgendada,
    tempo_limpeza_minutos: Number(tempoLimpeza) || 45,
    tempo_viagem_minutos: tempoViagemFinal, // HF11: LB + scheduler restaurados.
    tipo: 'limpeza',
    estado: estadoFinal,
    pessoas_em_falta: pessoasEmFalta,
    alerta: alertaTarefa, // HF11: alerta se LB não encontrou substituto.
    motivo_nao_atribuicao: motivoNaoAtribuicao, // HF24: motivo detalhado
    checklist: propriedade.checklist || [],
    ...(checklistDinamicaWebhook.length > 0
      ? { checklist_dinamica: checklistDinamicaWebhook }
      : {}),
    detalhes_reserva: detalhesReserva || undefined,
    hospedes: numHospedes, // HF23 — número de hóspedes para lavandaria
  });
  } catch (errCriar) {
    // Corrida (webhook + reconciliação): o índice único (reserva, empresa) já tem a tarefa.
    if (reservaId && ehDuplicadoReserva(errCriar)) {
      const jaCriada = await Tarefa.findOne({ smoobu_reserva_id: reservaId, empresa_id: empresaId });
      if (jaCriada) {
        console.log(`ℹ️  [Smoobu] tarefa da reserva ${reservaId} já criada em paralelo — reutilizada.`);
        return jaCriada;
      }
    }
    throw errCriar;
  }

  await guardarContactoHospede(novaTarefa, contacto);

  // Só aqui (tarefa criada agora; reenvios e corridas devolvem antes): avisa o gestor.
  if (['por_atribuir', 'nao_atribuida'].includes(novaTarefa.estado)) {
    await avisarPorAtribuirSmoobu(empresaId, { nome: propriedade.nome, dia: dataAgendada, motivo: novaTarefa.motivo_nao_atribuicao }, opcoes);
  }
  // Sem ninguém disponível (ou equipa incompleta): oferece a vaga a toda a equipa não ausente.
  if (['por_atribuir', 'nao_atribuida'].includes(novaTarefa.estado) || (Number(novaTarefa.pessoas_em_falta) || 0) > 0) {
    await require('../utils/ofertaVaga').abrirOfertaMelhorEsforco(novaTarefa._id);
  }

  console.log(
    `🧹 [Smoobu] tarefa ${novaTarefa._id} criada (reserva ${reservaId}, ` +
      `propriedade "${propriedade.nome}", estado ${estadoInicial}` +
      (utilizadorAtribuido ? `, staff ${utilizadorAtribuido}` : '') +
      (alertaTarefa ? `, alerta="${alertaTarefa}"` : '') + ').'
  );

  // 10. Notifica o staff atribuído (fire-and-forget).
  if (utilizadorAtribuido) {
    try {
      const { notificarUtilizador } = require('../utils/notificar');
      const propNome = propriedade?.nome ?? 'Propriedade';
      notificarUtilizador(
        String(utilizadorAtribuido),
        '🧹 Nova Limpeza Atribuída',
        `Foste escalado para limpar a ${propNome}.`,
        '/staff',
        { tipo: 'tarefa_atribuida', empresa_id: String(empresaId) }
      );
    } catch (notifErr) {
      console.error(
        '⚠️  [Smoobu] falha ao notificar staff (não bloqueia):',
        notifErr.message
      );
    }
  }

  return novaTarefa;
}

/**
 * Cancela a(s) tarefa(s) associada(s) a uma reserva Smoobu.
 * Soft delete: marca estado='cancelada', liberta staff, mantém histórico.
 *
 * Idempotente: se já está cancelada, skip.
 *
 * @param {string} reservaId
 * @returns {Promise<{canceladas: number, total: number}|null>}
 */
async function cancelarTarefaPorReserva(reservaId, empresaRestrita = null) {
  if (!reservaId) return null;

  const tarefas = await Tarefa.find({
    smoobu_reserva_id: reservaId,
    ...(empresaRestrita ? { empresa_id: empresaRestrita } : {}),
  });
  if (tarefas.length === 0) return null;

  let canceladas = 0;
  let emCurso = 0;
  for (const tarefa of tarefas) {
    if (tarefa.estado === 'cancelada') continue; // idempotente
    if (tarefa.estado === 'concluida') continue; // histórico: limpeza já feita
    if (tarefa.estado === 'em_curso' && !inicioAutomaticoSemToque(tarefa)) {
      // A pessoa já está a limpar: não se cancela por baixo dela nem se lhe tira a casa.
      // Fica em curso e o gestor é avisado (decide se a pessoa termina).
      emCurso++;
      const aviso = 'Reserva cancelada no Smoobu com a limpeza já em curso: a limpeza não foi cancelada.';
      if (!String(tarefa.alerta || '').includes(aviso)) {
        tarefa.alerta = [tarefa.alerta, aviso].filter(Boolean).join(' | ');
        await tarefa.save();
        try {
          const prop = await Propriedade.findById(tarefa.propriedade_id).select('nome').lean();
          await avisarGestores(tarefa.empresa_id, '⚠️ Reserva cancelada com limpeza em curso', `${(prop && prop.nome) || 'Casa'}: ${aviso}`, '/gestor/tarefas', { chave: `smoobu_cancel_em_curso:${tarefa._id}` });
        } catch (e) { /* best-effort */ }
      }
      continue;
    }
    tarefa.estado = 'cancelada';
    tarefa.utilizador_id = null; // liberta o staff
    tarefa.equipa_atribuida = [];
    await tarefa.save();
    canceladas++;
  }

  console.log(
    `🚫 [Smoobu] ${canceladas}/${tarefas.length} tarefa(s) cancelada(s) para reserva ${reservaId}.`
  );
  return { canceladas, total: tarefas.length, em_curso_mantidas: emCurso };
}

/**
 * Atualiza uma tarefa existente quando o Smoobu envia um update de reserva.
 * Revalida disponibilidade do staff no novo dia (sem shuffle completo do
 * load balancer — mantém o staff atual se ainda for válido).
 *
 * Tarefas concluídas são intocáveis (trabalho já feito).
 * Reativa tarefas canceladas se a reserva foi re-ativada no Smoobu.
 *
 * @returns {Promise<Tarefa|null>} a tarefa atualizada, ou null se não existe
 *   (caller deve cair para criarTarefaPorReserva).
 */
async function atualizarTarefaPorReserva(
  reservaId,
  smoobuPropId,
  dataTarefaRaw,
  detalhesReserva,
  content,
  empresaRestrita = null,
  contacto = null,
  opcoes = {}
) {
  if (!reservaId) return null;

  const tarefa = await Tarefa.findOne({
    smoobu_reserva_id: reservaId,
    ...(empresaRestrita ? { empresa_id: empresaRestrita } : {}),
  });
  if (!tarefa) return null; // caller cai para criarTarefaPorReserva

  // Tarefas concluídas são intocáveis.
  if (tarefa.estado === 'concluida') return tarefa;
  const jaEstavaPorAtribuir = ['por_atribuir', 'nao_atribuida'].includes(tarefa.estado);

  let mudou = false;
  let mudouData = false;
  let novoRange = null;

  // 1. Atualizar data.
  if (dataTarefaRaw) {
    novoRange = obterRangeDia(dataTarefaRaw);
    const diaAtual = obterRangeDia(tarefa.data);
    if (inicioAutomaticoSemToque(tarefa) && novoRange && diaAtual && diaAtual.start.getTime() !== novoRange.start.getTime()) {
      // Início automático que ninguém tocou: conta como não iniciada. Limpa o início e segue
      // como uma atribuída (o job volta a poder iniciá-la na data nova).
      tarefa.estado = 'atribuida';
      tarefa.iniciada_em = null;
      tarefa.inicio_origem = null;
      tarefa.iniciada_por = null;
      mudou = true;
    }
    if (tarefa.estado === 'em_curso' && novoRange && diaAtual && diaAtual.start.getTime() !== novoRange.start.getTime()) {
      // Limpeza em curso: a data não muda por baixo da pessoa. O gestor é avisado.
      const aviso = `A reserva mudou de data no Smoobu (${novoRange.start.toISOString().slice(0, 10)}) com a limpeza em curso: a data não foi alterada.`;
      if (!String(tarefa.alerta || '').includes(aviso)) {
        tarefa.alerta = [tarefa.alerta, aviso].filter(Boolean).join(' | ');
        mudou = true;
        try {
          const prop = await Propriedade.findById(tarefa.propriedade_id).select('nome').lean();
          await avisarGestores(tarefa.empresa_id, '⚠️ Data alterada com limpeza em curso', `${(prop && prop.nome) || 'Casa'}: ${aviso}`, '/gestor/tarefas', { chave: `smoobu_data_em_curso:${tarefa._id}:${novoRange.start.toISOString().slice(0, 10)}` });
        } catch (e) { /* best-effort */ }
      }
      novoRange = null;
    } else if (novoRange && diaAtual && diaAtual.start.getTime() !== novoRange.start.getTime()) {
      // Só muda se o DIA mudou (antes qualquer update repunha a hora a 00:00).
      // Mantém a hora 10:00 UTC por defeito; o load balancer/scheduler recalcula se houver reatribuição.
      const novaData = new Date(novoRange.start);
      novaData.setUTCHours(10, 0, 0, 0);
      tarefa.data = novaData;
      mudou = true;
      mudouData = true;
    }
  }

  // 2. Atualizar propriedade (se apartamento trocado).
  if (smoobuPropId) {
    const propriedade = await Propriedade.findOne({
      smoobu_id: smoobuPropId,
      ...(empresaRestrita ? { empresa_id: empresaRestrita } : {}),
    });
    if (propriedade) {
      if (String(tarefa.propriedade_id) !== String(propriedade._id)) {
        tarefa.propriedade_id = propriedade._id;
        tarefa.empresa_id = propriedade.empresa_id;
        mudou = true;
      }
      // Atualiza tempo de limpeza.
      const tempoLimpeza =
        content.tempo_limpeza_minutos ??
        content.cleaning_minutes ??
        propriedade.tempo_limpeza_minutos ??
        45;
      const novoTempo = Number(tempoLimpeza) || 45;
      if (tarefa.tempo_limpeza_minutos !== novoTempo) {
        tarefa.tempo_limpeza_minutos = novoTempo;
        mudou = true;
      }
    }
  }

  // 3. Re-ativar se estava cancelada (reserva foi re-ativada no Smoobu).
  let reativada = false;
  if (tarefa.estado === 'cancelada') {
    tarefa.estado = tarefa.utilizador_id ? 'atribuida' : 'por_atribuir';
    mudou = true;
    reativada = true;
  }

  // 3a. Número de hóspedes acompanha o pax da reserva (pax vazio/0 mantém o valor atual).
  const paxNovo = Number(detalhesReserva?.pax);
  if (Number.isFinite(paxNovo) && paxNovo > 0 && tarefa.hospedes !== paxNovo) {
    tarefa.hospedes = paxNovo;
    mudou = true;
  }

  // 3b. Atualiza detalhes_reserva.
  if (detalhesReserva) {
    // Junta aos dados já guardados (um update sem notas não apaga as notas).
    tarefa.detalhes_reserva = {
      ...(tarefa.detalhes_reserva?.toObject?.() ?? {}),
      ...apenasDefinidos(detalhesReserva),
    };
    mudou = true;
  }

  // 4. Se a data mudou, revalida TODOS os membros da equipa (não só o responsável).
  //    Quem não puder sai da equipa (o responsável passa ao seguinte); depois
  //    procura-se substituto para as vagas.
  let saiuAlguem = false;
  if (mudouData && novoRange) {
    const diaSemana = novoRange.start.getDay();
    for (const idM of idsEquipaTarefa(tarefa)) {
      const utilizador = await Utilizador.findById(idM).lean();
      let disponivel = !!(utilizador && utilizador.ativo && !utilizador.eliminado_em);

      // Folgas fixas semanais.
      if (disponivel && Array.isArray(utilizador.dias_folga) && utilizador.dias_folga.includes(diaSemana)) {
        disponivel = false;
      }
      // Ausências aprovadas.
      if (disponivel) {
        const ausente = await Ausencia.exists({
          utilizador_id: idM,
          estado: 'aprovada',
          data_inicio: { $lte: novoRange.start },
          data_fim: { $gte: novoRange.start },
        });
        if (ausente) disponivel = false;
      }
      if (!disponivel) {
        retirarMembroTarefa(tarefa, idM);
        saiuAlguem = true;
      }
    }
    if (saiuAlguem && !tarefa.utilizador_id && (tarefa.estado === 'atribuida' || tarefa.estado === 'em_curso')) {
      tarefa.estado = 'por_atribuir';
    }
  }

  // 5. Dia novo, quem ficou: recalcula a hora pelo mesmo cálculo de todos os caminhos
  //    (nunca fica a hora do dia antigo nem a meia-noite). Se não couber no horário,
  //    liberta a tarefa para o motor procurar outra pessoa (a seguir) ou ficar por atribuir.
  if (mudouData && novoRange && tarefa.estado === 'atribuida' && idsEquipaTarefa(tarefa).length > 0) {
    try {
      const propHora = await Propriedade.findById(tarefa.propriedade_id).select('coordenadas').lean();
      const rh = await calcularInicioEquipa(
        idsEquipaTarefa(tarefa), novoRange.start, propHora && propHora.coordenadas,
        tarefa.tempo_limpeza_minutos || 45, tarefa._id, tarefa.propriedade_id
      );
      if (rh.cabe) {
        tarefa.data = rh.data;
        tarefa.tempo_viagem_minutos = Number(rh.tempoViagem) || 0;
      } else {
        tarefa.utilizador_id = null;
        tarefa.equipa_atribuida = [];
        tarefa.pessoas_em_falta = 0;
        tarefa.estado = 'por_atribuir';
        tarefa.motivo_nao_atribuicao = rh.motivo;
      }
    } catch (errHora) {
      console.warn('⚠️ [Smoobu sync] hora do dia novo não calculada (mantém 10:00 UTC):', errHora.message);
    }
  }

  if (mudou) {
    await tarefa.save();
    await guardarContactoHospede(tarefa, contacto);
    console.log(
      `📝 [Smoobu] tarefa ${tarefa._id} atualizada (reserva ${reservaId}).`
    );

    // Equipa que ficou incompleta ao mudar a data: procura substituto só para a vaga.
    if (saiuAlguem && tarefa.utilizador_id && (Number(tarefa.pessoas_em_falta) || 0) > 0) {
      try {
        const propVaga = await Propriedade.findById(tarefa.propriedade_id)
          .select('nome coordenadas staff_necessario')
          .lean();
        if (propVaga) {
          await preencherVagaTarefa({ empresaId: tarefa.empresa_id, tarefa: tarefa.toObject(), propriedade: propVaga });
        }
      } catch (errVaga) {
        console.error('⚠️ [Smoobu sync] Erro a procurar substituto após update de data:', errVaga.message);
      }
    }

    // FIX (sync smoobu — reatribuição automática) — Se a data mudou e a
    // tarefa ficou 'por_atribuir' (staff desatribuído por indisponibilidade
    // na nova data), tenta reatribuir automaticamente via load balancer.
    if ((mudouData || reativada) && tarefa.estado === 'por_atribuir') {
      try {
        const propriedade = await Propriedade.findById(tarefa.propriedade_id)
          .select('nome coordenadas empresa_id staff_necessario')
          .lean();
        if (propriedade && novoRange) {
          // Motor partilhado: respeita staff_necessario e dá o motivo real.
          const plano = await planearAtribuicao({
            empresaId: propriedade.empresa_id,
            propriedade: { ...propriedade, _id: tarefa.propriedade_id },
            dia: novoRange.start,
            tempoLimpeza: tarefa.tempo_limpeza_minutos || 45,
          });
          if (plano.estado === 'atribuida') {
            await Tarefa.updateOne(
              { _id: tarefa._id },
              {
                $set: {
                  utilizador_id: plano.utilizador_id,
                  equipa_atribuida: plano.equipa_atribuida,
                  estado: 'atribuida',
                  data: plano.data,
                  tempo_viagem_minutos: plano.tempo_viagem_minutos || 0,
                  motivo_nao_atribuicao: null,
                  pessoas_em_falta: plano.faltam,
                },
              }
            );
            console.log(
              `🤖 [Smoobu sync] tarefa ${tarefa._id} reatribuída (${plano.equipa_atribuida.length} pessoa(s)) após update de data.`
            );
          } else {
            await Tarefa.updateOne(
              { _id: tarefa._id },
              { $set: { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao || 'Sem equipa disponível após update de data (Smoobu)' } }
            );
            // Só avisa na passagem para «por atribuir»; um reenvio sem mudança de data não chega aqui.
            if (!jaEstavaPorAtribuir) {
              await avisarPorAtribuirSmoobu(
                propriedade.empresa_id,
                { nome: propriedade.nome, dia: tarefa.data, motivo: plano.motivo_nao_atribuicao },
                opcoes
              );
            }
          }
        }
      } catch (errReatrib) {
        console.error(
          `⚠️ [Smoobu sync] Erro na reatribuição após update de data:`,
          errReatrib.message
        );
      }
    }
  }
  return tarefa;
}

/**
 * Dispatcher principal: recebe o payload extraído e despacha para a ação
 * correta (criar / atualizar / cancelar).
 *
 * Regra da data: a tarefa é agendada no dia do CHECK-OUT (departure).
 * Se o webhook não trouxer departure (ou nome_hospede), enriquece via
 * REST API do Smoobu. Fallback final: arrival.
 *
 * @param {object} payload - payload bruto do Smoobu.
 * @param {import('mongoose').Types.ObjectId} [empresaId] - para resolver a API key (HF6).
 * @returns {Promise<Tarefa|{canceladas:number,total:number}|null>}
 */
async function processarReservaSmoobu(payload, empresaId, empresaRestrita = null, opcoes = {}) {
  const {
    action,
    smoobuPropId,
    dataCheckInRaw,
    dataCheckOutRaw,
    reservaId,
    tipoReserva,
    detalhesReserva,
    contactoHospede,
    bloqueada,
    content,
  } = extrairDadosReserva(payload);

  // -1. Ações sem impacto nas limpezas (updateRates, newMessage, onlineCheckInUpdate,
  //     priceElement*...). Não têm datas de reserva: ignora logo, em vez de falhar
  //     com "sem datas" e marcar o log como erro.
  const acaoConhecida =
    ACOES_CRIAR.includes(action) ||
    ACOES_ATUALIZAR.includes(action) ||
    ACOES_CANCELAR.includes(action);
  if (!acaoConhecida) {
    console.log(`ℹ️  [Smoobu] ação "${action}" não afeta limpezas — ignorada.`);
    return null;
  }

  // 0. Bloqueio de calendário (is-blocked-booking): não há hóspede e a limpeza
  //    faz-se no check-out da reserva anterior. Ignora, e cancela qualquer
  //    tarefa que já existisse para este id (reserva convertida em bloqueio).
  if (bloqueada) {
    console.log(`ℹ️  [Smoobu] reserva ${reservaId} é um bloqueio de calendário — ignorada.`);
    await cancelarTarefaPorReserva(reservaId, empresaRestrita);
    return null;
  }

  // 1. Cancelamento (ação de cancelamento, ou atualização cujo tipo é 'cancellation').
  if (
    ACOES_CANCELAR.includes(action) ||
    (ACOES_ATUALIZAR.includes(action) && /cancel/i.test(tipoReserva))
  ) {
    return cancelarTarefaPorReserva(reservaId, empresaRestrita);
  }

  // 2. Enriquecimento (se precisa de departure ou nome_hospede).
  let dataCheckOutFinal = dataCheckOutRaw;
  let detalhesFinal = detalhesReserva;
  let contactoFinal = contactoHospede;
  const precisaEnriquecimento =
    reservaId &&
    (ACOES_CRIAR.includes(action) || ACOES_ATUALIZAR.includes(action)) &&
    (!dataCheckOutRaw || !detalhesReserva.nome_hospede);

  if (precisaEnriquecimento) {
    const enriched = await enriquecerReservaSmoobu(reservaId, empresaId);
    if (enriched) {
      dataCheckOutFinal = enriched.departure || dataCheckOutRaw || null;
      detalhesFinal = {
        ...detalhesReserva, // mantém os campos adicionais já vindos do webhook
        checkin: detalhesReserva.checkin || enriched.arrival || null,
        checkout: enriched.departure || detalhesReserva.checkout || null,
        pax: detalhesReserva.pax ?? enriched.pax ?? null,
        nome_hospede:
          detalhesReserva.nome_hospede || enriched.nome_hospede || null,
      };
      // Completa os campos adicionais (horas, notas, adultos/crianças...) que o
      // webhook não trouxe, com os da REST API.
      detalhesFinal = preencherVazios(detalhesFinal, enriched.detalhes);
      contactoFinal = preencherVazios(contactoFinal, enriched.contacto);
      if (enriched.bloqueada) {
        console.log(`ℹ️  [Smoobu] reserva ${reservaId} é um bloqueio de calendário — ignorada.`);
        await cancelarTarefaPorReserva(reservaId, empresaRestrita);
        return null;
      }
    }
  }

  // 3. Data da tarefa = departure (check-out) || arrival (check-in).
  const dataTarefaRaw = dataCheckOutFinal || dataCheckInRaw;
  if (!dataTarefaRaw) {
    throw new Error(
      'Payload do Smoobu sem datas (arrival/departure) — não é possível agendar a tarefa.'
    );
  }

  // 4. Atualização (se ação é update E existe tarefa).
  if (ACOES_ATUALIZAR.includes(action)) {
    const atualizada = await atualizarTarefaPorReserva(
      reservaId,
      smoobuPropId,
      dataTarefaRaw,
      detalhesFinal,
      content,
      empresaRestrita,
      contactoFinal,
      opcoes
    );
    if (atualizada) return atualizada;
    // Sem tarefa existente → cai para criar (reserva pode ter sido criada
    // antes de o webhook estar ativo).
  }

  // 5. Criação (ou default para ação desconhecida que pareça criação).
  if (ACOES_CRIAR.includes(action) || ACOES_ATUALIZAR.includes(action)) {
    return criarTarefaPorReserva(
      reservaId,
      smoobuPropId,
      dataTarefaRaw,
      detalhesFinal,
      content,
      empresaRestrita,
      contactoFinal,
      opcoes
    );
  }

  // 6. Ação desconhecida → ignora graciosamente (não é erro).
  console.log(`ℹ️  [Smoobu] ação "${action}" não processada (ignorada).`);
  return null;
}

/**
 * Orquestra o processamento completo de um webhook Smoobu.
 *
 * Esta função é chamada ASSINCRONAMENTE (via setImmediate) depois do
 * webhook já ter respondido 200 ao Smoobu. Atualiza o WebhookLog no fim.
 *
 * @param {object} payload - payload bruto do Smoobu.
 * @param {import('mongoose').Types.ObjectId} webhookLogId - ID do WebhookLog criado na receção.
 * @param {import('mongoose').Types.ObjectId|null} empresaId - empresa resolvida na receção (best-effort).
 */
async function processarWebhookSmoobu(payload, webhookLogId, empresaId, empresaRestrita = null) {
  try {
    const resultado = await processarReservaSmoobu(payload, empresaId, empresaRestrita, {
      logId: webhookLogId,
    });

    // Atualiza o WebhookLog para 'processado'.
    try {
      await WebhookLog.findByIdAndUpdate(webhookLogId, {
        status: 'processado',
        empresa_id: empresaId || undefined,
      });
    } catch (logErr) {
      console.error(
        '⚠️  [Smoobu] falha ao marcar WebhookLog como processado:',
        logErr.message
      );
    }

    return resultado;
  } catch (err) {
    console.error('❌ [Smoobu] erro ao processar reserva:', err.message);

    // Atualiza o WebhookLog para 'erro' (mantém para reprocesso manual).
    try {
      await WebhookLog.findByIdAndUpdate(webhookLogId, {
        status: 'erro',
        erro_msg: err.message,
        empresa_id: empresaId || undefined,
      });
    } catch (logErr) {
      console.error(
        '⚠️  [Smoobu] falha ao marcar WebhookLog como erro:',
        logErr.message
      );
    }

    // NÃO re-lança: o webhook já respondeu 200 ao Smoobu. O erro fica
    // registado no WebhookLog para investigação/reprocesso manual.
  }
}

/* ================================================================== */
/* Sincronização / Importação de Propriedades (HF5)                   */
/* ================================================================== */
/*
 * Recuperado do histórico Git (commit pré-F0 681f807) e adaptado ao
 * schema atual. O projeto é single-tenant satélite — usa
 * process.env.SMOOBU_API_KEY diretamente (não recria Empresa.smoobu_api_key).
 *
 * Dois handlers Express (montados em /api/gestor/smoobu/propriedades):
 *   - GET  getPropriedadesSmoobu  → lista apartamentos do Smoobu (dropdown)
 *   - POST importarPropriedades   → upsert em massa (cria novas + atualiza
 *                                   morada/capacidade das existentes)
 */

const { obterCoordenadas } = require('../utils/geocoding');

/**
 * Lê a API key do Smoobu para uma empresa.
 *
 * HF6 — Descentralização: prioridade invertida.
 *   1. Empresa.integracoes.smoobu.api_key (se `ativo: true`) — fonte de
 *      verdade em produção (gestão via /api/gestor/configuracoes/integracoes).
 *   2. process.env.SMOOBU_API_KEY — fallback (retrocompatibilidade / dev /
 *      empresas sem chave configurada na BD).
 *
 * @param {import('mongoose').Types.ObjectId} [empresaId] - ID da empresa (do JWT).
 * @returns {Promise<{ chave: string, origem: 'empresa' | 'env' | null }>}
 *   Devolve `origem` para logging/diagnóstico (de onde veio a chave).
 */
async function obterApiKeySmoobu(empresaId) {
  // 1. Tenta ler da empresa (se integracao ativa e chave preenchida).
  if (empresaId) {
    try {
      const Empresa = require('../models/Empresa');
      const empresa = await Empresa.findById(empresaId)
        .select('integracoes.smoobu')
        .lean();
      const smoobu = empresa?.integracoes?.smoobu;
      if (smoobu?.ativo && smoobu.api_key && smoobu.api_key.trim()) {
        return { chave: smoobu.api_key.trim(), origem: 'empresa' };
      }
    } catch {
      // Se falhar a leitura da empresa, continua para o fallback.
    }
  }
  // 2. Fallback: env var global (retrocompatibilidade / dev).
  const envKey = process.env.SMOOBU_API_KEY;
  if (envKey && envKey.trim()) {
    return { chave: envKey.trim(), origem: 'env' };
  }
  return { chave: null, origem: null };
}

/**
 * Extrai a morada de um apartamento do Smoobu, cobrindo várias estruturas
 * possíveis da resposta do endpoint /api/apartments:
 *   - apt.location.{street, zip, city}  (documentada)
 *   - apt.address (string)
 *   - apt.address.{street, zipcode, city}
 *   - apt.{street, zip, zipcode, city}
 *   - apt.full_address
 * Devolve 'A definir' se não encontrar nada.
 */
function extrairMoradaSmoobu(apt) {
  if (!apt) return 'A definir';

  // 1) apt.location (estrutura documentada do Smoobu).
  if (apt.location) {
    const partes = [apt.location.street, apt.location.zip, apt.location.city]
      .filter(Boolean);
    if (partes.length > 0) return partes.join(', ');
  }

  // 2) apt.address como string.
  if (typeof apt.address === 'string' && apt.address.trim()) {
    return apt.address.trim();
  }

  // 3) apt.address como objeto.
  if (apt.address && typeof apt.address === 'object') {
    const partes = [apt.address.street, apt.address.zipcode, apt.address.city]
      .filter(Boolean);
    if (partes.length > 0) return partes.join(', ');
  }

  // 4) Campos achatados no próprio apt.
  const partesChat = [apt.street, apt.zip, apt.zipcode, apt.city].filter(Boolean);
  if (partesChat.length > 0) return partesChat.join(', ');

  // 5) apt.full_address.
  if (typeof apt.full_address === 'string' && apt.full_address.trim()) {
    return apt.full_address.trim();
  }

  return 'A definir';
}

/**
 * Helper interno: faz fetch ao endpoint /api/apartments do Smoobu e devolve
 * o array de apartamentos (ou lança um erro com mensagem útil).
 *
 * @param {string} apiKey
 * @returns {Promise<Array>} array de apartamentos.
 * @throws {Error} com `.status` (400/502) para o handler devolver.
 */
/**
 * Nº de quartos de um apartamento (GET /api/apartments/{id} -> rooms.bedrooms), para a tipologia.
 * A listagem do Smoobu não o traz. Best-effort: null se falhar.
 */
async function buscarQuartosSmoobu(apiKey, smoobuId) {
  try {
    const r = await fetch(`https://login.smoobu.com/api/apartments/${encodeURIComponent(smoobuId)}`, {
      method: 'GET',
      headers: { 'Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const b = await r.json();
    const n = Number(b?.rooms?.bedrooms ?? b?.bedrooms);
    return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
  } catch {
    return null;
  }
}

async function buscarApartamentosSmoobu(apiKey) {
  let respostaSmoobu;
  try {
    respostaSmoobu = await fetch('https://login.smoobu.com/api/apartments', {
      method: 'GET',
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error('Não foi possível ligar ao Smoobu.');
    e.status = 502;
    e.detalhe = err.message;
    throw e;
  }

  if (!respostaSmoobu.ok) {
    const texto = await respostaSmoobu.text().catch(() => '');
    const e = new Error(`Smoobu devolveu erro ${respostaSmoobu.status}.`);
    e.status = 502;
    e.detalhe = texto.slice(0, 500) || respostaSmoobu.statusText;
    throw e;
  }

  let body;
  try {
    body = await respostaSmoobu.json();
  } catch (err) {
    const e = new Error('Resposta do Smoobu não é JSON válido.');
    e.status = 502;
    e.detalhe = err.message;
    throw e;
  }

  const apartments =
    body?.apartments ??
    body?.data?.apartments ??
    (Array.isArray(body) ? body : []);

  if (!Array.isArray(apartments)) {
    const e = new Error('Resposta do Smoobu não contém array "apartments".');
    e.status = 502;
    e.detalhe = JSON.stringify(body).slice(0, 500);
    throw e;
  }

  return apartments;
}

/**
 * GET /api/gestor/smoobu/propriedades
 *
 * Vai buscar a lista de apartamentos ao Smoobu (REST API /api/apartments) e
 * devolve-a ao frontend de forma limpa (id + name), para alimentar o
 * dropdown no formulário de criação de propriedades.
 *
 * Resposta 200: { propriedadesSmoobu: [{ id, name }, ...] }
 * Erros: 400 (API key em falta) / 502 (Smoobu indisponível) / 500 (interno)
 */
async function getPropriedadesSmoobu(req, res) {
  try {
    const empresaId = req.user && req.user.empresa_id;
    const { chave: apiKey } = await obterApiKeySmoobu(empresaId);
    if (!apiKey) {
      return res.status(400).json({
        erro:
          'API Key do Smoobu não configurada. Define-a em Configurações → Integrações, ou via env var SMOOBU_API_KEY.',
      });
    }

    const apartments = await buscarApartamentosSmoobu(apiKey);

    const propriedadesSmoobu = apartments.map((a) => ({
      id: a.id,
      name: a.name,
    }));

    return res.status(200).json({ propriedadesSmoobu });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        erro: err.message,
        ...(err.detalhe ? { detalhe: err.detalhe } : {}),
      });
    }
    console.error('❌ [Smoobu] getPropriedadesSmoobu: erro interno:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

/**
 * POST /api/gestor/smoobu/propriedades
 *
 * Importa em massa os apartamentos do Smoobu para a coleção Propriedade da
 * empresa do gestor. Comportamento (upsert inteligente, Prompt 92/104):
 *   - Propriedades NOVAS → criadas com smoobu_id, nome, morada, coordenadas
 *     (geocoding Nominatim), capacidade_hospedes e tempo_limpeza_minutos (45).
 *   - Propriedades JÁ EXISTENTES (match por smoobu_id + empresa_id):
 *       • morada só é preenchida se o nosso campo estiver vazio/'A definir'
 *         (a edição manual do gestor tem prioridade — Prompt 104).
 *       • capacidade_hospedes é atualizada SEMPRE (Smoobu é fonte de verdade).
 *       • restantes campos (nome, tempo_limpeza, ativo, checklist,
 *         funcionario_preferencial_id) são preservados.
 *
 * Requer: env var SMOOBU_API_KEY.
 *
 * Resposta 200: { totalRecebidas, criadas, atualizadas, existentes, erros,
 *                 detalheErros, message }
 *   (message é legível para toasts; os contadores são para o painel de propriedades)
 */
async function importarPropriedades(req, res) {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    const { chave: apiKey } = await obterApiKeySmoobu(empresaId);
    if (!apiKey) {
      return res.status(400).json({
        erro:
          'API Key do Smoobu não configurada. Define-a em Configurações → Integrações, ou via env var SMOOBU_API_KEY.',
      });
    }

    const apartments = await buscarApartamentosSmoobu(apiKey);

    let criadas = 0;
    let existentes = 0;
    let atualizadas = 0;
    let erros = 0;
    const detalheErros = [];
    const casasComPessoasNovas = []; // pessoas mudaram pela tipologia: limpezas por começar seguem

    for (const apt of apartments) {
      const smoobuId = apt?.id != null ? String(apt.id) : null;
      try {
        if (!smoobuId) {
          throw new Error('Apartamento sem id.');
        }

        // Extrai capacidade (Smoobu usa rooms.maxOccupancy ou maxOccupancy).
        const capacidade =
          apt.rooms?.maxOccupancy || apt.maxOccupancy || null;

        // Constrói morada usando o helper (cobre várias estruturas).
        const moradaTexto = extrairMoradaSmoobu(apt);

        // Log de debug quando a morada não é preenchida (ajuda a perceber
        // a estrutura do payload Smoobu).
        if (moradaTexto === 'A definir') {
          console.log(
            `⚠️  [importarPropriedades] apt ${smoobuId} ("${apt.name}") sem morada — ` +
              `location=${JSON.stringify(apt.location ?? null)}, ` +
              `address=${JSON.stringify(apt.address ?? null)}, ` +
              `keys=${Object.keys(apt).join(',')}`
          );
        }

        // Verifica se JÁ EXISTE uma propriedade com este smoobu_id QUE
        // PERTENÇA a esta empresa (multi-tenant safe).
        const existente = await Propriedade.findOne({
          smoobu_id: smoobuId,
          empresa_id: empresaId,
        });

        if (existente) {
          // Atualização: morada só se vazia/'A definir'; capacidade sempre.
          let mudou = false;

          // Tipologia (nº de quartos) só enquanto estiver vazia: o gestor pode corrigi-la.
          // As pessoas seguem a regra (particular ou T2+ = 2), salvo valor posto à mão.
          if (existente.tipologia == null) {
            const quartos = await buscarQuartosSmoobu(apiKey, smoobuId);
            if (quartos !== null) {
              const antes = {
                tempo_limpeza_minutos: existente.tempo_limpeza_minutos,
                tempos_limpeza_por_tipo: { ...(existente.toObject().tempos_limpeza_por_tipo || {}) },
                staff_necessario: existente.staff_necessario,
              };
              existente.tipologia = quartos;
              const pessoas = decidirPessoas(existente.toObject(), undefined);
              existente.staff_necessario = pessoas.staff_necessario;
              existente.staff_necessario_manual = pessoas.staff_necessario_manual;
              if (antes.staff_necessario !== pessoas.staff_necessario) casasComPessoasNovas.push({ antes, doc: existente });
              mudou = true;
            }
          }

          if (
            moradaTexto !== 'A definir' &&
            (!existente.morada || existente.morada === 'A definir')
          ) {
            existente.morada = moradaTexto;
            try {
              const coords = await obterCoordenadas(moradaTexto);
              if (coords) existente.coordenadas = coords;
            } catch (e) {
              console.warn(
                '⚠️  [importarPropriedades] geocoding falhou (update morada):',
                e.message
              );
            }
            mudou = true;
          }

          if (capacidade) {
            existente.capacidade_hospedes = capacidade;
            mudou = true;
          }

          if (mudou) {
            await existente.save();
            atualizadas++;
          } else {
            existentes++;
          }
          continue;
        }

        // Nova propriedade: geocoding + create.
        let coords = { lat: null, lng: null };
        if (moradaTexto !== 'A definir') {
          try {
            const result = await obterCoordenadas(moradaTexto);
            if (result) coords = result;
          } catch (e) {
            console.warn(
              '⚠️  [importarPropriedades] geocoding falhou (nova):',
              e.message
            );
          }
        }

        const quartos = await buscarQuartosSmoobu(apiKey, smoobuId);
        await Propriedade.create({
          smoobu_id: smoobuId,
          nome: apt.name || `Propriedade ${smoobuId}`,
          morada: moradaTexto,
          coordenadas: coords,
          empresa_id: empresaId,
          tempo_limpeza_minutos: 45,
          capacidade_hospedes: capacidade,
          tipologia: quartos,
          ...decidirPessoas({ tipologia: quartos, staff_necessario_manual: false }, undefined),
        });
        criadas++;
      } catch (err) {
        erros++;
        detalheErros.push({ smoobuId, erro: err.message });
        console.error(
          `⚠️  [importarPropriedades] apartamento ${smoobuId} falhou:`,
          err.message
        );
        // Continua para o próximo.
      }
    }

    console.log(
      `✅ [Smoobu] importarPropriedades: ${apartments.length} recebidas, ` +
        `${criadas} criadas, ${atualizadas} atualizadas, ` +
        `${existentes} já existiam, ${erros} com erro.`
    );

    // Casas que passaram a precisar de outro nº de pessoas: as limpezas por começar seguem
    // (em segundo plano, nunca bloqueia a resposta).
    if (casasComPessoasNovas.length > 0) {
      const { aplicarConfigCasaNasLimpezas } = require('../utils/configCasaNasLimpezas');
      (async () => {
        for (const c of casasComPessoasNovas) {
          await aplicarConfigCasaNasLimpezas({ empresaId, antes: c.antes, propriedade: c.doc.toObject() });
        }
      })().catch((e) => console.error('⚠️  [importarPropriedades] limpezas por começar:', e.message));
    }

    // message legível para toasts (configuracoes/page.tsx executarAcao);
    // contadores estruturados para o painel de propriedades.
    let message = `${criadas} propriedade(s) importada(s)`;
    if (atualizadas > 0) message += `, ${atualizadas} atualizada(s)`;
    if (existentes > 0) message += `, ${existentes} já existiam`;
    if (erros > 0) message += `, ${erros} com erro`;
    message += '.';

    return res.status(200).json({
      totalRecebidas: apartments.length,
      criadas,
      atualizadas,
      existentes,
      erros,
      detalheErros,
      message,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        erro: err.message,
        ...(err.detalhe ? { detalhe: err.detalhe } : {}),
      });
    }
    console.error('❌ [Smoobu] importarPropriedades: erro interno:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

/* ================================================================== */
/* Sincronização em massa de Reservas (HF7)                           */
/* ================================================================== */
/*
 * Recuperado do histórico Git (commit pré-F0 681f807, 2026-07-15) e
 * adaptado ao HF6 (api_key lida da Empresa via obterApiKeySmoobu).
 *
 * Esta é a função que faltava: o "motor" de backfill que puxa TODAS as
 * reservas futuras do Smoobu (REST API com paginação) e processa cada uma
 * através do mesmo `processarReservaSmoobu` usado pelo webhook. É o que
 * despoleta o botão "Sincronizar Reservas" no painel de Configurações e o
 * cron job `sincronizacaoSmoobu`.
 *
 * Diferenças vs original (681f807):
 *   - `obterApiKeySmoobu(empresaId)` agora devolve `{ chave, origem }` (HF6)
 *     em vez de uma string direta — lê-se `.chave`.
 *   - `processarReservaSmoobu` e `cancelarTarefaPorReserva` estão neste
 *     próprio módulo (em vez de `require('./webhookController')`).
 *   - `processarReservaSmoobu(payload, empresaId)` recebe `empresaId` (HF6)
 *     para resolver a API key da BD ao enriquecer reservas.
 *   - Adicionado `message` legível para toasts (compatibilidade com
 *     `executarAcao` do frontend).
 */

/**
 * POST /api/gestor/smoobu/sincronizar
 *
 * Vai buscar todas as reservas futuras (a partir de hoje) ao Smoobu via
 * REST API (com paginação) e cria as tarefas correspondentes usando a mesma
 * lógica do webhook (`processarReservaSmoobu` — idempotente).
 *
 * Fluxo:
 *   1. Resolve a API key (Empresa.integracoes.smoobu via obterApiKeySmoobu).
 *   2. Calcula a data de hoje (YYYY-MM-DD UTC) para não importar o passado.
 *   3. Fetch a https://login.smoobu.com/api/reservations?arrivalFrom=YYYY-MM-DD&page=N
 *      com paginação (lê todas as páginas).
 *   4. Para cada reserva: mapeia para o formato do webhook, verifica
 *      idempotência (Tarefa.findOne por smoobu_reserva_id), e chama
 *      processarReservaSmoobu (ou cancelarTarefaPorReserva se a reserva
 *      estiver cancelada no Smoobu).
 *   5. Cada reserva é envolvida num try/catch — se uma falhar, as outras
 *      continuam.
 *   6. Devolve contadores: totalRecebidas, importadas, criadas, existentes,
 *      erros, detalheErros + message legível.
 *
 * Resposta 202 (sincronização manual): { message } — o processamento pesado
 *                 corre em background (FIX timeout 502); os contadores finais
 *                 ficam no log do servidor.
 * Resposta 200 (modo reconciliação, chamado pelo job): contadores completos.
 */

/**
 * FIX (timeout 502) — Empresas com sincronização manual em curso.
 * Evita disparar jobs em background em paralelo para a mesma empresa.
 */
const syncEmCurso = new Set();

/**
 * Mapeia um erro do motor de sincronização para a resposta HTTP.
 */
function responderErroSincronizacao(res, err) {
  if (err.status) {
    return res.status(err.status).json({
      erro: err.message,
      ...(err.detalhe ? { detalhe: err.detalhe } : {}),
    });
  }
  console.error('❌ [Smoobu] sincronizarReservas: erro interno:', err.message);
  return res.status(500).json({ erro: 'Erro interno.' });
}

async function sincronizarReservas(req, res) {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    // Modo reconciliação periódica (job): não reativa canceladas, não toca em
    // concluídas/em curso, espaça os pedidos e não recria tarefas de reservas
    // manuais. Corre SÍNCRONO porque o job (jobs/sincronizacaoSmoobu.js)
    // precisa dos contadores na resposta.
    const reconciliacao = Boolean(req.reconciliacao);
    const pausaMs = reconciliacao ? Number(req.pausaMs ?? 400) : 0;

    const { chave: apiKey } = await obterApiKeySmoobu(empresaId);
    if (!apiKey) {
      return res.status(400).json({
        erro:
          'API Key do Smoobu não configurada. Define-a em Configurações → Integrações, ou via env var SMOOBU_API_KEY.',
      });
    }

    if (reconciliacao) {
      // Job periódico: executa o motor de forma síncrona e devolve os contadores.
      try {
        const resultado = await executarSincronizacaoCore(empresaId, apiKey, {
          reconciliacao: true,
          pausaMs,
        });
        return res.status(resultado.status).json(resultado.body);
      } catch (err) {
        return responderErroSincronizacao(res, err);
      }
    }

    // FIX (timeout 502) — Sincronização MANUAL (botão no painel): responde
    // IMEDIATAMENTE 202 e processa tudo em segundo plano. Antes, o endpoint
    // corria a lógica pesada (fetch ao Smoobu + loops + sync de parceiros) de
    // forma síncrona, o que causava 502 Timeout/Bad Gateway com volume elevado.
    if (syncEmCurso.has(String(empresaId))) {
      return res.status(409).json({
        erro: 'Já existe uma sincronização em curso para esta empresa. Aguarda a conclusão.',
      });
    }

    // FIX (timeout 502) — Marca ANTES de responder: evita a corrida entre
    // dois pedidos manuais simultâneos e permite aos testes aguardar a
    // conclusão do background (aguardarSincronizacoes).
    syncEmCurso.add(String(empresaId));

    res.status(202).json({
      message:
        'Sincronização iniciada em segundo plano. As tarefas serão atualizadas nos próximos minutos. Recarrega a página de Limpezas daqui a 1-2 minutos.',
    });

    // Dispara o motor pesado SEM await — corre em background.
    setImmediate(async () => {
      const inicioJob = Date.now();
      try {
        console.log('🔄 [Smoobu] sincronizarReservas (background): iniciada para empresa ' + String(empresaId) + '.');
        const resultado = await executarSincronizacaoCore(empresaId, apiKey, {});
        const b = resultado.body || {};
        const duracaoSeg = ((Date.now() - inicioJob) / 1000).toFixed(1);
        console.log(
          `🏁 [Smoobu] sincronizarReservas (background): CONCLUÍDA em ${duracaoSeg}s — ` +
            `${b.criadas ?? 0} Smoobu criadas, ${b.existentes ?? 0} já existiam, ` +
            `${b.parceirosCriadas ?? 0} de parceiros recriadas, ${b.erros ?? 0} erros.`
        );
      } catch (err) {
        // FIX (timeout 502) — Log detalhado para não morrer silenciosamente.
        console.error('❌ [Smoobu] sincronizarReservas (background): FALHOU a meio:', {
          empresaId: String(empresaId),
          erro: err.message,
          stack: err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : undefined,
          timestamp: new Date().toISOString(),
        });
      } finally {
        syncEmCurso.delete(String(empresaId));
      }
    });
  } catch (err) {
    console.error('❌ [Smoobu] sincronizarReservas: erro interno:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

/**
 * FIX (timeout 502) — Motor pesado da sincronização, extraído de
 * `sincronizarReservas` para poder correr em background (sincronização
 * manual) ou de forma síncrona (job de reconciliação). NÃO escreve na
 * resposta HTTP: devolve `{ status, body }` ou lança um Error com `.status`.
 */
async function executarSincronizacaoCore(empresaId, apiKey, opcoes = {}) {
  // Modo reconciliação periódica (job): não reativa canceladas, não toca em concluídas/em curso,
  // espaça os pedidos e não recria tarefas de reservas manuais. A sincronização manual (sem
  // reconciliação) mantém o comportamento original.
  const reconciliacao = Boolean(opcoes.reconciliacao);
  const pausaMs = reconciliacao ? Number(opcoes.pausaMs ?? 400) : 0;
  const pausar = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

  try {
    // Data de hoje em YYYY-MM-DD (UTC) — não importamos o passado.
    const agora = new Date();
    const from = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    )
      .toISOString()
      .slice(0, 10);

    // Fetch ao Smoobu com paginação.
    // O parâmetro oficial é arrivalFrom (case-sensitive, 'F' maiúsculo).
    // O array vem em body.bookings (oficial) ou body.reservations (variantes).
    let currentPage = 1;
    let totalPages = 1;
    let todasReservas = [];

    try {
      while (currentPage <= totalPages) {
        const url = `https://login.smoobu.com/api/reservations?departureFrom=${from}&page=${currentPage}`;
        const respostaSmoobu = await fetch(url, {
          method: 'GET',
          headers: {
            'Api-Key': apiKey,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!respostaSmoobu.ok) {
          const texto = await respostaSmoobu.text().catch(() => '');
          const e = new Error(
            `Smoobu devolveu erro ${respostaSmoobu.status}: ${
              texto.slice(0, 200) || respostaSmoobu.statusText
            }`
          );
          e.status = 502;
          throw e;
        }

        const body = await respostaSmoobu.json();

        const reservasPagina =
          body?.bookings ??
          body?.reservations ??
          body?.data?.reservations ??
          body?.data?.bookings ??
          (Array.isArray(body) ? body : []);

        todasReservas = todasReservas.concat(reservasPagina);

        // Atualiza o total de páginas (se o Smoobu não enviar page_count, para no 1).
        totalPages = body?.page_count || 1;
        currentPage++;
        if (currentPage <= totalPages) await pausar(pausaMs);
      }
    } catch (err) {
      if (!err.status) {
        console.error('❌ [Smoobu] sincronizarReservas: fetch falhou:', err.message);
        const e = new Error('Não foi possível ligar ao Smoobu.');
        e.status = 502;
        throw e;
      }
      throw err;
    }

    const reservas = todasReservas;
    console.log(`📥 [Smoobu] sincronizarReservas: ${reservas.length} reservas recebidas (departureFrom=${from}).`);

    if (!Array.isArray(reservas)) {
      const e = new Error('Resposta do Smoobu não contém array "bookings" ou "reservations".');
      e.status = 502;
      throw e;
    }

    const porAtribuir = []; // limpezas que ficaram por atribuir: UM aviso agregado no fim
    let criadas = 0;
    let existentes = 0;
    let erros = 0;
    const detalheErros = [];

    for (const reserva of reservas) {
      const reservaId =
        reserva?.id ?? reserva?.reservationId ?? reserva?.reservation_id;

      try {
        // Verifica idempotência ANTES de chamar o processador (otimização:
        // evita refazer o load balancer se a tarefa já existe). O processador
        // também verifica, mas assim poupamos trabalho e conseguimos distinguir
        // "criada" de "já existente" nos contadores.
        let jaExistia = false;
        if (reservaId) {
          const existente = await Tarefa.findOne({
            smoobu_reserva_id: String(reservaId),
            empresa_id: empresaId,
          }).lean();
          if (existente) {
            jaExistia = true;
            // Reconciliação: canceladas (talvez canceladas à mão), concluídas e em curso ficam como estão.
            if (reconciliacao && ['cancelada', 'concluida', 'em_curso'].includes(existente.estado)) {
              existentes++;
              continue;
            }
          }
        }
        await pausar(pausaMs);

        // Mapeia a reserva do formato REST API para o formato do webhook.
        // O processador espera: { action, data: { id, arrival, departure,
        // apartment: { id, name }, guests, guestName, ... } }
        //
        // Cobertura exaustiva do nome do hóspede no formato REST API do
        // Smoobu: guestName, guest_name, guest-name (kebab), guest.name,
        // guest.firstName + guest.lastName, firstName + lastName,
        // customerName, customer.name, bookedForName, name.
        const hospedeNomeSmoobu =
          reserva.guestName ??
          reserva.guest_name ??
          reserva['guest-name'] ??
          reserva.guest?.name ??
          (reserva.guest?.firstName || reserva.guest?.lastName
            ? [reserva.guest?.firstName, reserva.guest?.lastName]
                .filter(Boolean)
                .join(' ')
            : null) ??
          (reserva.firstName || reserva.lastName
            ? [reserva.firstName, reserva.lastName].filter(Boolean).join(' ')
            : null) ??
          reserva.customerName ??
          reserva.customer?.name ??
          reserva.bookedForName ??
          reserva.name ??
          null;

        // Reserva já conhecida → 'updateReservation' (atualiza data/apartamento); antes só criava.
        const payloadWebhook = {
          action: jaExistia ? 'updateReservation' : 'newReservation',
          data: {
            // Reserva completa da REST API (horas, adultos/crianças, notas, contacto,
            // is-blocked-booking...); os campos abaixo normalizam os que variam de nome.
            ...reserva,
            id: reserva.id,
            arrival: reserva.arrival ?? reserva.start_date ?? reserva.startDate,
            departure: reserva.departure ?? reserva.end_date ?? reserva.endDate,
            apartment: {
              id:
                reserva.apartment?.id ??
                reserva.apartment_id ??
                reserva.apartmentId,
              name: reserva.apartment?.name ?? reserva.apartment_name,
            },
            // Campos extras para detalhes_reserva.
            guests:
              reserva.guests ?? reserva.numPeople ?? reserva.numberOfGuests ?? undefined,
            adults: reserva.adults,
            children: reserva.children,
            guestName: hospedeNomeSmoobu ?? undefined,
            firstName: reserva.firstName ?? reserva.first_name ?? undefined,
            lastName: reserva.lastName ?? reserva.last_name ?? undefined,
          },
        };

        // Se a reserva estiver cancelada no Smoobu (status = 'cancelled' ou
        // variante), dispara o gatilho de cancelamento em vez de criar uma
        // tarefa fantasma.
        const statusReserva = String(
          reserva.status ?? reserva.bookingStatus ?? ''
        ).toLowerCase();
        if (['cancelled', 'canceled', 'cancelada'].includes(statusReserva)) {
          await cancelarTarefaPorReserva(reservaId);
          // Conta como "existente" (não cria nova, não conta como erro).
          existentes++;
          continue;
        }

        const resultado = await processarReservaSmoobu(payloadWebhook, empresaId, empresaId, { porAtribuir });

        if (jaExistia) {
          existentes++;
        } else if (resultado) {
          criadas++;
        }
        // resultado null = action ignorada ou reserva sem tarefa (não conta)
      } catch (err) {
        erros++;
        detalheErros.push({
          reservaId: reservaId != null ? String(reservaId) : null,
          erro: err.message,
        });
        console.error(
          `⚠️  [Smoobu] sincronizarReservas: reserva ${reservaId} falhou:`,
          err.message
        );
        // Continua para a próxima reserva.
      }
    }

    if (porAtribuir.length > 0) await enviarAvisoPorAtribuir(empresaId, porAtribuir);

    console.log(
      `✅ [Smoobu] sincronizarReservas: ${reservas.length} recebidas, ${criadas} criadas, ` +
        `${existentes} já existiam, ${erros} com erro.`
    );

    // FIX (sync integral parceiros) — Após sincronizar o Smoobu, percorre as
    // reservas manuais (ReservaManual criadas por parceiros) cuja tarefa
    // gerada NÃO EXISTE (útil após "Eliminar Futuras") e recria a Tarefa de
    // limpeza para o check-out. Isto garante que reservas de parceiros não
    // ficam órfãs quando o gestor faz reset da agenda.
    let parceirosCriadas = 0;
    let parceirosSkipped = 0;
    try {
      // Reconciliação não recria tarefas de reservas manuais (o gestor pode tê-las apagado).
      const reservasManuaisAlvo = reconciliacao ? [] : null;
      const ReservaManual = require('../models/ReservaManual');
      const {
        tipoDe: tipoDeLimpeza, tempoDoTipo, checklistDoTipo, temChecklistPropria, resolverDiaLimpeza,
      } = require('../utils/tipoLimpeza');
      const hoje = new Date();
      hoje.setUTCHours(0, 0, 0, 0);
      // Busca reservas manuais futuras (check_out >= hoje) sem tarefa gerada
      // OU cuja tarefa foi cancelada/apagada (tarefa_gerada_id null ou inexistente).
      const reservasManuais =
        reservasManuaisAlvo ||
        (await ReservaManual.find({
          empresa_id: empresaId,
          check_out: { $gte: hoje },
        }).lean());

      // Reservas que partilham a mesma limpeza (mesma casa, dia e tipo) recriam UMA só.
      const recriadas = new Map();
      for (const rm of reservasManuais) {
        // Verifica se a tarefa gerada ainda existe.
        let tarefaExiste = false;
        if (rm.tarefa_gerada_id) {
          tarefaExiste = await Tarefa.exists({ _id: rm.tarefa_gerada_id });
        }
        if (tarefaExiste) {
          parceirosSkipped++;
          continue;
        }

        // Recria a tarefa de limpeza para o check-out.
        const propriedadeRM = await Propriedade.findById(rm.propriedade_id).lean();
        if (!propriedadeRM) {
          parceirosSkipped++;
          continue;
        }

        // Tipo de limpeza da reserva (sem o campo = normal): dia, tempo e checklist do tipo.
        // Não reutiliza gerarTarefaLimpezaReserva porque esta recriação NÃO atribui (fica
        // por atribuir para o gestor, como sempre foi).
        const tipoRM = tipoDeLimpeza(rm);
        const rdRM = resolverDiaLimpeza({
          tipo: tipoRM, check_in: rm.check_in, check_out: rm.check_out, data_gravada: rm.data_limpeza, ajustada: !!rm.data_limpeza_ajustada,
        });
        const diaRM = rdRM.erro ? new Date(rm.check_out).toISOString().slice(0, 10) : rdRM.dia;
        const dataTarefaRM = new Date(`${diaRM}T10:00:00Z`);
        const chaveRM = `${rm.propriedade_id}|${diaRM}|${tipoRM}`;
        if (recriadas.has(chaveRM)) {
          await ReservaManual.updateOne({ _id: rm._id }, { $set: { tarefa_gerada_id: recriadas.get(chaveRM) } });
          continue;
        }

        const numHospedesRM = rm.hospedes || propriedadeRM.capacidade_hospedes || null;

        const novaTarefaRM = await Tarefa.create({
          empresa_id: empresaId,
          propriedade_id: rm.propriedade_id,
          smoobu_reserva_id: null,
          origem: 'manual',
          utilizador_id: null,
          equipa_atribuida: [],
          data: dataTarefaRM,
          tempo_limpeza_minutos: tempoDoTipo(propriedadeRM, tipoRM),
          tipo: 'limpeza',
          tipo_limpeza: tipoRM,
          estado: 'por_atribuir',
          observacoes: rm.observacoes || '',
          hospedes: numHospedesRM,
          origem_parceiro: true, // FIX (sync parceiros) — marca como origem parceiro
          checklist: checklistDoTipo(propriedadeRM, tipoRM),
          checklist_do_tipo: temChecklistPropria(propriedadeRM, tipoRM),
          detalhes_reserva: {
            checkin: rm.check_in ? new Date(rm.check_in).toISOString().slice(0, 10) : null,
            checkout: new Date(rm.check_out).toISOString().slice(0, 10),
            pax: numHospedesRM,
          },
        });

        recriadas.set(chaveRM, novaTarefaRM._id);
        // Associa a nova tarefa à reserva manual.
        await ReservaManual.updateOne(
          { _id: rm._id },
          { $set: { tarefa_gerada_id: novaTarefaRM._id } }
        );
        parceirosCriadas++;
      }

      if (parceirosCriadas > 0 || parceirosSkipped > 0) {
        console.log(
          `🤝 [Parceiros] sync integral: ${parceirosCriadas} tarefa(s) recriada(s) de reservas manuais, ` +
          `${parceirosSkipped} já tinham tarefa.`
        );
      }
    } catch (errParceiros) {
      console.warn(
        '⚠️  [Parceiros] sync integral falhou (não bloqueia o Smoobu):',
        errParceiros.message
      );
    }

    // Atualiza ultima_sincronizacao da empresa (HF6).
    try {
      const Empresa = require('../models/Empresa');
      await Empresa.findByIdAndUpdate(empresaId, {
        $set: { 'integracoes.smoobu.ultima_sincronizacao': new Date() },
      });
    } catch (updErr) {
      console.warn(
        '⚠️  [Smoobu] sincronizarReservas: falha ao atualizar ultima_sincronizacao (não bloqueia):',
        updErr.message
      );
    }

    // message legível para toasts (executarAcao do configuracoes/page.tsx)
    // e para o log da sincronização em background.
    let message = `${criadas} tarefa(s) Smoobu criada(s)`;
    if (existentes > 0) message += `, ${existentes} já existiam`;
    if (erros > 0) message += `, ${erros} com erro`;
    if (parceirosCriadas > 0) message += ` · ${parceirosCriadas} de reservas de proprietários recriada(s)`;
    message += ` (de ${reservas.length} reservas).`;

    return {
      status: 200,
      body: {
        totalRecebidas: reservas.length,
        importadas: criadas + existentes,
        criadas,
        existentes,
        erros,
        detalheErros,
        parceirosCriadas,
        parceirosSkipped,
        message,
      },
    };
  } catch (err) {
    console.error('❌ [Smoobu] sincronizarReservas: erro interno:', err.message);
    throw err;
  }
}

/**
 * FIX (timeout 502) — Utilitário para os TESTES: aguarda a conclusão de
 * todas as sincronizações manuais em background (polling do `syncEmCurso`,
 * com timeout de segurança). Não é usado em produção.
 */
async function aguardarSincronizacoes({ timeoutMs = 15000 } = {}) {
  const inicio = Date.now();
  while (syncEmCurso.size > 0) {
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('Timeout a aguardar sincronizações em background.');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * POST /api/gestor/smoobu/reconciliar-cancelamentos   (EXCLUSIVO do admin)
 *
 * Procura limpezas ainda ativas cuja reserva já foi cancelada (ou passou a bloqueio
 * de calendário) no Smoobu, mas cujo webhook foi ignorado (ex.: cancelReservation
 * antes da correção). Compara com o ÚLTIMO webhook recebido de cada reserva.
 *
 * Body: { aplicar?: boolean }   (por defeito só lista — "dry-run")
 * Só cancela limpezas por fazer; as "em_curso" ficam para revisão manual e as
 * "concluida" nunca são alteradas.
 *
 * Resposta 200: { aplicado, total, canceladas, candidatas: [...], revisao_manual: [...] }
 */
async function reconciliarCancelamentos(req, res) {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const aplicar = Boolean(req.body && req.body.aplicar === true);

    // 1. Limpezas ativas de reservas do Smoobu.
    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      smoobu_reserva_id: { $nin: [null, ''] },
      estado: { $nin: ['cancelada', 'concluida'] },
    })
      .select('smoobu_reserva_id estado data propriedade_id')
      .populate({ path: 'propriedade_id', select: 'nome' })
      .lean();

    if (tarefas.length === 0) {
      return res.status(200).json({ aplicado: aplicar, total: 0, canceladas: 0, candidatas: [], revisao_manual: [] });
    }

    // 2. Último webhook de cada reserva (o id vem como número ou texto no payload).
    const ids = [...new Set(tarefas.map((t) => String(t.smoobu_reserva_id)))];
    const idsMistos = [...ids, ...ids.filter((i) => /^\d+$/.test(i)).map(Number)];
    const logs = await WebhookLog.find({
      'payload.data.id': { $in: idsMistos },
      'payload.action': { $in: [...ACOES_CRIAR, ...ACOES_ATUALIZAR, ...ACOES_CANCELAR] },
    })
      .select('payload.action payload.data.id payload.data.type payload.data.is-blocked-booking createdAt')
      .sort({ createdAt: -1 })
      .limit(50000)
      .lean();

    const ultimo = new Map();
    for (const log of logs) {
      const k = String(log.payload.data.id);
      if (!ultimo.has(k)) ultimo.set(k, log);
    }

    const motivoDoLog = (log) => {
      const acao = log.payload.action;
      const data = log.payload.data || {};
      if (ACOES_CANCELAR.includes(acao)) return 'Cancelada no Smoobu';
      if (ACOES_ATUALIZAR.includes(acao) && /cancel/i.test(String(data.type || ''))) return 'Cancelada no Smoobu';
      const bloq = data['is-blocked-booking'];
      if (bloq === true || bloq === 'true' || bloq === 1 || bloq === '1') return 'Convertida em bloqueio de calendário';
      return null;
    };

    // 3. Candidatas = limpezas ativas cujo último webhook é cancelamento/bloqueio.
    const candidatas = [];
    for (const t of tarefas) {
      const log = ultimo.get(String(t.smoobu_reserva_id));
      const motivo = log ? motivoDoLog(log) : null;
      if (!motivo) continue;
      candidatas.push({
        tarefa_id: String(t._id),
        reserva_id: String(t.smoobu_reserva_id),
        propriedade: (t.propriedade_id && t.propriedade_id.nome) || '—',
        data: t.data,
        estado: t.estado,
        motivo,
        recebido_em: log.createdAt,
      });
    }

    const revisaoManual = candidatas.filter((c) => c.estado === 'em_curso');
    const paraCancelar = candidatas.filter((c) => c.estado !== 'em_curso');

    let canceladas = 0;
    if (aplicar && paraCancelar.length > 0) {
      const r = await Tarefa.updateMany(
        { _id: { $in: paraCancelar.map((c) => c.tarefa_id) }, empresa_id: empresaId, estado: { $nin: ['cancelada', 'concluida', 'em_curso'] } },
        { $set: { estado: 'cancelada', utilizador_id: null, equipa_atribuida: [] } }
      );
      canceladas = r.modifiedCount;
      registarAuditoria({
        utilizador_id: req.user.id,
        utilizador_nome: req.user.nome || 'Admin',
        empresa_id: empresaId,
        acao: 'reconciliar_cancelamentos',
        recurso: 'tarefa',
        descricao: `Canceladas ${canceladas} limpeza(s) de reservas já canceladas/bloqueadas no Smoobu.`,
      });
    }

    return res.status(200).json({
      aplicado: aplicar,
      total: candidatas.length,
      canceladas,
      candidatas: paraCancelar,
      revisao_manual: revisaoManual,
    });
  } catch (err) {
    console.error('❌ reconciliarCancelamentos:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
}

module.exports = {
  processarWebhookSmoobu,
  processarReservaSmoobu, // exportado para reprocesso manual / testes
  extrairDadosReserva, // exportado para testes
  enriquecerReservaSmoobu, // exportado para backfill futuro
  criarTarefaPorReserva, // exportado para testes
  cancelarTarefaPorReserva, // exportado para reprocesso manual / testes
  atualizarTarefaPorReserva, // exportado para testes
  getPropriedadesSmoobu, // GET /api/gestor/smoobu/propriedades (dropdown)
  importarPropriedades, // POST /api/gestor/smoobu/propriedades (upsert em massa)
  sincronizarReservas, // POST /api/gestor/smoobu/sincronizar (backfill em massa)
  reconciliarCancelamentos, // POST /api/gestor/smoobu/reconciliar-cancelamentos (admin)
  aguardarSincronizacoes, // FIX (timeout 502) — exportado para testes
  extrairMoradaSmoobu, // exportado para testes
  obterApiKeySmoobu, // exportado para reutilização
};
