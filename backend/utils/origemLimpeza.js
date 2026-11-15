/**
 * De onde vem uma limpeza e se o gestor a fixou à mão (usado pelos scripts de reorganização das futuras).
 *
 * Origens: 'smoobu' (reserva do Smoobu), 'ical' (reserva importada de um calendário),
 * 'parceiro' (reserva marcada pelo próprio proprietário), 'gestor_em_nome_do_parceiro' (reserva do proprietário
 * marcada pelo gestor) e 'avulsa' (criada à mão pelo gestor, sem reserva por trás).
 */
const ORIGENS = Object.freeze(['smoobu', 'parceiro', 'gestor_em_nome_do_parceiro', 'ical', 'avulsa']);

/** Mapa tarefaId -> reserva manual/iCal que a gerou, para as tarefas dadas (uma só consulta). */
async function reservasPorTarefa(tarefas) {
  const ReservaManual = require('../models/ReservaManual');
  const ids = tarefas.map((t) => t._id);
  const reservas = await ReservaManual.find({ tarefa_gerada_id: { $in: ids } })
    .select('tarefa_gerada_id origem criada_pelo_gestor data_limpeza_ajustada').lean();
  return new Map(reservas.map((r) => [String(r.tarefa_gerada_id), r]));
}

/** Origem de uma tarefa (`reserva` = a ReservaManual ligada, se houver). */
function origemDaLimpeza(t, reserva) {
  if (typeof t.smoobu_reserva_id === 'string' && t.smoobu_reserva_id) return 'smoobu';
  if (reserva) {
    if (reserva.origem === 'ical') return 'ical';
    return reserva.criada_pelo_gestor ? 'gestor_em_nome_do_parceiro' : 'parceiro';
  }
  return 'avulsa';
}

/**
 * O gestor fixou esta limpeza à mão (a automação não lhe mexe)? Sinais que existem hoje: «mudar dia/hora»
 * (`data_ajustada_gestor`), dia posto numa data provisória (`dia_mudado_pelo_gestor`), reserva do proprietário
 * com o dia mudado pelo gestor (`data_limpeza_ajustada`) e limpeza avulsa com hora real ou com pessoa (foi ele
 * que as criou assim). Uma avulsa sem hora nem pessoa passa pela reatribuição.
 * Limite: atribuir pessoa a uma limpeza que já tinha hora não deixa marca.
 */
function fixadaPeloGestor(t, reserva, temHoraReal) {
  if (t.data_ajustada_gestor) return true;
  if (t.dia_mudado_pelo_gestor && t.dia_mudado_pelo_gestor.dia) return true;
  if (reserva && reserva.data_limpeza_ajustada) return true;
  if (origemDaLimpeza(t, reserva) === 'avulsa') {
    return !!(temHoraReal(t.data) || t.utilizador_id || (t.equipa_atribuida && t.equipa_atribuida.length));
  }
  return false;
}

module.exports = { ORIGENS, reservasPorTarefa, origemDaLimpeza, fixadaPeloGestor };
