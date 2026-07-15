/**
 * Webhook Controller — Autocell
 *
 * Recebe os webhooks do Smoobu (nova reserva) e aplica a lógica central de
 * atribuição de tarefas de limpeza.
 *
 * Fluxo da função (ESTRITAMENTE este):
 *   1. Receber o payload do Smoobu (propriedade + data_check_in).
 *   2. Encontrar a que empresa_id pertence a propriedade no MongoDB.
 *   3. Procurar todos os Staff dessa empresa.
 *   4. Filtro de Ausências: excluir Staff com registo de Ausência na data_check_in.
 *   5. Cálculo de Carga (Load Balancing): somar tempo_limpeza_minutos das tarefas
 *      já atribuídas a cada Staff para esse dia.
 *   6. Atribuir a nova Tarefa ao Staff com menor tempo acumulado.
 *   7. Se não houver ninguém disponível, criar a Tarefa com utilizador_id: null.
 *
 * Regra de resposta: devolver 200 OK IMEDIATO ao Smoobu e processar as regras
 * de forma assíncrona (o Smoobu cancela pedidos demorados → timeout).
 */

const mongoose = require('mongoose');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Tarefa = require('../models/Tarefa');
const WebhookLog = require('../models/WebhookLog');
const {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularTempoViagem,
  calcularInicioTarefaUtilizador,
} = require('../utils/scheduler');

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */

/**
 * Converte uma data (string "YYYY-MM-DD" ou Date) no intervalo
 * [início do dia, início do dia seguinte] em UTC.
 * Usado para comparar "dias inteiros" na BD de forma determinística.
 *
 * @param {string|Date} dateInput
 * @returns {{start: Date, end: Date}|null}
 */
function getDayRange(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Extrai o ID da propriedade e a data de check-in do payload do Smoobu.
 *
 * Estrutura OFICIAL do webhook "newReservation" do Smoobu (documentada):
 *   {
 *     "action": "newReservation",
 *     "data": {
 *       "id": 292,
 *       "arrival": "YYYY-MM-DD",
 *       "apartment": { "id": 38, "name": "Apartment 1" }
 *     }
 *   }
 *
 * Mapeamento primário (respeita o objeto `data` e o sub-objeto `apartment`):
 *   - smoobuPropId  ← payload.data.apartment.id
 *   - dataCheckInRaw ← payload.data.arrival
 *   - reservaId     ← payload.data.id
 *
 * Fallbacks (com ??) mantidos para precaver outras estruturas/variantes
 * (ex.: payloads com `content` em vez de `data`, ou campos "achatados").
 *
 * @param {object} payload
 * @returns {{smoobuPropId: string, dataCheckInRaw: string, reservaId: string|null, content: object}}
 */
function extrairDadosReserva(payload) {
  // Objeto principal: o Smoobu usa `data`; alguns webhooks antigos usavam `content`.
  const data = (payload && payload.data) || null;
  const content = (payload && payload.content) || payload || {};

  // Sub-objeto apartment (estrutura oficial do Smoobu).
  const apartment = (data && data.apartment) || content.apartment || null;

  // 1) smoobuPropId — primário: data.apartment.id
  const smoobuPropId =
    (apartment && apartment.id) ??
    data?.apartmentId ??
    data?.apartment_id ??
    data?.propertyId ??
    data?.property_id ??
    content.apartmentId ??
    content.apartment_id ??
    content.propertyId ??
    content.property_id ??
    content.propriedade_id;

  // 2) dataCheckInRaw — primário: data.arrival
  const dataCheckInRaw =
    data?.arrival ??
    data?.check_in ??
    data?.checkIn ??
    data?.data_check_in ??
    data?.startDate ??
    content.arrival ??
    content.check_in ??
    content.checkIn ??
    content.data_check_in ??
    content.startDate;

  // 2.b) dataCheckOutRaw — primário: data.departure
  // A tarefa de limpeza deve ser agendada no DIA DO CHECK-OUT (quando o
  // hóspede sai), não no check-in. Se o webhook trouxer departure, usa-o.
  // Se não trouxer (webhook oficial só envia arrival), faz fallback para
  // arrival — a sincronização REST API depois corrige para o check-out real.
  const dataCheckOutRaw =
    data?.departure ??
    data?.check_out ??
    data?.checkOut ??
    data?.endDate ??
    content.departure ??
    content.check_out ??
    content.checkOut ??
    content.endDate ??
    null;

  // 3) reservaId — primário: data.id
  const reservaId =
    data?.id ??
    data?.reservationId ??
    data?.reservation_id ??
    content.id ??
    content.reservationId ??
    content.reservation_id ??
    null;

  // 4) detalhes_reserva (Prompt 93 / Fase 1.5) — check-in, check-out,
  //    número de hóspedes (pax) e nome do hóspede. Cobrem-se as variantes
  //    do webhook do Smoobu (arrival/departure) e da REST API
  //    (start_date/end_date), bem como os formatos comuns de hóspede.
  const checkin =
    data?.arrival ??
    data?.check_in ??
    data?.checkIn ??
    data?.startDate ??
    content.arrival ??
    content.check_in ??
    content.checkIn ??
    content.startDate ??
    null;

  const checkout =
    data?.departure ??
    data?.check_out ??
    data?.checkOut ??
    data?.endDate ??
    content.departure ??
    content.check_out ??
    content.checkOut ??
    content.endDate ??
    null;

  // pax — número de hóspedes. Variantes: guests (Smoobu REST),
  // numPeople, numberOfGuests, pax, adults+children.
  const paxRaw =
    data?.guests ??
    data?.numPeople ??
    data?.numberOfGuests ??
    data?.pax ??
    (data?.adults != null ? Number(data.adults) + Number(data.children ?? 0) : null) ??
    content.guests ??
    content.numPeople ??
    content.numberOfGuests ??
    content.pax ??
    null;
  const pax = paxRaw != null ? Number(paxRaw) : null;

  // nome_hospede — nome do hóspede principal.
  // Prompt 139b — O Smoobu usa 'guest-name' (kebab-case) em alguns endpoints.
  // Variantes cobertas: guestName, guest_name, guest-name, guest.name,
  // guest.firstName + guest.lastName, firstName + lastName, name.
  const nomeHospede =
    data?.guestName ??
    data?.guest_name ??
    data?.['guest-name'] ??
    data?.guest?.name ??
    data?.guest?.firstName ??
    (data?.guest?.firstName || data?.guest?.lastName
      ? [data?.guest?.firstName, data?.guest?.lastName].filter(Boolean).join(' ')
      : null) ??
    (data?.firstName || data?.lastName
      ? [data?.firstName, data?.lastName].filter(Boolean).join(' ')
      : null) ??
    data?.name ??
    content.guestName ??
    content.guest_name ??
    content['guest-name'] ??
    content.guest?.name ??
    (content?.firstName || content?.lastName
      ? [content?.firstName, content?.lastName].filter(Boolean).join(' ')
      : null) ??
    null;

  const detalhesReserva = {
    // Prompt 102 — ID original da reserva no Smoobu (para cancelamentos).
    smoobu_reserva_id: reservaId != null ? String(reservaId) : null,
    checkin: checkin != null ? String(checkin) : null,
    checkout: checkout != null ? String(checkout) : null,
    pax: Number.isFinite(pax) ? pax : null,
    nome_hospede: nomeHospede != null ? String(nomeHospede).trim().slice(0, 200) : null,
  };

  return {
    smoobuPropId: smoobuPropId != null ? String(smoobuPropId) : null,
    dataCheckInRaw: dataCheckInRaw != null ? String(dataCheckInRaw) : null,
    dataCheckOutRaw: dataCheckOutRaw != null ? String(dataCheckOutRaw) : null,
    reservaId: reservaId != null ? String(reservaId) : null,
    detalhesReserva,
    // Mantém-se `content` para retrocompatibilidade com quem consome esta função.
    content,
  };
}

/* ------------------------------------------------------------------ */
/* Lógica de atribuição (passos 3 a 6)                                */
/* ------------------------------------------------------------------ */

// v1.53.0 — CAPACIDADE_MAXIMA_MINUTOS e calcularTempoViagem foram movidos
// para backend/utils/scheduler.js (partilhados com tarefaController.js para
// a reatribuição inteligente). Importados no topo do ficheiro.

/**
 * Calcula o tempo de limpeza acumulado (minutos) de um utilizador num dado
 * dia (range), somando tempo_limpeza_minutos das tarefas já atribuídas
 * (excluindo canceladas e concluídas). Usado pelo Algoritmo VIP (Prompt 93)
 * para validar o SLA de 8h/dia do funcionário preferencial.
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {{start: Date, end: Date}} range
 * @returns {Promise<number>}
 */
async function calcularCargaLimpezaDia(empresaId, utilizadorId, range) {
  const res = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: empresaId,
        utilizador_id: utilizadorId,
        data: { $gte: range.start, $lt: range.end },
        estado: { $nin: ['cancelada', 'concluida'] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$tempo_limpeza_minutos' },
      },
    },
  ]);
  return res.length > 0 ? res[0].total : 0;
}

