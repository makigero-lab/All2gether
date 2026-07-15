/**
 * Scheduler — Autocell
 *
 * Utilitário partilhado com a lógica de cálculo de horário de tarefas:
 *   - Tempo de viagem (Haversine, 30 km/h urbano)
 *   - Scheduler sequencial: nova tarefa após fim da última + viagem
 *   - Proteção de hora de almoço (13:00-14:00 local PT = 12:00-13:00 UTC)
 *
 * Usado por:
 *   - webhookController.js (criação de tarefas via Smoobu)
 *   - tarefaController.js (reatribuição inteligente — Prompt 75)
 *
 * Extraído do webhookController.js em v1.53.0 para evitar duplicação.
 */

const Tarefa = require('../models/Tarefa');

/**
 * Capacidade máxima diária por utilizador (8 horas = 480 minutos).
 * Se a carga total (limpeza + viagem + nova tarefa) exceder este valor,
 * o utilizador é excluído do load balancer.
 */
const CAPACIDADE_MAXIMA_MINUTOS = 480;

/**
 * Calcula o tempo de viagem entre duas coordenadas usando a Fórmula de
 * Haversine (distância em linha reta) e uma velocidade média urbana de
 * 30 km/h.
 *
 * Prompt 138 (136 V2) — Cap de GPS:
 *   O motor de geocoding estava a devolver viagens de 5h (300 min) quando
 *   as coordenadas estavam erradas ou as propriedades ficavam muito longe.
 *   Impõe-se um teto máximo de 60 minutos (1h) — tempoViagem = Math.min(tempo, 60).
 *   Se o cálculo der erro (coordenadas inválidas/NaN), assume 30 min como
 *   fallback razoável (tempo médio de deslocação urbana).
 *
 * @param {{ lat: number, lng: number } | null} coordA
 * @param {{ lat: number, lng: number } | null} coordB
 * @returns {number} tempo de viagem em minutos (capped a 60, fallback 30)
 */
