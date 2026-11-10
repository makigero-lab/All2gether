/**
 * Scheduler — All2gether
 *
 * Carrega a agenda de cada pessoa e delega as regras de horário (09:00-18:00,
 * almoço, viagens) em `horario.js`. Usado por: loadBalancer, atribuicaoAutomatica,
 * Smoobu, reatribuição do gestor, ausências e script de reparação.
 *
 * Viagens: `calcularTempoViagemReal` (Google Maps com cache e fallback de
 * 30 min sem coordenadas). Cada par de coordenadas calcula-se UMA vez por
 * planeamento (memória local) e a cache de `distancia.js` evita repetir
 * chamadas pagas entre planeamentos.
 */

const Tarefa = require('../models/Tarefa');
const { comMembro } = require('./equipaTarefa');
const { calcularTempoViagemReal } = require('./distancia');
const H = require('./horario');

/**
 * Capacidade diária como «janela do dia menos almoço» (480 min). É só um
 * pré-filtro: a decisão real é a agenda (início, fim, almoço e viagens).
 */
const CAPACIDADE_MAXIMA_MINUTOS = H.CAPACIDADE_MAXIMA_MINUTOS;

/**
 * Tempo de viagem em LINHA RETA (Haversine, 30 km/h, teto de 60 min, 30 min sem
 * coordenadas). Síncrono: serve para avisos e ecrãs; o cálculo da hora de início
 * usa `calcularTempoViagemReal` (Google Maps).
 *
 * @param {{ lat: number, lng: number } | null} coordA
 * @param {{ lat: number, lng: number } | null} coordB
 * @returns {number} minutos
 */
function calcularTempoViagem(coordA, coordB) {
  if (!coordA || !coordB || coordA.lat == null || coordA.lng == null ||
      coordB.lat == null || coordB.lng == null) {
    return 30;
  }
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

  let tempoMinutos = Math.round((distanciaKm / 30) * 60);
  tempoMinutos = Math.min(tempoMinutos, 60);
  if (!Number.isFinite(tempoMinutos) || tempoMinutos < 0) return 30;
  return tempoMinutos;
}

/**
 * Intervalo do dia (UTC meia-noite a meia-noite) de uma data (Date ou 'YYYY-MM-DD').
 * @returns {{ start: Date, end: Date }|null} null se a data for inválida.
 */