/**
 * Determina o utilizador (Staff) a quem atribuir a tarefa, aplicando:
 *   - filtro de ausências (passo 4)
 *   - filtro de folgas fixas semanais (v1.13.0)
 *   - cálculo de carga + tempo de viagem (passo 5, v1.14.0)
 *   - escolha do utilizador com menor carga_total (passo 6)
 *
 * v1.14.0 — Carga total = tempo_limpeza acumulado + tempo_viagem
 *   O tempo_viagem é calculado entre a última tarefa do dia do utilizador
 *   e a nova propriedade (Haversine). Se o utilizador não tiver tarefas
 *   nesse dia, tempo_viagem = 0.
 *
 * v1.15.0 — SLA de Capacidade Máxima:
 *   Após calcular a carga_total (limpeza + viagem + nova tarefa), se
 *   carga_total > CAPACIDADE_MAXIMA_MINUTOS (480 min = 8h), o utilizador
 *   é excluído. Se TODOS excederem, devolve null (tarefa por_atribuir).
 *
 * Prompt 93 (Fase 1.5) — Algoritmo VIP (funcionário preferencial):
 *   Antes de correr o load balancer geral, verifica se a propriedade tem
 *   `funcionario_preferencial_id`. Se tiver, e esse funcionário estiver
 *   ativo + disponível (sem ausência aprovada/folga fixa no dia) + não
 *   ultrapassar o limite de 8h/dia (CAPACIDADE_MAXIMA_MINUTOS) com a nova
 *   limpeza, a tarefa é-lhe atribuída OBRIGATORIAMENTE (ignora o cálculo
 *   de distância/carga dos outros). Só se o preferencial não puder é que o
 *   sistema faz fallback para o load balancer geral (funcionário mais
 *   próximo / menos carregado).
 *
 * Devolve null se não houver ninguém disponível.
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {{start: Date, end: Date}} range
 * @param {{ lat: number, lng: number } | null} coordenadasNovaPropriedade
 * @param {number} tempoNovaTarefa - tempo_limpeza_minutos da nova tarefa
 * @param {import('mongoose').Types.ObjectId|null} [propriedadeId=null] - id da propriedade (para VIP)
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
async function determinarUtilizadorAtribuido(empresaId, range, coordenadasNovaPropriedade, tempoNovaTarefa, propriedadeId = null) {
  // Passo 3 — Procurar todos os Staff ativos da empresa.
  // v1.45.0: só role 'staff' (gestores não recebem tarefas de limpeza).
  const staff = await Utilizador.find({
    empresa_id: empresaId,
    role: 'staff',
    ativo: true,
    eliminado_em: null,
  }).lean();

  if (staff.length === 0) return null;

  // Passo 4 — Filtro de Ausências: excluir quem tem ausência que cobre este dia.
  // v1.16.0: o campo legacy `data` foi removido. Query agora usa apenas
  // data_inicio/data_fim (sobreposição de intervalos).
  // Condição: ausencia.data_inicio <= dia AND ausencia.data_fim >= dia.
  // v1.24.0: só ausências APROVADAS bloqueiam a atribuição. Pedidos
  // pendentes ou rejeitados não contam (o staff pode ainda trabalhar).
  const ausentes = await Ausencia.find({
    utilizador_id: { $in: staff.map((s) => s._id) },
    estado: 'aprovada',
    data_inicio: { $lte: range.start },
    data_fim: { $gte: range.start },
  }).distinct('utilizador_id');

  const setAusentes = new Set(ausentes.map(String));

  // v1.13.0 — Filtro de Folgas Fixas Semanais:
  // Um utilizador também é excluído se o dia da semana do check-in
  // estiver no seu array dias_folga (0=Dom, 6=Sáb, padrão Date.getDay()).
  const diaSemana = range.start.getDay();

  const disponiveis = staff.filter((s) => {
    // Filtro de ausências (já calculado acima).
    if (setAusentes.has(String(s._id))) return false;
    // Filtro de folgas fixas semanais.
    if (s.dias_folga && Array.isArray(s.dias_folga) && s.dias_folga.includes(diaSemana)) {
      return false;
    }
    return true;
  });

  if (disponiveis.length === 0) return null;

  // ----------------------------------------------------------------
  // Prompt 93 (Fase 1.5) — Algoritmo VIP (funcionário preferencial).
  // ----------------------------------------------------------------
  // Antes de correr o load balancer geral, verifica se a propriedade tem
  // um funcionario_preferencial_id. Se tiver, e esse funcionário estiver
  // disponível + dentro do SLA de 8h/dia com a nova limpeza, atribui-se
  // obrigatoriamente a ele. Só se o preferencial não puder é que se faz
  // fallback para o load balancer geral.
  if (propriedadeId) {
    const propVIP = await Propriedade.findById(propriedadeId)
      .select('funcionario_preferencial_id')
      .lean();
    const vipId = propVIP?.funcionario_preferencial_id;
    if (vipId) {
      const vipIdStr = String(vipId);
      const vip = disponiveis.find((s) => String(s._id) === vipIdStr);
      if (vip) {
        // O preferencial está disponível (passou os filtros de ausência +
        // folga). Falta validar o SLA de capacidade (8h/dia).
        // Prompt 138 (136 V2) — Number() em tudo para evitar concatenação.
        const cargaLimpezaVIP = Number(await calcularCargaLimpezaDia(empresaId, vip._id, range)) || 0;
        const cargaTotalVIP = cargaLimpezaVIP + Number(tempoNovaTarefa);
        if (cargaTotalVIP <= CAPACIDADE_MAXIMA_MINUTOS) {
          console.log(
            `⭐ Algoritmo VIP: tarefa atribuída ao funcionário preferencial ${vipIdStr} ` +
              `(carga ${cargaTotalVIP}min ≤ ${CAPACIDADE_MAXIMA_MINUTOS}min).`
          );
          // Devolve também o tempo de viagem 0 (VIP não tem cálculo de
          // viagem no SLA — só conta a carga de limpeza).
          return { utilizadorId: vip._id, tempoViagem: 0 };
        }
        console.log(
          `⭐ Algoritmo VIP: preferencial ${vipIdStr} excede SLA ` +
            `(${cargaTotalVIP}min > ${CAPACIDADE_MAXIMA_MINUTOS}min) — fallback para load balancer geral.`
        );
      } else {
        console.log(
          `⭐ Algoritmo VIP: preferencial ${vipIdStr} indisponível (folga/ausência/inativo) — fallback para load balancer geral.`
        );
      }
    }
  }

  // Passo 5 — Cálculo de Carga + Tempo de Viagem (v1.14.0):
  // carga_total = tempo_limpeza acumulado + tempo_viagem
  //
  // Para cada utilizador disponível:
  //   1. Soma o tempo_limpeza_minutos das tarefas já atribuídas no dia.
  //   2. Encontra a ÚLTIMA tarefa do dia (com populate de propriedade_id
  //      para obter coordenadas).
  //   3. Calcula tempo_viagem entre a última casa e a nova casa (Haversine).
  //   4. carga_total = soma_limpeza + tempo_viagem.
  const disponiveisIds = disponiveis.map((s) => s._id);

  // Soma de tempo de limpeza por utilizador (aggregate).
  const cargasLimpeza = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: empresaId,
        utilizador_id: { $in: disponiveisIds },
        data: { $gte: range.start, $lt: range.end },
        estado: { $nin: ['cancelada', 'concluida'] },
      },
    },
    {
      $group: {
        _id: '$utilizador_id',
        total: { $sum: '$tempo_limpeza_minutos' },
      },
    },
  ]);

  const cargaLimpezaMap = new Map();
  for (const c of cargasLimpeza) {
    cargaLimpezaMap.set(String(c._id), c.total);
  }

  // Para cada utilizador, encontra a última tarefa do dia (com coordenadas).
  // Fazemos um find por utilizador em vez de um aggregate complexo, porque
  // precisamos de populate('propriedade_id', 'coordenadas').
  let melhorUtilizador = null;
  let menorCargaTotal = Infinity;
  // Prompt 138 (136 V2) — guarda o tempo de viagem do melhor staff para
  // persistir na tarefa (campo tempo_viagem_minutos).
  let melhorTempoViagem = 0;

  for (const u of disponiveis) {
    // Tempo de limpeza acumulado.
    const cargaLimpeza = cargaLimpezaMap.get(String(u._id)) ?? 0;

    // Encontra a última tarefa do dia deste utilizador (com coordenadas).
    const ultimaTarefa = await Tarefa.findOne({
      utilizador_id: u._id,
      data: { $gte: range.start, $lt: range.end },
      estado: { $nin: ['cancelada', 'concluida'] },
    })
      .populate({ path: 'propriedade_id', select: 'coordenadas' })
      .sort({ createdAt: -1 }) // mais recente primeiro
      .lean();

    // Calcula tempo de viagem.
    let tempoViagem = 0;
    if (ultimaTarefa && ultimaTarefa.propriedade_id) {
      const coordAnterior = ultimaTarefa.propriedade_id.coordenadas;
      tempoViagem = calcularTempoViagem(coordAnterior, coordenadasNovaPropriedade);
    }

    // Carga total = limpeza acumulada + viagem + tempo da nova tarefa.
    // v1.15.0: inclui o tempo_limpeza_minutos da NOVA tarefa que está a
    // ser atribuída (recebido como parâmetro adicional).
    //
    // Prompt 138 (136 V2) — Fix Matemática SLA:
    //   O cálculo estava com bugs de concatenação de strings (o aggregate
    //   do MongoDB pode devolver Number ou string consoante o tipo no schema).
    //   Envolve-se tudo em Number(...) para garantir aritmética correcta.
    const cargaTotal =
      Number(cargaLimpeza) + Number(tempoViagem) + Number(tempoNovaTarefa);

    // Validação: se algum componente for NaN, skipa este utilizador.
    if (!Number.isFinite(cargaTotal)) {
      console.warn(`⚠️  determinarUtilizadorAtribuido: cargaTotal=NaN para staff ${u._id} (cargaLimpeza=${cargaLimpeza}, tempoViagem=${tempoViagem}, tempoNovaTarefa=${tempoNovaTarefa})`);
      continue;
    }

    // SLA: se a carga total exceder a capacidade máxima, ignora este utilizador.
    if (cargaTotal > CAPACIDADE_MAXIMA_MINUTOS) {
      console.log(`⚠️  SLA: staff ${u._id} excede 480min (cargaTotal=${cargaTotal}min) — excluído do load balancer.`);
      continue;
    }

    if (cargaTotal < menorCargaTotal) {
      menorCargaTotal = cargaTotal;
      melhorUtilizador = u;
      // Guarda o tempo de viagem do melhor utilizador para persistir na tarefa.
      melhorTempoViagem = tempoViagem;
    }
  }

  // Prompt 138 (136 V2) — Se TODOS os staff disponíveis excederam o SLA de
  // 480 min, devolve um marcador especial para o caller saber que deve criar
  // a tarefa com estado 'nao_atribuida' (em vez de 'por_atribuir'). Isto
  // distingue "ainda não tentámos atribuir" de "tentámos mas não coube em
  // nenhum staff — requer intervenção do gestor".
  if (!melhorUtilizador) {
    console.log(`⚠️  determinarUtilizadorAtribuido: nenhum staff disponível coube no SLA de ${CAPACIDADE_MAXIMA_MINUTOS}min — tarefa será 'nao_atribuida'.`);
  }

  return melhorUtilizador ? { utilizadorId: melhorUtilizador._id, tempoViagem: melhorTempoViagem } : null;
}

/* ------------------------------------------------------------------ */
/* Processamento principal — dispatcher de ações (v1.19.0)            */
/* ------------------------------------------------------------------ */