function calcularTempoViagem(coordA, coordB) {
  // Prompt 138 (136 V2) — Se alguma coordenada for inválida, assume 30 min
  // (fallback razoável para deslocação urbana). Antes devolvia 0, o que
  // fazia o scheduler subestimar a carga e atribuir tarefas impossíveis.
  if (!coordA || !coordB || coordA.lat == null || coordA.lng == null ||
      coordB.lat == null || coordB.lng == null) {
    return 30;
  }

  // Validação de NaN (coordenadas corrompidas).
  if (Number.isNaN(coordA.lat) || Number.isNaN(coordA.lng) ||
      Number.isNaN(coordB.lat) || Number.isNaN(coordB.lng)) {
    return 30;
  }

  const R = 6371; // raio da Terra em km
  const dLat = ((coordB.lat - coordA.lat) * Math.PI) / 180;
  const dLng = ((coordB.lng - coordA.lng) * Math.PI) / 180;
  const lat1 = (coordA.lat * Math.PI) / 180;
  const lat2 = (coordB.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanciaKm = R * c;

  // Velocidade média urbana: 30 km/h → tempo em minutos.
  const velocidadeKmh = 30;
  const tempoHoras = distanciaKm / velocidadeKmh;
  let tempoMinutos = Math.round(tempoHoras * 60);

  // Prompt 138 (136 V2) — Cap de GPS: teto máximo de 60 min (1h).
  // Evita viagens absurdas de 5h causadas por coordenadas erradas.
  tempoMinutos = Math.min(tempoMinutos, 60);

  // Garante que é um número finito válido (fallback 30).
  if (!Number.isFinite(tempoMinutos) || tempoMinutos < 0) {
    return 30;
  }

  return tempoMinutos;
}

/**
 * Calcula o intervalo do dia (UTC meia-noite a meia-noite) de uma data.
 * @param {Date} data
 * @returns {{ start: Date, end: Date }}
 */
function obterRangeDia(data) {
  const start = new Date(
    Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate())
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Proteção de hora de almoço (13:00-14:00 local PT = UTC+1 = 12:00-13:00 UTC).
 *
 * Regra A: se o início cair no almoço, empurra para 14:00 local (13:00 UTC).
 * Regra B: se o início for antes do almoço mas o fim previsto (início +
 *   duração) ultrapassar 13:15 local, empurra para 14:00 (não partir a
 *   limpeza a meio).
 *
 * @param {Date} dataAgendada - data de início (mutada in-place)
 * @param {number} duracaoMin - duração da tarefa em minutos
 * @returns {Date} a mesma dataAgendada (eventualmente ajustada)
 */
function aplicarProtecaoAlmoco(dataAgendada, duracaoMin) {
  const inicioUTC = dataAgendada.getUTCHours() * 60 + dataAgendada.getUTCMinutes();
  const ALMOCO_INICIO = 12 * 60;          // 13:00 local = 12:00 UTC
  const ALMOCO_FIM = 13 * 60;             // 14:00 local = 13:00 UTC
  const ALMOCO_TOLERANCIA = 12 * 60 + 15; // 13:15 local = 12:15 UTC
  const fimPrevistoMin = inicioUTC + duracaoMin;

  // Regra A: início dentro do almoço → empurra para 14:00 (13:00 UTC).
  if (inicioUTC >= ALMOCO_INICIO && inicioUTC < ALMOCO_FIM) {
    dataAgendada.setUTCHours(13, 0, 0, 0);
    console.log(`🍽️ Scheduler: início no almoço → empurrado para 14:00 local`);
  }
  // Regra B: início antes do almoço mas fim ultrapassa 13:15 → empurra para 14:00.
  else if (inicioUTC < ALMOCO_INICIO && fimPrevistoMin > ALMOCO_TOLERANCIA) {
    dataAgendada.setUTCHours(13, 0, 0, 0);
    console.log(`🍽️ Scheduler: fim ultrapassa 13:15 → empurrado para 14:00 local`);
  }

  return dataAgendada;
}

/**
 * Calcula a data/hora de início de uma tarefa para um utilizador específico
 * num determinado dia, aplicando o scheduler sequencial + proteção de almoço.
 *
 * Lógica (idêntica ao webhookController.js):
 *   1. Hora base = 11:00 local (10:00 UTC) se o utilizador não tiver tarefas
 *      nesse dia.
 *   2. Se tiver tarefas, nova hora = fim da última tarefa + tempo de viagem
 *      (Haversine entre a propriedade anterior e a nova).
 *   3. Aplica proteção de almoço (13:00-14:00 local).
 *
 * @param {string|import('mongoose').Types.ObjectId} utilizadorId
 * @param {Date} dataBase - data do dia da tarefa (qualquer hora; é normalizada para o dia)
 * @param {{ lat: number, lng: number } | null} coordNovaPropriedade
 * @param {number} tempoLimpezaMin - duração da nova tarefa em minutos
 * @returns {Promise<{ data: Date, origem: string, tempoViagem: number }>}
 */
async function calcularInicioTarefaUtilizador(utilizadorId, dataBase, coordNovaPropriedade, tempoLimpezaMin) {
  const { start, end } = obterRangeDia(dataBase);

  // Hora padrão: 11:00 local (10:00 UTC).
  let dataAgendada = new Date(start);
  dataAgendada.setUTCHours(10, 0, 0, 0);

  let origem = 'padrao_11h';
  let tempoViagem = 0;

  // Procura a última tarefa do utilizador nesse dia (com coordenadas),
  // excluindo a própria tarefa em caso de reatribuição (a tarefa original
  // ainda existe na BD quando este cálculo corre — o caller pode passar
  // excluirTarefaId para a ignorar).
  // Nota: o caller deve passar já sem a tarefa atual na BD, ou usar
  // excluirTarefaId. Aqui mantemos simples: quem reatribui deve primeiro
  // desatribuir (utilizador_id = null) e depois chamar este cálculo.
  const ultimaTarefa = await Tarefa.findOne({
    utilizador_id: utilizadorId,
    data: { $gte: start, $lt: end },
    estado: { $nin: ['cancelada'] },
  })
    .populate({ path: 'propriedade_id', select: 'coordenadas nome' })
    .sort({ data: -1 })
    .lean();

  if (ultimaTarefa && ultimaTarefa.propriedade_id) {
    const fimAnterior = new Date(ultimaTarefa.data);
    fimAnterior.setMinutes(
      fimAnterior.getMinutes() + (ultimaTarefa.tempo_limpeza_minutos || 45)
    );

    const coordAnterior = ultimaTarefa.propriedade_id.coordenadas;
    tempoViagem = calcularTempoViagem(coordAnterior, coordNovaPropriedade);

    dataAgendada = new Date(fimAnterior.getTime() + tempoViagem * 60000);
    origem = 'apos_ultima_tarefa';

    console.log(
      `📅 Scheduler: tarefa agendada para ${dataAgendada.toISOString()} ` +
        `(fim anterior: ${fimAnterior.toISOString()}, viagem: ${tempoViagem}min)`
    );
  }

  // Proteção de almoço.
  aplicarProtecaoAlmoco(dataAgendada, Number(tempoLimpezaMin) || 45);

  return { data: dataAgendada, origem, tempoViagem };
}

/**
 * Calcula a carga total (minutos) de um utilizador num dia, somando
 * tempo_limpeza_minutos de todas as tarefas não-canceladas/não-concluídas.
 *
 * Usado para validar o SLA de 480 min antes de aceitar a reatribuição.
 *
 * @param {string|import('mongoose').Types.ObjectId} utilizadorId
 * @param {Date} dataBase - data do dia
 * @param {string|null} excluirTarefaId - ID de tarefa a excluir do cálculo (a que está a ser reatribuída)
 * @returns {Promise<number>} carga total em minutos
 */
async function calcularCargaDiaUtilizador(utilizadorId, dataBase, excluirTarefaId = null) {
  const { start, end } = obterRangeDia(dataBase);

  const filtro = {
    utilizador_id: utilizadorId,
    data: { $gte: start, $lt: end },
    estado: { $nin: ['cancelada', 'concluida'] },
  };
  if (excluirTarefaId) {
    filtro._id = { $ne: excluirTarefaId };
  }

  const tarefas = await Tarefa.find(filtro).select('tempo_limpeza_minutos').lean();
  return tarefas.reduce((acc, t) => acc + (t.tempo_limpeza_minutos || 0), 0);
}

module.exports = {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularTempoViagem,
  obterRangeDia,
  aplicarProtecaoAlmoco,
  calcularInicioTarefaUtilizador,
  calcularCargaDiaUtilizador,
};
