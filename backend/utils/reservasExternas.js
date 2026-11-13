/**
 * Reservas «não criadas pelo proprietário» que aparecem na tabela de Reservas dele — SÓ DE LEITURA.
 *
 * A tabela do proprietário mostra apenas RESERVAS das casas dele: as que ele marca (ReservaManual)
 * e as que lhe chegam de fora. Hoje só a origem Smoobu está implementada (uma linha por reserva
 * Smoobu, mesmo com várias tarefas). O iCal e as reservas marcadas pelo gestor em nome do
 * proprietário entram depois: basta acrescentar uma função a ORIGENS que devolva linhas no mesmo
 * formato (ver `linhaDeReserva`); o resto (API, ecrã, Excel) não muda.
 *
 * Nunca entram limpezas avulsas do gestor nem manutenções. Nada de dados de hóspedes além do n.º.
 */
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { tipoDe } = require('./tipoLimpeza');

const DIAS_PARA_TRAS = 30; // reservas com check-out há mais de 30 dias deixam de se mostrar
const MAX_LINHAS = 500;

const TEXTO_ORIGEM = { smoobu: 'Smoobu' };

/** Formato único de uma linha (qualquer origem). */
function linhaDeReserva({ id, origem, casa, data, estado, tipo_limpeza, check_in, check_out, hospedes }) {
  const n = hospedes === null || hospedes === undefined ? NaN : Number(hospedes);
  return {
    _id: String(id),
    origem,
    origem_texto: TEXTO_ORIGEM[origem] || origem,
    propriedade: { _id: String(casa._id), nome: casa.nome || 'Casa', morada: casa.morada || null },
    data,
    estado,
    tipo_limpeza,
    check_in: check_in || null,
    check_out: check_out || null,
    hospedes: Number.isFinite(n) ? n : null,
    somente_leitura: true,
  };
}

/** Das tarefas da mesma reserva, a que representa a limpeza: a mais recente que não está cancelada. */
function tarefaPrincipal(tarefas) {
  const vivas = tarefas.filter((t) => t.estado !== 'cancelada');
  const lista = vivas.length ? vivas : tarefas;
  return lista.reduce((a, b) => (new Date(b.data) > new Date(a.data) ? b : a));
}

async function reservasSmoobu(casas, casaPorId, agora) {
  const desde = new Date(agora.getTime() - DIAS_PARA_TRAS * 86400000);
  const tarefas = await Tarefa.find({
    propriedade_id: { $in: casas.map((c) => c._id) },
    tipo: 'limpeza',
    origem_parceiro: { $ne: true },
    $or: [{ origem: 'smoobu' }, { smoobu_reserva_id: { $nin: [null, ''] } }],
    data: { $gte: desde },
  })
    .select('propriedade_id data estado origem smoobu_reserva_id tipo_limpeza detalhes_reserva hospedes')
    .sort({ data: -1 })
    .limit(MAX_LINHAS * 3)
    .lean();

  // Uma linha por reserva Smoobu: casa + id da reserva; sem id, casa + check-in + check-out; sem nada
  // disso, a tarefa conta como uma reserva.
  const grupos = new Map();
  for (const t of tarefas) {
    const det = t.detalhes_reserva || {};
    const chave = t.smoobu_reserva_id
      ? `${t.propriedade_id}|id|${t.smoobu_reserva_id}`
      : det.checkin && det.checkout
        ? `${t.propriedade_id}|datas|${det.checkin}|${det.checkout}`
        : `t|${t._id}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(t);
  }
  return [...grupos.values()].slice(0, MAX_LINHAS).map((grupo) => {
    const t = tarefaPrincipal(grupo);
    const comDatas = grupo.find((x) => x.detalhes_reserva && (x.detalhes_reserva.checkin || x.detalhes_reserva.checkout)) || t;
    const d = comDatas.detalhes_reserva || {};
    const comPax = grupo.find((x) => x.detalhes_reserva?.pax || x.hospedes) || t;
    return linhaDeReserva({
      id: t._id,
      origem: 'smoobu',
      casa: casaPorId.get(String(t.propriedade_id)) || { _id: t.propriedade_id },
      data: t.data,
      estado: t.estado,
      tipo_limpeza: tipoDe(t),
      check_in: d.checkin,
      check_out: d.checkout,
      hospedes: comPax.detalhes_reserva?.pax ?? comPax.hospedes ?? null,
    });
  });
}

/** Origens que entram na lista. Acrescentar aqui o iCal e as reservas marcadas pelo gestor. */
const ORIGENS = [reservasSmoobu];

/**
 * @param {*} parceiroId
 * @param {Date} [agora]
 * @returns {Promise<Array<object>>} linhas só de leitura, da mais recente para a mais antiga
 */
async function listarReservasExternas(parceiroId, agora = new Date()) {
  const casas = await Propriedade.find({ parceiro_id: parceiroId }).select('_id nome morada').lean();
  if (casas.length === 0) return [];
  const casaPorId = new Map(casas.map((c) => [String(c._id), c]));
  const listas = await Promise.all(ORIGENS.map((f) => f(casas, casaPorId, agora)));
  return listas.flat().sort((a, b) => new Date(b.data) - new Date(a.data));
}

module.exports = { listarReservasExternas, DIAS_PARA_TRAS };