// Ações reconhecidas do Smoobu. O webhook reage a 3 tipos:
//   - CRIAR  → nova reserva → cria tarefa (com load balancing)
//   - ATUALIZAR → reserva editada → atualiza data/propriedade/tempo da tarefa
//   - CANCELAR → reserva cancelada → marca tarefa como 'cancelada'
// Outras ações são ignoradas graciosamente (não é erro).
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
 * Processa o payload do Smoobu e reage conforme a action:
 *   - newReservation → cria tarefa (idempotente)
 *   - updateReservation → atualiza a tarefa existente (data/propriedade/tempo + reavalia atribuição)
 *   - cancellation → cancela a tarefa existente (respeita concluídas)
 *   - outras → ignora graciosamente (não é erro)
 *
 * @param {object} payload
 * @returns {Promise<object|null>} a tarefa afetada, ou null se ignorada.
 */
async function processarReservaSmoobu(payload) {
  let { smoobuPropId, dataCheckInRaw, dataCheckOutRaw, reservaId, detalhesReserva, content } =
    extrairDadosReserva(payload);

  const action =
    (payload && payload.action) ||
    (payload && payload.type) ||
    (content && content.action) ||
    'newReservation';

  // 1) Cancelamento → cancela a tarefa existente.
  if (ACOES_CANCELAR.includes(action)) {
    return cancelarTarefaPorReserva(reservaId);
  }

  // A tarefa de limpeza é agendada no DIA DO CHECK-OUT (departure).
  // O webhook oficial do Smoobu só envia arrival (check-in), não departure.
  // Se não tivermos departure, fazemos um pedido à REST API do Smoobu para
  // obter os detalhes completos da reserva (departure, guests, guestName).
  // Isto demora mais tempo mas garante que a tarefa é criada no dia certo.
  //
  // Prompt 137 — Se mesmo com departure, o nome_hospede não vier no payload
  // do webhook (caso normal), fazemos mesmo assim o enriquecimento para
  // obter o nome do hóspede. Antes, o enriquecimento só corria quando
  // !dataCheckOutRaw, o que deixava o nome_hospede sempre vazio nas reservas
  // cujo webhook já trazia departure.
  const precisaEnriquecimento =
    reservaId &&
    (ACOES_CRIAR.includes(action) || ACOES_ATUALIZAR.includes(action)) &&
    (!dataCheckOutRaw || !detalhesReserva.nome_hospede);

  if (precisaEnriquecimento) {
    const enriched = await enriquecerReservaSmoobu(reservaId);
    if (enriched) {
      dataCheckOutRaw = enriched.departure || dataCheckOutRaw || null;
      // Atualiza detalhes_reserva com os dados completos da REST API.
      detalhesReserva = {
        ...detalhesReserva,
        checkin: enriched.arrival || detalhesReserva.checkin,
        checkout: enriched.departure || detalhesReserva.checkout,
        pax: enriched.pax != null ? enriched.pax : detalhesReserva.pax,
        nome_hospede: enriched.nome_hospede || detalhesReserva.nome_hospede,
      };
    }
  }

  // Se mesmo após o enriquecimento não houver departure, usa arrival como
  // último recurso (melhor ter a tarefa no check-in do que não ter tarefa).
  const dataTarefaRaw = dataCheckOutRaw || dataCheckInRaw;

  // 2) Atualização → atualiza a tarefa existente (ou cria se não existir).
  if (ACOES_ATUALIZAR.includes(action)) {
    const atualizada = await atualizarTarefaPorReserva(
      reservaId,
      smoobuPropId,
      dataTarefaRaw,
      detalhesReserva,
      content
    );
    if (atualizada) return atualizada;
    // Sem tarefa existente → cai para o fluxo de criação (reserva pode ter
    // sido criada antes de o webhook estar ativo).
    console.log(
      `ℹ️  Update para reserva ${reservaId} sem tarefa existente — tratar como nova.`
    );
  }

  // 3) Criação (newReservation ou fallback de update sem tarefa).
  if (!ACOES_CRIAR.includes(action) && !ACOES_ATUALIZAR.includes(action)) {
    console.log(
      `ℹ️  Webhook com action "${action}" — ação não processada (ignorada).`
    );
    return null;
  }

  return criarTarefaPorReserva(reservaId, smoobuPropId, dataTarefaRaw, detalhesReserva, content);
}

