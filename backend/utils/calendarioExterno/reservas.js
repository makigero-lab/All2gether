/**
 * Ligação entre uma ReservaExterna e as reservas/limpezas do proprietário — All2gether.
 *
 * A reserva confirmada de um calendário é uma ReservaManual (origem 'ical') criada pelo MESMO serviço das
 * reservas manuais: a limpeza nasce, é atribuída e avisada exatamente como se o proprietário a tivesse marcado.
 */
const ReservaManual = require('../../models/ReservaManual');
const Tarefa = require('../../models/Tarefa');
const Propriedade = require('../../models/Propriedade');
const R = require('../reservasParceiro');
const { ROTULOS_CANAL } = require('./seguranca');

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const dataDe = (isoDia) => new Date(`${isoDia}T00:00:00Z`);
const fmt = (d) => iso(d).split('-').reverse().slice(0, 2).join('/');
const rotuloDoCanal = (ex) => (ex.rotulo || ROTULOS_CANAL[ex.canal] || 'calendário');
const plataformaDe = (canal, rotulo) => (canal === 'airbnb' ? 'Airbnb' : canal === 'booking' ? 'Booking.com' : canal === 'vrbo' ? 'Vrbo' : (rotulo || 'Outro canal'));

/**
 * Cria a reserva e a limpeza de uma ReservaExterna. Devolve { ok, reserva, tarefa } ou { ok:false, erro }.
 * Idempotente: se o evento já tem reserva (índice único), liga-se a ela.
 */
async function criarReservaDaExterna(ex, { rotulo = null, extras = {}, ator = null } = {}) {
  const r = await R.criarReservaComLimpeza({
    parceiroId: ex.parceiro_id,
    empresaId: ex.empresa_id,
    ator: ator || { tipo: 'ical', canalRotulo: plataformaDe(ex.canal, rotulo) },
    camposReserva: { origem: 'ical', reserva_externa_id: ex._id, sincronizada: true },
    body: {
      propriedade_id: String(ex.propriedade_id),
      check_in: iso(ex.check_in),
      check_out: iso(ex.check_out),
      tipo_limpeza: 'normal',
      plataforma: plataformaDe(ex.canal, rotulo),
      ...extras,
    },
  });
  if (r.status === 201) return { ok: true, reserva: r.body.reserva, tarefa: r.body.tarefa, aviso: r.body.aviso || null };
  if (r.status === 409 && r.body && r.body.codigo === 'EXTERNA_DUPLICADA') return { ok: true, reserva: r.body.reserva, tarefa: null };
  return { ok: false, erro: (r.body && r.body.erro) || 'Não foi possível criar a reserva.', status: r.status };
}

/**
 * Cancela a reserva (e a limpeza, se ainda não começou) de uma externa. A reserva fica na tabela do
 * proprietário como cancelada. Devolve { cancelada, conflito } (conflito = a limpeza já estava em curso/concluída).
 */
async function cancelarReservaDaExterna(ex, { motivo = 'canal', textoMotivo = 'foi cancelada (a reserva foi cancelada no calendário).' } = {}) {
  if (!ex.reserva_manual_id) return { cancelada: true, conflito: null };
  const reserva = await ReservaManual.findById(ex.reserva_manual_id);
  if (!reserva) return { cancelada: true, conflito: null };
  const tarefa = reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id) : null;
  if (tarefa && R.ESTADOS_BLOQUEADOS.includes(tarefa.estado)) {
    return { cancelada: false, conflito: tarefa.estado === 'em_curso' ? 'limpeza_em_curso' : 'limpeza_concluida', tarefa };
  }
  const propriedade = await Propriedade.findById(reserva.propriedade_id).select('nome').lean();
  if (tarefa && tarefa.estado !== 'cancelada') await R.largarTarefaDaReserva(tarefa, reserva._id, propriedade, textoMotivo);
  reserva.cancelada_em = new Date();
  reserva.cancelada_motivo = motivo;
  reserva.sincronizada = false;
  await reserva.save();
  return { cancelada: true, conflito: null, reserva, propriedade };
}

/** Atualiza as datas da reserva ligada (mesmo padrão das reservas manuais). Devolve { ok, status, erro }. */
async function mudarDatasDaReserva(ex, ci, co) {
  const r = await R.atualizarReservaServico({
    parceiroId: ex.parceiro_id,
    id: String(ex.reserva_manual_id),
    body: { check_in: ci, check_out: co },
    ator: { tipo: 'ical', canalRotulo: plataformaDe(ex.canal) },
  });
  if (r.status === 409) {
    // limpeza já começou (em curso) ou foi concluída: o conflito diz qual
    const reserva = await ReservaManual.findById(ex.reserva_manual_id).select('tarefa_gerada_id').lean();
    const tarefa = reserva && reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id).select('estado').lean() : null;
    return { ok: false, status: 409, erro: r.body && r.body.erro, conflito: tarefa && tarefa.estado === 'concluida' ? 'limpeza_concluida' : 'limpeza_em_curso' };
  }
  return { ok: r.status === 200, status: r.status, erro: r.body && r.body.erro, conflito: 'limpeza_concluida' };
}

module.exports = { criarReservaDaExterna, cancelarReservaDaExterna, mudarDatasDaReserva, iso, dataDe, fmt, rotuloDoCanal, plataformaDe };
