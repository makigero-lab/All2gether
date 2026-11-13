/**
 * Aviso ao gestor (sino) quando um proprietário cria, altera ou apaga uma reserva — SÓ se isso
 * mexer em limpezas das próximas 48 h (hoje e amanhã, dia de Lisboa, até ao dia em que caem
 * 48 h a contar de agora). Fora dessa janela o gestor não é incomodado: as limpezas aparecem
 * no calendário como sempre.
 *
 * Best-effort: nunca lança.
 */
const Propriedade = require('../models/Propriedade');
const H = require('./horario');
const { avisarGestores } = require('./notificar');

const HORAS_JANELA = 48;

/** O dia da limpeza (data da tarefa) cai nas próximas 48 h? */
function dentroDas48h(data, agora = new Date()) {
  if (!data) return false;
  const dia = H.diaUTC(data);
  const ultimo = H.hojeLisboa(new Date(agora.getTime() + HORAS_JANELA * 3600 * 1000));
  return dia >= H.hojeLisboa(agora) && dia <= ultimo;
}

const fmt = (data) => {
  const [, m, d] = H.diaUTC(data).split('-');
  return `${d}/${m}`;
};

const frase = (acao, casa, dias) => ({
  criou: `O proprietário criou uma reserva em ${casa}: limpeza a ${dias} (próximas 48 h).`,
  alterou: `O proprietário alterou uma reserva em ${casa}: limpeza a ${dias} (próximas 48 h).`,
  apagou: `O proprietário apagou uma reserva em ${casa}: a limpeza a ${dias} foi cancelada (próximas 48 h).`,
  reabriu: `O proprietário alterou uma reserva em ${casa} e a limpeza que cancelaste foi reaberta para ${dias} (próximas 48 h).`,
}[acao] || `O proprietário mexeu numa reserva em ${casa}: limpeza a ${dias} (próximas 48 h).`);

/**
 * @param {object} p
 * @param {*} p.empresaId
 * @param {*} p.propriedadeId
 * @param {'criou'|'alterou'|'apagou'|'reabriu'} p.acao
 * @param {Array<Date|string>} p.datas datas das limpezas mexidas (a antiga e/ou a nova)
 * @returns {Promise<boolean>} true se avisou
 */
async function avisarGestorReserva({ empresaId, propriedadeId, acao, datas, agora = new Date() }) {
  try {
    const afetadas = (datas || []).filter((d) => dentroDas48h(d, agora));
    if (afetadas.length === 0) return false;
    const prop = await Propriedade.findById(propriedadeId).select('nome').lean();
    const casa = (prop && prop.nome) || 'uma casa';
    const dias = [...new Set(afetadas.map(fmt))].join(' e ');
    await avisarGestores(
      empresaId,
      'Proprietário mexeu numa reserva',
      frase(acao, casa, dias),
      '/gestor/calendario'
    );
    return true;
  } catch (e) {
    console.error('⚠️  avisarGestorReserva:', e.message);
    return false;
  }
}

module.exports = { avisarGestorReserva, dentroDas48h };
