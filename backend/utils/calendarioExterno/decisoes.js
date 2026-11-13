/**
 * Decisões sobre períodos e ligações de calendário — All2gether.
 *
 *  - Confirmar um período «por confirmar» (cria a reserva e a limpeza) ou marcá-lo como bloqueio
 *    (fica ignorado e não volta a perguntar), reabrir um bloqueio, e o gestor pode decidir pelo proprietário.
 *  - Reserva sincronizada apagada: cancela a limpeza e o período passa a bloqueio.
 *  - Remover a ligação: cancela as limpezas futuras (ainda não iniciadas) que vieram dessa ligação.
 */
const mongoose = require('mongoose');
const ReservaExterna = require('../../models/ReservaExterna');
const ReservaManual = require('../../models/ReservaManual');
const FonteCalendario = require('../../models/FonteCalendario');
const Propriedade = require('../../models/Propriedade');
const Tarefa = require('../../models/Tarefa');
const H = require('../horario');
const R = require('../reservasParceiro');
const { estadoDaCasa } = require('../casaAtiva');
const Rv = require('./reservas');
const { avisarParceiro, avisarGestor } = require('./avisos');
const { mesmaEstadia } = require('./reconciliar');
const { promoverDuplicada, perguntarIncertas } = require('./promocao');

const resp = (status, body) => ({ status, body });
const hist = (ex, evento, de = '', para = '') => {
  ex.historico.push({ em: new Date(), evento, de, para });
  if (ex.historico.length > 30) ex.historico = ex.historico.slice(-30);
};
const quemDecidiu = (ator) => (ator && ator.tipo === 'gestor' ? 'gestor' : 'parceiro');

/** Filtro de acesso: o proprietário só vê as dele; o gestor as da empresa. */
function filtroAcesso({ empresaId, parceiroId = null }) {
  return { empresa_id: empresaId, ...(parceiroId ? { parceiro_id: parceiroId } : {}) };
}

async function confirmarExterna({ externaId, empresaId, parceiroId = null, ator, dados = {} }) {
  if (!mongoose.isValidObjectId(externaId)) return resp(400, { erro: 'ID inválido.' });
  const hoje = H.hojeLisboa();
  const erroHN = R.erroHospedesENome(dados);
  if (erroHN) return resp(400, { erro: erroHN });
  // findOneAndUpdate atómico: dois cliques só confirmam uma vez.
  const ex = await ReservaExterna.findOneAndUpdate(
    { _id: externaId, ...filtroAcesso({ empresaId, parceiroId }), estado: 'por_confirmar' },
    { $set: { estado: 'confirmada', decidido_por: quemDecidiu(ator), decidido_por_id: ator.id, decidido_em: new Date(), motivo: null } },
    { new: true }
  );
  if (!ex) {
    const existe = await ReservaExterna.exists({ _id: externaId, ...filtroAcesso({ empresaId, parceiroId }) });
    return existe ? resp(409, { erro: 'Este período já foi tratado.' }) : resp(404, { erro: 'Período não encontrado.' });
  }
  const reverter = async () => { await ReservaExterna.updateOne({ _id: ex._id }, { $set: { estado: 'por_confirmar' } }); };
  if (Rv.iso(ex.check_out) < hoje) { await reverter(); return resp(400, { erro: 'Este período já terminou.' }); }
  const casa = await estadoDaCasa(ex.propriedade_id);
  if (casa.inativa) { await reverter(); return resp(409, { erro: casa.mensagem, codigo: 'CASA_INATIVA' }); }
  const fonte = await FonteCalendario.findById(ex.fonte_id).select('rotulo').lean();
  const d = dados || {};
  const extras = {};
  for (const k of ['hospedes', 'tipo_limpeza', 'nome_hospede', 'horario_preferido', 'observacoes']) if (d[k] !== undefined && d[k] !== null && d[k] !== '') extras[k] = d[k];
  const r = await Rv.criarReservaDaExterna(ex, {
    rotulo: fonte && fonte.rotulo, extras,
    ator: ator.tipo === 'gestor' ? { tipo: 'gestor', id: ator.id } : { tipo: 'parceiro' },
  });
  if (!r.ok) { await reverter(); return resp(r.status && r.status < 500 ? r.status : 400, { erro: r.erro }); }
  ex.reserva_manual_id = r.reserva._id;
  hist(ex, 'confirmada', 'por_confirmar', quemDecidiu(ator));
  await ex.save();
  // As por confirmar de outros canais com a mesma estadia deixam de ser perguntadas.
  const outras = await ReservaExterna.find({ propriedade_id: ex.propriedade_id, _id: { $ne: ex._id }, estado: 'por_confirmar', check_out: { $gte: Rv.dataDe(hoje) } });
  for (const o of outras) {
    if (mesmaEstadia({ ci: Rv.iso(o.check_in), co: Rv.iso(o.check_out) }, { ci: Rv.iso(ex.check_in), co: Rv.iso(ex.check_out) })) {
      o.estado = 'duplicada'; o.duplicada_de = { tipo: 'reserva_externa', id: ex._id }; hist(o, 'duplicada'); await o.save();
    }
  }
  return resp(200, { externa: ex, reserva: r.reserva, tarefa: r.tarefa, ...(r.aviso ? { aviso: r.aviso } : {}) });
}