/**
 * Faz um pedido à REST API do Smoobu para obter os detalhes completos de
 * uma reserva (departure, guests, guestName). Usado quando o webhook não
 * traz departure (o webhook oficial só envia arrival).
 *
 * Best-effort: se falhar (API key em falta, erro de rede, etc.), devolve
 * null e o chamador usa arrival como fallback.
 *
 * @param {string} reservaId
 * @returns {Promise<{arrival, departure, pax, nome_hospede} | null>}
 */
async function enriquecerReservaSmoobu(reservaId) {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.warn('⚠️  enriquecerReservaSmoobu: SMOOBU_API_KEY não configurada — usando arrival como fallback.');
    return null;
  }

  try {
    const url = `https://login.smoobu.com/api/reservations/${reservaId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Key': apiKey.trim(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`⚠️  enriquecerReservaSmoobu: Smoobu devolveu ${res.status} para reserva ${reservaId}.`);
      return null;
    }

    const body = await res.json();
    // A resposta pode vir em body.data ou diretamente no body.
    const r = body?.data ?? body;

    // Log do payload completo para debug (Prompt 137 — diagnosticar nome_hospede).
    console.log(`📋 enriquecerReservaSmoobu: payload recebido para reserva ${reservaId}:`, JSON.stringify(r).slice(0, 500));

    const arrival = r?.arrival ?? r?.start_date ?? r?.startDate ?? null;
    const departure = r?.departure ?? r?.end_date ?? r?.endDate ?? null;
    const paxRaw = r?.guests ?? r?.numPeople ?? r?.numberOfGuests ?? null;
    const pax = paxRaw != null ? Number(paxRaw) : null;
    // Prompt 139b — Cobertura exaustiva das variantes do nome do hóspede no Smoobu.
    // O Smoobu REST API pode devolver: guestName, guest_name, guest-name,
    // guest.name, guest.firstName + guest.lastName, firstName + lastName,
    // customerName, customer.name, bookedForName, name.
    const nome_hospede =
      r?.guestName ??
      r?.guest_name ??
      r?.['guest-name'] ??
      r?.guest?.name ??
      r?.guest?.firstName ??
      (r?.guest?.firstName || r?.guest?.lastName
        ? [r?.guest?.firstName, r?.guest?.lastName].filter(Boolean).join(' ')
        : null) ??
      (r?.firstName || r?.lastName
        ? [r?.firstName, r?.lastName].filter(Boolean).join(' ')
        : null) ??
      r?.customerName ??
      r?.customer?.name ??
      r?.bookedForName ??
      r?.name ??
      null;

    console.log(
      `✅ enriquecerReservaSmoobu: reserva ${reservaId} — arrival=${arrival}, departure=${departure}, pax=${pax}, hospede=${nome_hospede}`
    );

    return { arrival, departure, pax, nome_hospede };
  } catch (err) {
    console.warn(`⚠️  enriquecerReservaSmoobu: erro ao buscar reserva ${reservaId}:`, err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Handler: CRIAR tarefa (newReservation)                              */
/* ------------------------------------------------------------------ */

/**
 * Cria a Tarefa correspondente a uma nova reserva do Smoobu.
 * Aplica idempotência (se já existir tarefa com o mesmo smoobu_reserva_id,
 * não duplica). Se a tarefa existente estiver cancelada (reserva foi
 * cancelada e agora re-criada), re-activa-a.
 *
 * Prompt 93 (Fase 1.5): guarda os detalhes_reserva (checkin, checkout,
 * pax, nome_hospede) extraídos do payload do Smoobu.
 */
async function criarTarefaPorReserva(reservaId, smoobuPropId, dataTarefaRaw, detalhesReserva, content) {
  if (!smoobuPropId || !dataTarefaRaw) {
    throw new Error(
      'Payload do Smoobu inválido: propriedade ou data em falta.'
    );
  }

  const range = getDayRange(dataTarefaRaw);
  if (!range) {
    throw new Error(`data inválida: ${dataTarefaRaw}`);
  }

  // Idempotência: se já existir tarefa para esta reserva, não duplica.
  if (reservaId) {
    const existente = await Tarefa.findOne({ smoobu_reserva_id: reservaId });
    if (existente) {
      // Se a tarefa foi cancelada (reserva cancelada e agora re-criada),
      // re-activa e mantém a atribuição (ou por_atribuir se não tinha).
      // Prompt 93: atualiza também os detalhes_reserva (a reserva pode ter
      // sido re-criada com dados diferentes).
      if (existente.estado === 'cancelada') {
        console.log(
          `♻️  Reserva ${reservaId} re-activada (tarefa ${existente._id} estava cancelada).`
        );
        existente.estado = existente.utilizador_id ? 'atribuida' : 'por_atribuir';
        if (detalhesReserva) {
          existente.detalhes_reserva = detalhesReserva;
        }
        await existente.save();
        return existente;
      }
      console.log(
        `♻️  Webhook duplicado (reserva ${reservaId}) — tarefa ${existente._id} já existe. Sem ação.`
      );
      return existente;
    }
  }

  // Encontrar a empresa à qual a propriedade pertence.
  const propriedade = await Propriedade.findOne({ smoobu_id: smoobuPropId });
  if (!propriedade) {
    throw new Error(`Propriedade Smoobu ${smoobuPropId} não encontrada na BD.`);
  }

  // Propriedade suspensa → não cria tarefa.
  if (!propriedade.ativo) {
    console.warn(
      `⚠️  Propriedade "${propriedade.nome}" (smoobu_id: ${smoobuPropId}) está suspensa — tarefa não criada.`
    );
    throw new Error(
      `Propriedade "${propriedade.nome}" está suspensa (ativo: false). Tarefa não criada.`
    );
  }

  const empresaId = propriedade.empresa_id;

  // Prompt 116 — Rejeita webhooks de empresas inativas (ativa: false).
  // A empresa foi desativada pelo Super Admin — nenhuma tarefa deve ser
  // criada/atualizada para propriedades dessa empresa.
  try {
    const Empresa = require('../models/Empresa');
    const empresa = await Empresa.findById(empresaId).select('ativa').lean();
    if (empresa && empresa.ativa === false) {
      console.warn(
        `⚠️  Empresa ${empresaId} está inativa — webhook rejeitado (propriedade "${propriedade.nome}").`
      );
      throw new Error(
        `Empresa inativa. Webhooks rejeitados. Propriedade "${propriedade.nome}".`
      );
    }
  } catch (empErr) {
    // Se for o erro de empresa inativa, re-lança para parar o processamento.
    if (empErr.message && empErr.message.includes('Empresa inativa')) {
      throw empErr;
    }
    // Outros erros (ex.: BD) — loga mas não bloqueia (best-effort).
    console.error('⚠️  Verificação de empresa ativa falhou:', empErr.message);
  }

  // Tempo de limpeza (calculado antes do load balancer, que o usa no SLA).
  const tempoLimpeza =
    content.tempo_limpeza_minutos ??
    content.cleaning_minutes ??
    propriedade.tempo_limpeza_minutos ??
    45;

  // Load balancer (best-effort: se falhar, cria sem atribuição).
  // Prompt 93: passa o propriedade._id para o Algoritmo VIP (preferencial).
  // Prompt 138 (136 V2) — determinarUtilizadorAtribuido agora devolve
  // { utilizadorId, tempoViagem } ou null. Se null, todos os staff excederam
  // o SLA de 480 min → tarefa fica 'nao_atribuida' (requer intervenção).
  let resultadoLoadBalancer = null;
  let tentouAtribuir = false;
  try {
    resultadoLoadBalancer = await determinarUtilizadorAtribuido(
      empresaId,
      range,
      propriedade.coordenadas,
      tempoLimpeza,
      propriedade._id
    );
    tentouAtribuir = true;
  } catch (err) {
    console.error(
      '⚠️  Erro ao determinar utilizador (tarefa será criada sem atribuição):',
      err.message
    );
    resultadoLoadBalancer = null;
  }

  const utilizadorAtribuido = resultadoLoadBalancer?.utilizadorId ?? null;
  // Prompt 138 (136 V2) — tempo de viagem do staff escolhido (para persistir).
  const tempoViagemMinutos = Number(resultadoLoadBalancer?.tempoViagem) || 0;
  // Se tentámos atribuir mas não encaixou em nenhum staff (SLA excedido),
  // marca como 'nao_atribuida'. Se não tentámos (erro), fica 'por_atribuir'.
  const slaExcedido = tentouAtribuir && !utilizadorAtribuido;

  // v1.49.0 — Scheduler Sequencial: calcula a hora exata de início da
  // tarefa em vez de usar meia-noite (range.start). As limpezas começam
  // às 11:00 por defeito; se o staff já tiver tarefas nesse dia, a nova
  // tarefa é agendada após a última (fim + tempo de viagem).
  // v1.51.0 — Proteção de hora de almoço (13:00-14:00 local).
  // v1.53.0 — Lógica extraída para backend/utils/scheduler.js (partilhada
  // com a reatribuição inteligente do tarefaController).
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
      // O scheduler calcula o tempo de viagem novamente (entre a última
      // tarefa do staff e a nova). Usamos esse valor se for > 0 (mais
      // preciso que o do load balancer, que é entre a última tarefa
      // cronológica e a nova).
      tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
    } catch (err) {
      console.error('⚠️  Scheduler sequencial falhou (usa 11:00 padrão):', err.message);
      dataAgendada = new Date(range.start);
      dataAgendada.setUTCHours(10, 0, 0, 0); // 11:00 local (UTC+1) = 10:00 UTC
    }
  } else {
    // Sem atribuição: mantém 11:00 padrão (sem cálculo de viagem).
    dataAgendada = new Date(range.start);
    dataAgendada.setUTCHours(10, 0, 0, 0); // 11:00 local (UTC+1) = 10:00 UTC
  }

  // Prompt 138 (136 V2) — tempo de viagem final a guardar na tarefa.
  // Prefere o valor do scheduler (mais preciso) se disponível.
  const tempoViagemFinal = tempoViagemScheduler > 0 ? tempoViagemScheduler : tempoViagemMinutos;

  // Prompt 133 — Injeção de Checklist Dinâmica (snapshot do ModeloChecklist).
  let checklistDinamicaWebhook = [];
  if (propriedade.modelo_checklist_id) {
    try {
      const ModeloChecklist = require('../models/ModeloChecklist');
      const modeloChk = await ModeloChecklist.findById(propriedade.modelo_checklist_id).lean();
      if (modeloChk && Array.isArray(modeloChk.seccoes)) {
        checklistDinamicaWebhook = modeloChk.seccoes.map((sec) => ({
          nome: sec.nome,
          items: (sec.items || []).map((item) => ({
            texto: item,
            concluido: false,
          })),
        }));
      }
    } catch (chkErr) {
      console.error('⚠️  webhook: erro ao injetar checklist dinâmica:', chkErr.message);
    }
  }

  // Prompt 138 (136 V2) — estado: se o SLA foi excedido (tentou atribuir mas
  // nenhum staff coube), marca 'nao_atribuida'. Se atribuiu, 'atribuida'.
  // Caso contrário (erro no load balancer), 'por_atribuir'.
  const estadoInicial = utilizadorAtribuido
    ? 'atribuida'
    : slaExcedido
    ? 'nao_atribuida'
    : 'por_atribuir';

  const novaTarefa = await Tarefa.create({
    empresa_id: empresaId,
    propriedade_id: propriedade._id,
    smoobu_reserva_id: reservaId || undefined,
    utilizador_id: utilizadorAtribuido,
    data: dataAgendada,
    tempo_limpeza_minutos: Number(tempoLimpeza) || 45,
    // Prompt 138 (136 V2) — tempo de viagem guardado na BD (para o frontend
    // desenhar rotas e para auditoria do load balancer).
    tempo_viagem_minutos: tempoViagemFinal,
    tipo: 'limpeza',
    estado: estadoInicial,
    // v1.55.0 (Prompt 77) — Snapshot da checklist da propriedade no momento
    // da criação. Sem isto, as tarefas nasciam sem itens para o staff picar.
    checklist: propriedade.checklist || [],
    // Prompt 133 — Snapshot da checklist dinâmica (se existir modelo).
    ...(checklistDinamicaWebhook.length > 0 ? { checklist_dinamica: checklistDinamicaWebhook } : {}),
    // Prompt 93 (Fase 1.5) — Detalhes da reserva Smoobu (checkin, checkout,
    // pax, nome_hospede) para auditoria e display.
    detalhes_reserva: detalhesReserva || undefined,
  });

  if (utilizadorAtribuido) {
    console.log(
      `✅ Tarefa ${novaTarefa._id} atribuída ao utilizador ${utilizadorAtribuido} (carga do dia calculada, viagem: ${tempoViagemFinal}min).`
    );

    // v1.37.0 — Notificação push ao staff (se tiver subscrição ativa).
    // v1.65.0 (Prompt 88) — Mensagem mais descritiva.
    // Prompt 114 — Agora cria também notificação in-app (tipo: tarefa_atribuida).
    const { notificarUtilizador } = require('../utils/notificar');
    const propNome = propriedade?.nome ?? 'Propriedade';
    notificarUtilizador(
      String(utilizadorAtribuido),
      '🧹 Nova Limpeza Atribuída',
      `Foste escalado para limpar a ${propNome}.`,
      '/staff',
      { tipo: 'tarefa_atribuida', empresa_id: String(empresaId) }
    );
  } else {
    // Prompt 138 (136 V2) — distingue "sem staff disponível" de "SLA excedido".
    console.log(
      slaExcedido
        ? `⚠️  Tarefa ${novaTarefa._id} criada como 'nao_atribuida' (todos os staff excedem SLA de ${CAPACIDADE_MAXIMA_MINUTOS}min).`
        : `✅ Tarefa ${novaTarefa._id} criada SEM atribuição (sem Staff disponível ou erro).`
    );
  }

  return novaTarefa;
}

/* ------------------------------------------------------------------ */
/* Handler: CANCELAR tarefa (cancellation)                            */
/* ------------------------------------------------------------------ */

/**
 * Cancela a tarefa associada a uma reserva (quando o Smoobu envia
 * `action: cancellation`).
 *
 * Prompt 103 — Soft Delete com Histórico para Excel:
 *   Em vez de HARD DELETE (Prompt 102), faz SOFT DELETE: atualiza as
 *   tarefas associadas a esse smoobu_reserva_id para estado = 'cancelada'
 *   e utilizador_id = null (liberta o funcionário). As tarefas canceladas
 *   ficam ocultas do calendário e da agenda do staff (filtradas nas
 *   queries), mas MANTIDAS na BD para aparecerem no relatório Excel.
 *
 *   Tarefas 'concluida' também são marcadas como 'cancelada' (o trabalho
 *   foi feito, mas a reserva foi cancelada — fica registado).
 *
 * Procura por smoobu_reserva_id (campo top-level) E por
 * detalhes_reserva.smoobu_reserva_id (campo aninhado).
 */
async function cancelarTarefaPorReserva(reservaId) {
  if (!reservaId) {
    console.log('ℹ️  Cancelamento sem reservaId — sem ação.');
    return null;
  }

  // Procura todas as tarefas associadas a esta reserva (top-level OU aninhado).
  const tarefas = await Tarefa.find({
    $or: [
      { smoobu_reserva_id: reservaId },
      { 'detalhes_reserva.smoobu_reserva_id': reservaId },
    ],
  });

  if (tarefas.length === 0) {
    console.log(
      `ℹ️  Cancelamento da reserva ${reservaId} sem tarefa associada — sem ação.`
    );
    return null;
  }

  let canceladas = 0;
  for (const tarefa of tarefas) {
    // Já cancelada → idempotente.
    if (tarefa.estado === 'cancelada') {
      continue;
    }
    // Soft delete: estado = 'cancelada' + utilizador_id = null (liberta staff).
    tarefa.estado = 'cancelada';
    tarefa.utilizador_id = null;
    await tarefa.save();
    canceladas++;
  }

  console.log(
    `🚫 Cancelamento reserva ${reservaId}: ${canceladas} tarefa(s) marcada(s) como cancelada (soft delete).`
  );

  return { canceladas, total: tarefas.length };
}

/* ------------------------------------------------------------------ */
/* Handler: ATUALIZAR tarefa (updateReservation)                      */
/* ------------------------------------------------------------------ */

/**
 * Atualiza a tarefa associada a uma reserva quando o Smoobu envia
 * `action: updateReservation` (a reserva foi editada — ex: data de
 * check-in alterada, apartamento trocado).
 *
 * Comportamento:
 *   - Se a tarefa estiver concluída → mantém (trabalho já feito).
 *   - Se a tarefa estiver cancelada → re-activa (a reserva voltou a ativa).
 *   - Atualiza `data`, `propriedade_id`, `tempo_limpeza_minutos`, `detalhes_reserva`.
 *   - Se a `data` mudou, reavalia a atribuição: se o funcionário atual
 *     não estiver disponível no novo dia (folga/ausência/inativo), a
 *     tarefa passa a `por_atribuir` para o Admin reatribuir. Isto evita
 *     shuffle desnecessário (mantém o funcionário se ainda for válido).
 *
 * Prompt 93 (Fase 1.5): atualiza também os detalhes_reserva (a reserva
 * pode ter sido editada com novas datas/hóspedes).
 */
async function atualizarTarefaPorReserva(reservaId, smoobuPropId, dataTarefaRaw, detalhesReserva, content) {
  if (!reservaId) {
    console.log('ℹ️  Update sem reservaId — sem ação.');
    return null;
  }

  const tarefa = await Tarefa.findOne({ smoobu_reserva_id: reservaId });
  if (!tarefa) {
    // Sem tarefa existente → o dispatcher cai para o fluxo de criação.
    return null;
  }

  // Já concluída → mantém (trabalho já feito, editar não faz sentido).
  if (tarefa.estado === 'concluida') {
    console.log(
      `⚠️  Reserva ${reservaId} atualizada mas tarefa ${tarefa._id} já estava concluída — mantém estado.`
    );
    return tarefa;
  }

  let mudou = false;
  let mudouData = false;
  let novoRange = null;

  // 1) Atualizar data da tarefa (check-out ou fallback check-in).
  if (dataTarefaRaw) {
    novoRange = getDayRange(dataTarefaRaw);
    if (novoRange && tarefa.data.getTime() !== novoRange.start.getTime()) {
      tarefa.data = novoRange.start;
      mudou = true;
      mudouData = true;
    }
  }

  // 2) Atualizar propriedade (se o apartamento foi trocado).
  if (smoobuPropId) {
    const propriedade = await Propriedade.findOne({ smoobu_id: smoobuPropId });
    if (propriedade) {
      if (String(tarefa.propriedade_id) !== String(propriedade._id)) {
        tarefa.propriedade_id = propriedade._id;
        tarefa.empresa_id = propriedade.empresa_id;
        mudou = true;
      }
      // Atualiza tempo de limpeza (pode variar por propriedade).
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

  // 3) Re-activar se estava cancelada (a reserva foi re-activada no Smoobu).
  if (tarefa.estado === 'cancelada') {
    tarefa.estado = tarefa.utilizador_id ? 'atribuida' : 'por_atribuir';
    mudou = true;
  }

  // 3.b) Prompt 93 (Fase 1.5) — Atualiza os detalhes_reserva (checkin,
  //      checkout, pax, nome_hospede) com os dados mais recentes do Smoobu.
  if (detalhesReserva) {
    tarefa.detalhes_reserva = detalhesReserva;
    mudou = true;
  }

  // 4) Se a data mudou, reavalia a atribuição.
  //    Mantém o funcionário atual se ainda for disponível no novo dia;
  //    caso contrário, passa a 'por_atribuir' (o Admin reatribui).
  if (mudouData && tarefa.utilizador_id && novoRange) {
    const utilizador = await Utilizador.findById(tarefa.utilizador_id).lean();
    const diaSemana = novoRange.start.getDay();

    let disponivel = !!(utilizador && utilizador.ativo && !utilizador.eliminado_em);

    // Filtro de folgas fixas semanais.
    if (disponivel && Array.isArray(utilizador.dias_folga) && utilizador.dias_folga.includes(diaSemana)) {
      disponivel = false;
    }

    // Filtro de ausências (férias/baixa).
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
      console.log(
        `↪️  Funcionário atual não disponível no novo dia — tarefa ${tarefa._id} passa a 'por_atribuir'.`
      );
      tarefa.utilizador_id = null;
      if (tarefa.estado === 'atribuida' || tarefa.estado === 'em_curso') {
        tarefa.estado = 'por_atribuir';
      }
    }
  }

  if (mudou) {
    await tarefa.save();
    console.log(`✏️  Tarefa ${tarefa._id} atualizada (reserva ${reservaId} editada no Smoobu).`);
  } else {
    console.log(`ℹ️  Update da reserva ${reservaId} sem alterações na tarefa ${tarefa._id}.`);
  }

  return tarefa;
}

/* ------------------------------------------------------------------ */
/* Handler do endpoint                                                */
/* ------------------------------------------------------------------ */

/**
 * POST /webhooks/smoobu
 *
 * Responde 200 OK IMEDIATAMENTE ao Smoobu e processa a lógica de forma
 * assíncrona (fire-and-forget) para evitar timeouts no Smoobu.
 *
 * v1.12.0 — WebhookLog (idempotência + auditoria):
 *   Antes de devolver o 200, guarda o payload bruto num WebhookLog com
 *   status 'recebido'. No bloco assíncrono (setImmediate), atualiza o log
 *   para 'processado' se tudo correr bem, ou 'erro' com a mensagem se falhar.
 *   Isto permite saber quantos webhooks foram recebidos vs processados vs
 *   com erro, e reproccessar manualmente os que falharam.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
exports.webhookSmoobu = async (req, res) => {
  // 1) Guarda o payload bruto no WebhookLog com status 'recebido'.
  //    Fazemos isto ANTES de devolver o 200 para garantir que o payload
  //    nunca se perde, mesmo que o processamento assíncrono falhe.
  //    Prompt 140 — Tenta resolver empresa_id a partir do payload (best-effort).
  let webhookLog = null;
  let empresaIdLog = null;
  try {
    // Extrai o smoobuPropId do payload (mesma lógica do extrairDadosReserva).
    const dados = extrairDadosReserva(req.body);
    if (dados.smoobuPropId) {
      const Propriedade = require('../models/Propriedade');
      const prop = await Propriedade.findOne({ smoobu_id: String(dados.smoobuPropId) }).select('empresa_id').lean();
      if (prop) empresaIdLog = prop.empresa_id;
    }
  } catch (e) {
    // Best-effort — se falhar, o log fica sem empresa_id (null).
  }
  try {
    webhookLog = await WebhookLog.create({
      payload: req.body,
      status: 'recebido',
      empresa_id: empresaIdLog,
    });
  } catch (err) {
    console.error('⚠️  Erro ao guardar WebhookLog (payload será perdido):', err.message);
    // Não interrompemos o fluxo — o Smoobu precisa do 200.
  }

  // 2) Resposta imediata — NÃO esperamos pelo processamento.
  res.status(200).json({ status: 'recebido' });

  // 3) Processamento assíncrono com tratamento de erros robusto.
  //    Atualiza o WebhookLog conforme o resultado.
  setImmediate(async () => {
    try {
      const resultado = await processarReservaSmoobu(req.body);

      // Sucesso → atualiza log para 'processado'.
      // (inclui o caso de webhook duplicado ou action ignorada — não é erro)
      // Prompt 140 — Se a empresa não foi resolvida antes, tenta novamente
      // a partir do resultado (que pode ter a propriedade populada).
      if (webhookLog) {
        const updateLog = { status: 'processado', erro_msg: null };
        if (!empresaIdLog && resultado?.empresa_id) {
          updateLog.empresa_id = resultado.empresa_id;
        }
        await WebhookLog.findByIdAndUpdate(webhookLog._id, updateLog);
      }
      // resultado pode ser null (action ignorada) ou a tarefa (criada/existente)
      return resultado;
    } catch (err) {
      console.error('❌ Erro no processamento do webhook Smoobu:', err.message);

      // Erro → atualiza log para 'erro' com a mensagem.
      if (webhookLog) {
        await WebhookLog.findByIdAndUpdate(webhookLog._id, {
          status: 'erro',
          erro_msg: err.message,
        });
      }
    }
  });
};

// Exporta a função de processamento para permitir reproccessamento manual
// a partir do painel de admin (POST /api/admin/webhooks/:id/reprocessar).
exports._processarReservaSmoobu = processarReservaSmoobu;

// v1.63.0 (Prompt 86) — Exporta o load balancer para a auto-atribuição em
// lote do tarefaController (POST /api/gestor/tarefas/auto-atribuir).
exports._determinarUtilizadorAtribuido = determinarUtilizadorAtribuido;

// Prompt 137 — Exporta o enriquecimento para o backfill de nomes de hóspedes
// (POST /api/admin/backfill-nomes-hospedes).
exports.enriquecerReservaSmoobu = enriquecerReservaSmoobu;