function obterRangeDia(data) {
  const d = data instanceof Date ? data : new Date(data);
  if (isNaN(d.getTime())) return null;
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const COORD_OK = (c) => c && c.lat != null && c.lng != null && !Number.isNaN(c.lat) && !Number.isNaN(c.lng);
const chaveCoord = (c) => (COORD_OK(c) ? `${Number(c.lat).toFixed(5)},${Number(c.lng).toFixed(5)}` : 'sem');

/**
 * Cria a função de viagem (síncrona) para planear `nova` contra `itens`, depois
 * de calcular, com Google Maps (ou fallback), cada coordenada distinta UMA vez.
 */
async function prepararViagens(itens, nova, dataRef) {
  const memo = new Map();
  for (const x of itens) {
    if (x.propId && nova.propId && String(x.propId) === String(nova.propId)) continue;
    const k = chaveCoord(x.coord);
    if (memo.has(k)) continue;
    const r = await calcularTempoViagemReal(
      COORD_OK(x.coord) ? x.coord : null,
      COORD_OK(nova.coord) ? nova.coord : null,
      dataRef
    );
    memo.set(k, Math.max(0, Number(r && r.minutos) || 0));
  }
  return (a, b) => {
    const outro = a.nova ? b : b.nova ? a : null;
    if (!outro) return Number(b.viagem) || 0; // par já existente: viagem gravada
    const novaRef = a.nova ? a : b;
    if (outro.propId && novaRef.propId && String(outro.propId) === String(novaRef.propId)) return 0;
    const v = memo.get(chaveCoord(outro.coord));
    return v === undefined ? 30 : v;
  };
}

/**
 * Agenda real de uma pessoa num dia: limpezas com hora real (não a meia-noite)
 * e que começam a partir das 09:00. Horas inválidas (ex.: 02:08) não contam
 * como base de cadeia. Cancelada nunca conta.
 */
async function carregarAgenda(utilizadorId, dia, excluirTarefaId = null) {
  const { start, end } = obterRangeDia(dia);
  const filtro = { data: { $gte: start, $lt: end }, estado: { $nin: ['cancelada'] } };
  if (excluirTarefaId) filtro._id = { $ne: excluirTarefaId };
  const tarefas = await Tarefa.find(comMembro(filtro, utilizadorId))
    .populate({ path: 'propriedade_id', select: 'coordenadas nome' })
    .sort({ data: 1 })
    .limit(50)
    .lean();
  return tarefas.map(itemDeTarefa).filter(Boolean);
}

/**
 * Tarefa (lean, com propriedade_id populado) -> item de agenda, ou null se não tem hora
 * real (meia-noite) ou começa antes das 09:00 (hora inválida: não serve de base de cadeia).
 */
function itemDeTarefa(t) {
  if (!H.temHoraReal(t.data)) return null;
  const ini = H.minutosLocais(t.data);
  if (ini < H.HORARIO.INICIO_DIA) return null;
  return {
    ini,
    fim: ini + (Number(t.tempo_limpeza_minutos) || 45),
    coord: t.propriedade_id && t.propriedade_id.coordenadas,
    propId: t.propriedade_id && t.propriedade_id._id,
    viagem: Number(t.tempo_viagem_minutos) || 0,
    tarefaId: t._id,
  };
}

function motivoNaoCabe(tempo) {
  return H.duracaoCabeNoHorario(tempo)
    ? 'Não cabe no horário (09:00-18:00, com almoço e viagens)'
    : `Limpeza de ${tempo} min demasiado longa para o horário (09:00-18:00, com almoço)`;
}

/**
 * Hora de início de uma limpeza para UMA pessoa (ou, com uma lista de ids, para
 * uma equipa: começa quando todos conseguem).
 *
 * @param {*|Array} utilizadorId - id, ou lista de ids (equipa)
 * @param {Date} dataBase - qualquer instante do dia
 * @param {{lat,lng}|null} coord - coordenadas da propriedade nova
 * @param {number} tempoLimpezaMin
 * @param {*} [excluirTarefaId] - tarefa a ignorar (a que está a ser reatribuída)
 * @param {*} [propId] - propriedade nova (viagem 0 entre limpezas da mesma casa)
 * @returns {Promise<{ data: Date|null, cabe: boolean, origem: string, tempoViagem: number, motivo: string|null }>}
 *   `data` é null quando não cabe no horário (nunca se inventa uma hora).
 */
async function calcularInicioTarefaUtilizador(utilizadorId, dataBase, coord, tempoLimpezaMin, excluirTarefaId = null, propId = null) {
  const range = obterRangeDia(dataBase);
  const ids = Array.isArray(utilizadorId) ? utilizadorId : [utilizadorId];
  const tempo = Number(tempoLimpezaMin) || 45;
  const dia = range.start.toISOString().slice(0, 10);
  const nova = { duracao: tempo, coord, propId };

  const agendas = [];
  for (const id of ids) agendas.push(await carregarAgenda(id, range.start, excluirTarefaId));
  const viagemFn = await prepararViagens(agendas.flat(), { ...nova, nova: true }, range.start);

  const ini = ids.length > 1
    ? H.primeiroInicioEquipa(agendas, nova, viagemFn)
    : H.primeiroInicio(agendas[0], nova, viagemFn);
  if (ini === null) {
    return { data: null, cabe: false, origem: 'sem_horario', tempoViagem: 0, motivo: motivoNaoCabe(tempo) };
  }
  // Viagem até esta limpeza: a maior, entre os membros, da limpeza anterior à nova.
  let tempoViagem = 0;
  let houveAnterior = false;
  for (const ag of agendas) {
    const ant = [...ag].sort((a, b) => b.fim - a.fim).find((x) => x.fim <= ini);
    if (ant) {
      houveAnterior = true;
      tempoViagem = Math.max(tempoViagem, viagemFn(ant, { ...nova, nova: true }));
    }
  }
  return {
    data: H.utcDeMinutosLocais(dia, ini),
    cabe: true,
    origem: houveAnterior ? 'apos_ultima_tarefa' : 'inicio_do_dia',
    tempoViagem,
    motivo: null,
  };
}

/** Equipa: começa quando todos os membros conseguem. */
function calcularInicioEquipa(ids, dataBase, coord, tempoLimpezaMin, excluirTarefaId = null, propId = null) {
  return calcularInicioTarefaUtilizador(ids, dataBase, coord, tempoLimpezaMin, excluirTarefaId, propId);
}

/**
 * Carga (minutos de limpeza) de um utilizador num dia. Só informativa: a decisão
 * de «cabe» é `calcularInicioTarefaUtilizador`.
 */
async function calcularCargaDiaUtilizador(utilizadorId, dataBase, excluirTarefaId = null) {
  const { start, end } = obterRangeDia(dataBase);
  const filtro = comMembro({
    data: { $gte: start, $lt: end },
    estado: { $nin: ['cancelada', 'concluida'] },
  }, utilizadorId);
  if (excluirTarefaId) filtro._id = { $ne: excluirTarefaId };
  const tarefas = await Tarefa.find(filtro).select('tempo_limpeza_minutos').lean();
  return tarefas.reduce((acc, t) => acc + (t.tempo_limpeza_minutos || 0), 0);
}

module.exports = {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularTempoViagem,
  obterRangeDia,
  carregarAgenda,
  itemDeTarefa,
  prepararViagens,
  calcularInicioTarefaUtilizador,
  calcularInicioEquipa,
  calcularCargaDiaUtilizador,
  motivoNaoCabe,
};
