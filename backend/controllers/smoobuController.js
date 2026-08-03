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
const WebhookLog = require('../models/WebhookLog');
const Ausencia = require('../models/Ausencia');
const Utilizador = require('../models/Utilizador');
const { determinarUtilizadorAtribuido } = require('../utils/loadBalancer');
const {
  obterRangeDia,
  calcularInicioTarefaUtilizador,
} = require('../utils/scheduler');

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

  const detalhesReserva = {
    checkin,
    checkout,
    pax,
    nome_hospede: nomeHospede,
  };

  return {
    action: String(action),
    smoobuPropId,
    dataCheckInRaw: dataCheckInRaw != null ? String(dataCheckInRaw) : null,
    dataCheckOutRaw: dataCheckOutRaw != null ? String(dataCheckOutRaw) : null,
    reservaId,
    detalhesReserva,
    content,
  };
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

    return {
      departure: departure != null ? String(departure) : null,
      arrival: arrival != null ? String(arrival) : null,
      pax: Number.isFinite(Number(pax)) ? Number(pax) : null,
      nome_hospede: nomeHospede,
    };
  } catch (err) {
    console.warn(
      `⚠️  [Smoobu] enriquecerReservaSmoobu: falha ao buscar reserva ${reservaId}: ${err.message}`
    );
    return null;
  }
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
  content
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
        // Reserva foi re-ativada no Smoobu → reativa a tarefa.
        existente.estado = existente.utilizador_id ? 'atribuida' : 'por_atribuir';
        if (detalhesReserva) existente.detalhes_reserva = detalhesReserva;
        await existente.save();
        console.log(
          `🔄 [Smoobu] tarefa ${existente._id} reativada (reserva ${reservaId} re-ativada).`
        );
        return existente;
      }
      // Webhook duplicado — sem ação.
      return existente;
    }
  }

  // 2. Match de propriedade por smoobu_id.
  const propriedade = await Propriedade.findOne({ smoobu_id: smoobuPropId });
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

  // 4. Tempo de limpeza (payload > propriedade > default 45).
  const tempoLimpeza =
    content.tempo_limpeza_minutos ??
    content.cleaning_minutes ??
    propriedade.tempo_limpeza_minutos ??
    45;

  // 5. Load balancer (VIP + SLA + Haversine) — best-effort.
  let resultadoLoadBalancer = null;
  let tentouAtribuir = false;
  try {
    resultadoLoadBalancer = await determinarUtilizadorAtribuido(
      empresaId,
      range,
      propriedade.coordenadas,
      Number(tempoLimpeza) || 45,
      propriedade._id
    );
    tentouAtribuir = true;
  } catch (err) {
    console.error(
      '⚠️  [Smoobu] erro no load balancer (tarefa será criada sem atribuição):',
      err.message
    );
    resultadoLoadBalancer = null;
  }

  const utilizadorAtribuido = resultadoLoadBalancer?.utilizadorId ?? null;
  const tempoViagemMinutos = Number(resultadoLoadBalancer?.tempoViagem) || 0;
  const slaExcedido = tentouAtribuir && !utilizadorAtribuido;

  // 6. Scheduler sequencial (hora de início) — best-effort.
  let dataAgendada;
  let tempoViagemScheduler = 0;
  if (utilizadorAtribuido) {
    try {
      const resultadoScheduler = await calcularInicioTarefaUtilizador(
        utilizadorAtribuido,
        range.start,
        propriedade.coordenadas,
        Number(tempoLimpeza) || 45
      );
      dataAgendada = resultadoScheduler.data;
      tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
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

  // 8. Estado inicial (3 possibilidades).
  const estadoInicial = utilizadorAtribuido
    ? 'atribuida'
    : slaExcedido
    ? 'nao_atribuida' // tentou atribuir mas TODOS excederam SLA 480min.
    : 'por_atribuir'; // erro no load balancer (ainda não tentado).

  // 9. Cria a Tarefa.
  const novaTarefa = await Tarefa.create({
    empresa_id: empresaId,
    propriedade_id: propriedade._id,
    smoobu_reserva_id: reservaId || undefined,
    utilizador_id: utilizadorAtribuido,
    data: dataAgendada,
    tempo_limpeza_minutos: Number(tempoLimpeza) || 45,
    tempo_viagem_minutos: tempoViagemFinal,
    tipo: 'limpeza',
    estado: estadoInicial,
    checklist: propriedade.checklist || [],
    ...(checklistDinamicaWebhook.length > 0
      ? { checklist_dinamica: checklistDinamicaWebhook }
      : {}),
    detalhes_reserva: detalhesReserva || undefined,
  });

  console.log(
    `🧹 [Smoobu] tarefa ${novaTarefa._id} criada (reserva ${reservaId}, ` +
      `propriedade "${propriedade.nome}", estado ${estadoInicial}` +
      (utilizadorAtribuido ? `, staff ${utilizadorAtribuido})` : ').')
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
async function cancelarTarefaPorReserva(reservaId) {
  if (!reservaId) return null;

  const tarefas = await Tarefa.find({ smoobu_reserva_id: reservaId });
  if (tarefas.length === 0) return null;

  let canceladas = 0;
  for (const tarefa of tarefas) {
    if (tarefa.estado === 'cancelada') continue; // idempotente
    tarefa.estado = 'cancelada';
    tarefa.utilizador_id = null; // liberta o staff
    await tarefa.save();
    canceladas++;
  }

  console.log(
    `🚫 [Smoobu] ${canceladas}/${tarefas.length} tarefa(s) cancelada(s) para reserva ${reservaId}.`
  );
  return { canceladas, total: tarefas.length };
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
  content
) {
  if (!reservaId) return null;

  const tarefa = await Tarefa.findOne({ smoobu_reserva_id: reservaId });
  if (!tarefa) return null; // caller cai para criarTarefaPorReserva

  // Tarefas concluídas são intocáveis.
  if (tarefa.estado === 'concluida') return tarefa;

  let mudou = false;
  let mudouData = false;
  let novoRange = null;

  // 1. Atualizar data.
  if (dataTarefaRaw) {
    novoRange = obterRangeDia(dataTarefaRaw);
    if (novoRange && tarefa.data.getTime() !== novoRange.start.getTime()) {
      tarefa.data = novoRange.start;
      mudou = true;
      mudouData = true;
    }
  }

  // 2. Atualizar propriedade (se apartamento trocado).
  if (smoobuPropId) {
    const propriedade = await Propriedade.findOne({ smoobu_id: smoobuPropId });
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
  if (tarefa.estado === 'cancelada') {
    tarefa.estado = tarefa.utilizador_id ? 'atribuida' : 'por_atribuir';
    mudou = true;
  }

  // 3b. Atualiza detalhes_reserva.
  if (detalhesReserva) {
    tarefa.detalhes_reserva = detalhesReserva;
    mudou = true;
  }

  // 4. Se a data mudou E tem utilizador, revalida disponibilidade.
  if (mudouData && tarefa.utilizador_id && novoRange) {
    const utilizador = await Utilizador.findById(tarefa.utilizador_id).lean();
    const diaSemana = novoRange.start.getDay();

    let disponivel = !!(utilizador && utilizador.ativo && !utilizador.eliminado_em);

    // Folgas fixas semanais.
    if (
      disponivel &&
      Array.isArray(utilizador.dias_folga) &&
      utilizador.dias_folga.includes(diaSemana)
    ) {
      disponivel = false;
    }

    // Ausências aprovadas.
    if (disponivel) {
      const ausente = await Ausencia.exists({
        utilizador_id: tarefa.utilizador_id,
        estado: 'aprovada',
        data_inicio: { $lte: novoRange.start },
        data_fim: { $gte: novoRange.start },
      });
      if (ausente) disponivel = false;
    }

    if (!disponivel) {
      tarefa.utilizador_id = null;
      if (tarefa.estado === 'atribuida' || tarefa.estado === 'em_curso') {
        tarefa.estado = 'por_atribuir';
      }
    }
  }

  if (mudou) {
    await tarefa.save();
    console.log(
      `📝 [Smoobu] tarefa ${tarefa._id} atualizada (reserva ${reservaId}).`
    );
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
async function processarReservaSmoobu(payload, empresaId) {
  const {
    action,
    smoobuPropId,
    dataCheckInRaw,
    dataCheckOutRaw,
    reservaId,
    detalhesReserva,
    content,
  } = extrairDadosReserva(payload);

  // 1. Cancelamento.
  if (ACOES_CANCELAR.includes(action)) {
    return cancelarTarefaPorReserva(reservaId);
  }

  // 2. Enriquecimento (se precisa de departure ou nome_hospede).
  let dataCheckOutFinal = dataCheckOutRaw;
  let detalhesFinal = detalhesReserva;
  const precisaEnriquecimento =
    reservaId &&
    (ACOES_CRIAR.includes(action) || ACOES_ATUALIZAR.includes(action)) &&
    (!dataCheckOutRaw || !detalhesReserva.nome_hospede);

  if (precisaEnriquecimento) {
    const enriched = await enriquecerReservaSmoobu(reservaId, empresaId);
    if (enriched) {
      dataCheckOutFinal = enriched.departure || dataCheckOutRaw || null;
      detalhesFinal = {
        checkin: detalhesReserva.checkin || enriched.arrival || null,
        checkout: enriched.departure || detalhesReserva.checkout || null,
        pax: detalhesReserva.pax ?? enriched.pax ?? null,
        nome_hospede:
          detalhesReserva.nome_hospede || enriched.nome_hospede || null,
      };
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
      content
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
      content
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
async function processarWebhookSmoobu(payload, webhookLogId, empresaId) {
  try {
    const resultado = await processarReservaSmoobu(payload, empresaId);

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
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
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

        await Propriedade.create({
          smoobu_id: smoobuId,
          nome: apt.name || `Propriedade ${smoobuId}`,
          morada: moradaTexto,
          coordenadas: coords,
          empresa_id: empresaId,
          tempo_limpeza_minutos: 45,
          capacidade_hospedes: capacidade,
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
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
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
  extrairMoradaSmoobu, // exportado para testes
  obterApiKeySmoobu, // exportado para reutilização
};