async function marcarBloqueio({ externaId, empresaId, parceiroId = null, ator }) {
  if (!mongoose.isValidObjectId(externaId)) return resp(400, { erro: 'ID inválido.' });
  const ex = await ReservaExterna.findOneAndUpdate(
    { _id: externaId, ...filtroAcesso({ empresaId, parceiroId }), estado: 'por_confirmar' },
    { $set: { estado: 'bloqueio', motivo: null, decidido_por: quemDecidiu(ator), decidido_por_id: ator.id, decidido_em: new Date() }, $push: { historico: { $each: [{ em: new Date(), evento: 'bloqueio', de: 'por_confirmar', para: quemDecidiu(ator) }], $slice: -30 } } },
    { new: true }
  );
  if (!ex) {
    const existe = await ReservaExterna.exists({ _id: externaId, ...filtroAcesso({ empresaId, parceiroId }) });
    return existe ? resp(409, { erro: 'Este período já foi tratado.' }) : resp(404, { erro: 'Período não encontrado.' });
  }
  return resp(200, { externa: ex });
}

async function reabrirBloqueio({ externaId, empresaId, parceiroId = null, ator }) {
  if (!mongoose.isValidObjectId(externaId)) return resp(400, { erro: 'ID inválido.' });
  const ex = await ReservaExterna.findOneAndUpdate(
    { _id: externaId, ...filtroAcesso({ empresaId, parceiroId }), estado: 'bloqueio', decidido_por: { $in: ['parceiro', 'gestor'] }, check_out: { $gte: Rv.dataDe(H.hojeLisboa()) } },
    { $set: { estado: 'por_confirmar', motivo: null, decidido_por: quemDecidiu(ator), decidido_por_id: ator.id, decidido_em: new Date() }, $push: { historico: { $each: [{ em: new Date(), evento: 'reaberta', de: 'bloqueio', para: 'por_confirmar' }], $slice: -30 } } },
    { new: true }
  );
  if (!ex) return resp(404, { erro: 'Período não encontrado (ou não é um bloqueio decidido por ti).' });
  return resp(200, { externa: ex });
}

/**
 * O proprietário/gestor «apaga» uma reserva ligada a um calendário: não se apaga (o canal voltaria a trazê-la).
 * A limpeza cancela-se, a reserva fica como cancelada e o período passa a bloqueio (não volta a perguntar).
 */
async function desligarReservaSincronizada({ reserva, tarefa, ator, parceiroId, avisar }) {
  const ex = reserva.reserva_externa_id ? await ReservaExterna.findById(reserva.reserva_externa_id) : null;
  const dataLimpeza = tarefa ? tarefa.data : null;
  let cancelou = false;
  if (tarefa && tarefa.estado !== 'cancelada') {
    const prop = await Propriedade.findById(reserva.propriedade_id).select('nome').lean();
    cancelou = await R.largarTarefaDaReserva(tarefa, reserva._id, prop, 'foi cancelada (reserva eliminada).');
  }
  if (ex) {
    ex.estado = 'bloqueio'; ex.decidido_por = quemDecidiu(ator); ex.decidido_por_id = ator && ator.id; ex.decidido_em = new Date();
    hist(ex, 'bloqueio', 'confirmada', quemDecidiu(ator));
    await ex.save();
  }
  reserva.cancelada_em = new Date();
  reserva.cancelada_motivo = 'parceiro';
  reserva.sincronizada = false;
  await reserva.save();
  await avisar({ ator, parceiroId, empresaId: reserva.empresa_id, propriedadeId: reserva.propriedade_id, acao: 'apagou', datas: cancelou ? [dataLimpeza] : [] });
  return resp(200, { mensagem: 'A reserva do calendário foi cancelada e a limpeza também. Não volta a ser perguntada.', reserva });
}

