/**
 * Promoção de uma estadia «duplicada» — All2gether.
 *
 * Quando a mesma estadia vem de dois canais (ex.: Booking confirmada + Airbnb «Reserved»), só uma tem a limpeza
 * (a «principal»); a outra fica `duplicada`. Se a principal desaparece e vai ser cancelada, a duplicada que ainda
 * está no calendário dela PASSA A PRINCIPAL: a reserva (e a limpeza, já atribuída) é TRANSFERIDA para ela, sem
 * cancelar e recriar. Se a duplicada for só um período incerto (Booking «CLOSED»), não se assume nada: passa a
 * «por confirmar» e o proprietário decide. Se também ela já desapareceu, não há nada a promover.
 */
const ReservaExterna = require('../../models/ReservaExterna');
const ReservaManual = require('../../models/ReservaManual');
const FonteCalendario = require('../../models/FonteCalendario');
const Rv = require('./reservas');

function hist(ex, evento, de = '', para = '') {
  ex.historico.push({ em: new Date(), evento, de: String(de).slice(0, 60), para: String(para).slice(0, 60) });
  if (ex.historico.length > 30) ex.historico = ex.historico.slice(-30);
}

/** As duplicadas de `ex` que ainda estão no calendário delas (não a faltar), da mais antiga para a mais recente. */
async function duplicadasVivas(ex, hoje) {
  const dups = await ReservaExterna.find({
    propriedade_id: ex.propriedade_id, estado: 'duplicada', 'duplicada_de.id': ex._id, check_out: { $gte: Rv.dataDe(hoje) },
  }).sort({ primeiro_visto_em: 1 });
  return dups.filter((d) => d.presente_no_feed !== false && !(d.leituras_em_falta > 0));
}

/**
 * Depois de a limpeza de `ex` ter sido cancelada: se só restam duplicadas INCERTAS vivas (ex.: Booking «CLOSED»),
 * a primeira passa a «por confirmar» (o proprietário decide) e as outras ficam duplicadas dela. Devolve-a (ou null).
 */
async function perguntarIncertas(ex, { hoje }) {
  const vivas = await duplicadasVivas(ex, hoje);
  if (!vivas.length) return null;
  const d = vivas[0];
  d.estado = 'por_confirmar'; d.motivo = null; d.duplicada_de = undefined; d.decidido_por = 'automatico'; d.decidido_em = new Date();
  hist(d, 'promovida', 'duplicada', 'por_confirmar');
  await d.save();
  const outras = vivas.slice(1).map((x) => x._id);
  if (outras.length) await ReservaExterna.updateMany({ _id: { $in: outras } }, { $set: { 'duplicada_de.id': d._id } });
  return d;
}

/**
 * Tenta passar a reserva de `ex` (que vai ser cancelada) para uma duplicada viva.
 * Devolve a duplicada promovida ou null (nada a promover: o chamador cancela como de costume).
 * Quando devolve 'promovida', `ex.reserva_manual_id` fica limpo (o chamador grava `ex`) e a reserva já pertence a `dup`.
 */
async function promoverDuplicada(ex, { hoje }) {
  const vivas = await duplicadasVivas(ex, hoje);
  if (!vivas.length) return null;
  const dup = vivas.find((d) => d.classe === 'reserva') || null;

  if (!dup || !ex.reserva_manual_id) return null;
  const reservaId = ex.reserva_manual_id;
  const fonte = await FonteCalendario.findById(dup.fonte_id).select('rotulo').lean();
  const antes = await ReservaManual.findById(reservaId).select('plataforma').lean();
  const mudaDatas = Rv.iso(dup.check_in) !== Rv.iso(ex.check_in) || Rv.iso(dup.check_out) !== Rv.iso(ex.check_out);

  // Transferir: a reserva passa a apontar para a duplicada (a limpeza vai com ela).
  await ReservaManual.updateOne({ _id: reservaId }, { $set: { reserva_externa_id: dup._id, sincronizada: true, plataforma: Rv.plataformaDe(dup.canal, fonte && fonte.rotulo) } });
  dup.reserva_manual_id = reservaId;
  if (mudaDatas) {
    const r = await Rv.mudarDatasDaReserva(dup, Rv.iso(dup.check_in), Rv.iso(dup.check_out));
    if (!r.ok) {
      // Não dá para acertar a reserva às datas da duplicada: desfaz e deixa o caminho normal (cancelar).
      await ReservaManual.updateOne({ _id: reservaId }, { $set: { reserva_externa_id: ex._id, plataforma: antes && antes.plataforma } });
      dup.reserva_manual_id = undefined;
      return null;
    }
  }
  dup.estado = 'confirmada'; dup.motivo = null; dup.duplicada_de = undefined; dup.decidido_por = 'automatico'; dup.decidido_em = new Date();
  hist(dup, 'promovida', 'duplicada', 'confirmada');
  await dup.save();
  ex.reserva_manual_id = undefined;
  // As outras duplicadas da mesma estadia passam a ser duplicadas da nova principal.
  await ReservaExterna.updateMany(
    { propriedade_id: ex.propriedade_id, estado: 'duplicada', 'duplicada_de.id': ex._id, _id: { $ne: dup._id } },
    { $set: { 'duplicada_de.id': dup._id } },
  );
  return dup;
}

module.exports = { promoverDuplicada, perguntarIncertas, duplicadasVivas };