/** Quantas limpezas futuras (não iniciadas) seriam canceladas se a ligação fosse removida. */
async function contarImpactoRemocao(fonte, hoje = H.hojeLisboa()) {
  const externas = await ReservaExterna.find({
    propriedade_id: fonte.propriedade_id, canal_chave: fonte.canal_chave, estado: 'confirmada', check_out: { $gt: Rv.dataDe(hoje) }, reserva_manual_id: { $exists: true },
  }).select('_id reserva_manual_id').lean();
  if (!externas.length) return { limpezas: 0, reservas: 0 };
  // As que têm a mesma estadia viva noutro canal (duplicada) passam para esse canal: não se cancelam.
  const cobertas = new Set((await ReservaExterna.find({
    propriedade_id: fonte.propriedade_id, estado: 'duplicada', classe: 'reserva', 'duplicada_de.id': { $in: externas.map((e) => e._id) },
    check_out: { $gte: Rv.dataDe(hoje) }, presente_no_feed: { $ne: false }, leituras_em_falta: { $not: { $gt: 0 } },
  }).select('duplicada_de').lean()).map((d) => String(d.duplicada_de.id)));
  externas.splice(0, externas.length, ...externas.filter((e) => !cobertas.has(String(e._id))));
  if (!externas.length) return { limpezas: 0, reservas: 0 };
  const reservas = await ReservaManual.find({ _id: { $in: externas.map((e) => e.reserva_manual_id) }, origem: 'ical', cancelada_em: null }).select('tarefa_gerada_id').lean();
  const tarefas = await Tarefa.find({ _id: { $in: reservas.map((r) => r.tarefa_gerada_id).filter(Boolean) }, estado: { $nin: ['cancelada', 'em_curso', 'concluida'] } }).select('_id').lean();
  return { limpezas: tarefas.length, reservas: reservas.length };
}

/**
 * Remove a ligação (revoga o link) e cancela as limpezas futuras, ainda não iniciadas, que vieram dela.
 * `silencioso`: sem avisos (usado quando a casa ou o proprietário desaparecem).
 */
async function removerFonte(fonte, { ator = null, silencioso = false } = {}) {
  const hoje = H.hojeLisboa();
  const externas = await ReservaExterna.find({
    propriedade_id: fonte.propriedade_id, canal_chave: fonte.canal_chave, estado: { $in: ['confirmada', 'por_confirmar', 'duplicada'] },
  });
  let canceladas = 0;
  let mantidas = 0;
  let promovidas = 0;
  const prop = await Propriedade.findById(fonte.propriedade_id).select('nome').lean();
  for (const ex of externas) {
    if (ex.estado === 'confirmada' && ex.reserva_manual_id) {
      const reserva = await ReservaManual.findById(ex.reserva_manual_id).select('origem tarefa_gerada_id').lean();
      if (reserva && reserva.origem === 'ical' && Rv.iso(ex.check_out) > hoje) {
        // A mesma estadia noutro canal (duplicada) herda a reserva e a limpeza, em vez de ficar sem limpeza.
        const promovida = await promoverDuplicada(ex, { hoje });
        if (promovida) { promovidas += 1; await ReservaExterna.deleteOne({ _id: ex._id }); continue; }
        const r = await Rv.cancelarReservaDaExterna(ex, { motivo: 'ligacao_removida', textoMotivo: 'foi cancelada (o calendário foi desligado).' });
        if (r.cancelada) { canceladas += 1; await perguntarIncertas(ex, { hoje }); } else { mantidas += 1; await ReservaManual.updateOne({ _id: ex.reserva_manual_id }, { $set: { sincronizada: false } }); }
      } else {
        // reserva do próprio proprietário (adotada) ou já passada: passa a ser uma reserva normal
        await ReservaManual.updateOne({ _id: ex.reserva_manual_id }, { $set: { sincronizada: false }, $unset: { reserva_externa_id: 1 } });
      }
    }
    await ReservaExterna.deleteOne({ _id: ex._id });
  }
  const agora = new Date();
  await FonteCalendario.updateOne({ _id: fonte._id }, {
    $set: { removida: true, removida_em: agora, ...(ator && ator.id ? { removida_por: ator.id } : {}), apagar_apos: new Date(agora.getTime() + 30 * 86400000), estado: 'pausada', motivo_estado: ator && ator.tipo === 'gestor' ? 'pelo_gestor' : 'pelo_parceiro' },
    $unset: { url_cifrada: 1, url_hash: 1 },
  });
  if (!silencioso && canceladas > 0) {
    const casa = (prop && prop.nome) || 'uma casa';
    const txt = `O calendário ${fonte.rotulo || fonte.canal} de ${casa} foi desligado: ${canceladas === 1 ? '1 limpeza futura foi cancelada' : `${canceladas} limpezas futuras foram canceladas`}.`;
    await avisarParceiro(fonte.parceiro_id, fonte.empresa_id, txt);
    await avisarGestor(fonte.empresa_id, 'Calendário externo desligado', txt);
  }
  return { canceladas, mantidas, promovidas };
}

module.exports = { confirmarExterna, marcarBloqueio, reabrirBloqueio, desligarReservaSincronizada, contarImpactoRemocao, removerFonte };
