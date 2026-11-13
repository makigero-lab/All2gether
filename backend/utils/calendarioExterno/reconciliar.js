/**
 * Comparação do calendário lido com o estado guardado — All2gether.
 *
 * Corre dentro do lock da casa. Cria, atualiza e (depois de várias leituras seguidas) cancela, segundo as
 * regras do desenho: UID conhecido/novo/trocado, deduplicação por «mesma estadia» (sobreposição com o mesmo
 * dia de saída; um bloqueio do Airbnb nunca deduplica), datas alteradas, faltas e cancelamento.
 * Nada aqui corre com o calendário a falhar ou suspeito: as faltas só contam em leituras limpas.
 */
const ReservaExterna = require('../../models/ReservaExterna');
const ReservaManual = require('../../models/ReservaManual');
const H = require('../horario');
const Rv = require('./reservas');
const Tarefa = require('../../models/Tarefa');
const { dentroDas48h } = require('../avisoGestorReserva');
const { promoverDuplicada, perguntarIncertas } = require('./promocao');

const NOITES_PERIODO_LONGO = 30;
const DIAS_RETENCAO = 90;

const sobrepoe = (a, b) => a.ci < b.co && b.ci < a.co;
const mesmaEstadia = (a, b) => sobrepoe(a, b) && a.co === b.co;
const apagarApos = (coISO) => new Date(Date.parse(`${coISO}T00:00:00Z`) + DIAS_RETENCAO * 86400000);

function hist(ex, evento, de = '', para = '') {
  ex.historico.push({ em: new Date(), evento, de: String(de).slice(0, 60), para: String(para).slice(0, 60) });
  if (ex.historico.length > 30) ex.historico = ex.historico.slice(-30);
}

/**
 * @param {object} c contexto
 * @param {object} c.fonte documento da fonte
 * @param {object} c.propriedade { _id, nome, empresa_id, parceiro_id }
 * @param {Array|null} c.eventos eventos lidos (null = 304: sem conteúdo novo)
 * @param {boolean} c.suspeita leitura suspeita: não conta faltas
 * @param {boolean} [c.semNovos] leitura com reservas novas a mais: não cria nenhuma reserva/período novo
 * @param {string} c.hoje 'aaaa-mm-dd'
 * @param {Date} c.agora
 * @param {{leiturasParaCancelar:number, horasMinimasFalta:number, horasFeedVazio?:number}} c.cfg
 * @returns {Promise<{alteracoes: object, avisos: {parceiro: string[], gestor: string[]}}>}
 */
async function reconciliar({ fonte, propriedade, eventos, suspeita, hoje, agora, cfg, semNovos = false }) {
  const alt = { criadas: 0, confirmadas_auto: 0, por_confirmar: 0, datas_alteradas: 0, faltas_contadas: 0, canceladas: 0, promovidas: 0, reaparecidas: 0, duplicadas: 0, uid_trocados: 0, conflitos: 0 };
  const avisos = { parceiro: [], gestor: [] };
  const casa = propriedade.nome || 'a casa';
  const rotulo = fonte.canal === 'outro' ? (fonte.rotulo || 'Outro canal') : Rv.plataformaDe(fonte.canal);

  const externas = await ReservaExterna.find({ propriedade_id: propriedade._id, canal_chave: fonte.canal_chave });
  const porUid = new Map(externas.map((x) => [x.uid, x]));
  const outras = await ReservaExterna.find({
    propriedade_id: propriedade._id, canal_chave: { $ne: fonte.canal_chave }, estado: { $in: ['confirmada', 'por_confirmar'] }, check_out: { $gte: Rv.dataDe(hoje) },
  });
  const manuais = await ReservaManual.find({
    propriedade_id: propriedade._id, check_out: { $gte: Rv.dataDe(hoje) }, cancelada_em: null, reserva_externa_id: { $exists: false },
  }).select('_id check_in check_out reserva_externa_id').lean();

  // Cobertura válida para deduplicar: reservas confirmadas de OUTRO canal e reservas manuais. Nunca bloqueios.
  const cobertura = [
    ...outras.filter((o) => o.estado === 'confirmada').map((o) => ({ tipo: 'reserva_externa', id: o._id, ci: Rv.iso(o.check_in), co: Rv.iso(o.check_out) })),
    ...manuais.map((m) => ({ tipo: 'reserva_manual', id: m._id, ci: Rv.iso(m.check_in), co: Rv.iso(m.check_out) })),
  ];
  const novaCobertura = (ex) => cobertura.push({ tipo: 'reserva_externa', id: ex._id, ci: Rv.iso(ex.check_in), co: Rv.iso(ex.check_out), propria: true });
  // Reservas confirmadas desta mesma fonte também deduplicam as seguintes (mesma leitura).
  for (const x of externas) if (x.estado === 'confirmada' && Rv.iso(x.check_out) >= hoje) novaCobertura(x);

  const vistos = new Set();
  const viraBloqueio = new Set();
  const lista = eventos || [];
  const uidsDoFeed = new Set(lista.map((e) => e.uid));
  const ausentesAntes = externas.filter((x) => !uidsDoFeed.has(x.uid) && x.estado !== 'substituida');

  const decidirNovo = (ev, ignorarId = null) => {
    if (ev.classe === 'bloqueio') return { estado: 'bloqueio', decidido_por: 'automatico' };
    const cand = cobertura.filter((c) => !ignorarId || String(c.id) !== String(ignorarId));
    const mesma = cand.find((c) => mesmaEstadia(c, ev));
    const conflito = cand.find((c) => sobrepoe(c, ev) && c.co !== ev.co);
    if (ev.classe === 'reserva') {
      if (mesma && mesma.tipo === 'reserva_manual') return { estado: 'confirmada', adotar: mesma.id };
      if (mesma) return { estado: 'duplicada', duplicada_de: { tipo: mesma.tipo, id: mesma.id } };
      if (conflito) return { estado: 'por_confirmar', motivo: 'sobreposicao' };
      return { estado: 'confirmada', criar: true };
    }
    if (mesma) return { estado: 'duplicada', duplicada_de: { tipo: mesma.tipo, id: mesma.id } };
    if (conflito) return { estado: 'por_confirmar', motivo: 'sobreposicao' };
    return { estado: 'por_confirmar', motivo: ev.noites > NOITES_PERIODO_LONGO ? 'periodo_longo' : null };
  };

  /** Aplica a decisão a um documento (criando a reserva se for caso disso). */
  const aplicar = async (ex, ev, d) => {
    ex.estado = d.estado;
    ex.motivo = d.motivo || null;
    ex.decidido_por = 'automatico';
    ex.decidido_em = agora;
    ex.duplicada_de = d.duplicada_de || undefined;
    if (d.adotar) {
      await ReservaManual.updateOne({ _id: d.adotar }, { $set: { reserva_externa_id: ex._id, sincronizada: true } });
      ex.reserva_manual_id = d.adotar;
      hist(ex, 'confirmada', 'adotada', 'manual');
      avisos.parceiro.push(`A tua reserva de ${ev.ci.slice(8)}/${ev.ci.slice(5, 7)} a ${ev.co.slice(8)}/${ev.co.slice(5, 7)} em ${casa} passou a ser atualizada pelo ${rotulo}.`);
      novaCobertura(ex);
    }
    await ex.save();
    if (d.criar) {
      const r = await Rv.criarReservaDaExterna(ex, { rotulo: fonte.rotulo });
      if (r.ok) {
        ex.reserva_manual_id = r.reserva._id;
        hist(ex, 'criada', '', 'confirmada');
        alt.criadas += 1; alt.confirmadas_auto += 1;
        novaCobertura(ex);
        // as por confirmar de outros canais com a mesma estadia deixam de ser perguntadas
        for (const o of outras) {
          if (o.estado === 'por_confirmar' && mesmaEstadia({ ci: Rv.iso(o.check_in), co: Rv.iso(o.check_out) }, ev)) {
            o.estado = 'duplicada'; o.duplicada_de = { tipo: 'reserva_externa', id: ex._id }; hist(o, 'duplicada'); await o.save(); alt.duplicadas += 1;
          }
        }
      } else {
        // Não foi possível criar a limpeza: fica por confirmar para o proprietário decidir (e o aviso diz porquê).
        ex.estado = 'por_confirmar'; ex.motivo = null;
        avisos.parceiro.push(`Não foi possível criar a limpeza de ${ev.co.slice(8)}/${ev.co.slice(5, 7)} em ${casa}: ${r.erro}`);
      }
      await ex.save();
    } else if (d.estado === 'duplicada') alt.duplicadas += 1;
    else if (d.estado === 'por_confirmar') alt.por_confirmar += 1;
  };

  const ordenados = [...lista].sort((a, b) => (a.ci < b.ci ? -1 : 1));
  for (const ev of ordenados) {
    const conhecido = porUid.get(ev.uid);
    vistos.add(ev.uid);

    if (conhecido) {
      const ex = conhecido;
      // Reserva que passou a bloqueio com o mesmo UID (relatos de cancelamentos no Airbnb): conta como falta.
      if (ex.classe === 'reserva' && ev.classe === 'bloqueio' && ex.estado === 'confirmada') {
        viraBloqueio.add(ex.uid);
        vistos.delete(ev.uid);
        continue;
      }
      const dMudou = Rv.iso(ex.check_in) !== ev.ci || Rv.iso(ex.check_out) !== ev.co;
      ex.presente_no_feed = true; ex.leituras_em_falta = 0; ex.primeira_falta_em = null; ex.visto_em = agora;
      ex.apagar_apos = apagarApos(ev.co);

      // Reapareceu depois de o sistema a ter cancelado por falta
      if (ex.estado === 'cancelada' && ex.motivo_cancelamento === 'faltou' && ev.co >= hoje) {
        const antes = ex.estado_antes_cancelar || 'por_confirmar';
        ex.check_in = Rv.dataDe(ev.ci); ex.check_out = Rv.dataDe(ev.co); ex.noites = ev.noites;
        ex.motivo_cancelamento = null; ex.conflito = null;
        hist(ex, 'reapareceu', 'cancelada', antes);
        alt.reaparecidas += 1;
        if (antes === 'duplicada') {
          // Era só a cópia de outra reserva: volta a ver-se se continua coberta; se sim, não se pergunta nada.
          const d = decidirNovo(ev, ex._id);
          hist(ex, 'reapareceu', 'cancelada', d.estado);
          if (d.estado === 'duplicada') { await aplicar(ex, ev, d); alt.reaparecidas -= 1; continue; }
          await aplicar(ex, ev, d);
        } else if (antes === 'confirmada') {
          if (ex.reserva_manual_id) await ReservaManual.updateOne({ _id: ex.reserva_manual_id }, { $unset: { reserva_externa_id: 1 } });
          ex.reserva_manual_id = undefined;
          ex.estado = 'confirmada';
          await ex.save();
          const r = await Rv.criarReservaDaExterna(ex, { rotulo: fonte.rotulo });
          if (r.ok) { ex.reserva_manual_id = r.reserva._id; novaCobertura(ex); } else { ex.estado = 'por_confirmar'; ex.motivo = 'reapareceu'; }
        } else {
          ex.estado = antes === 'bloqueio' ? 'bloqueio' : 'por_confirmar';
          ex.motivo = ex.estado === 'por_confirmar' ? 'reapareceu' : null;
        }
        await ex.save();
        const txt = `A reserva de ${ev.ci.slice(8)}/${ev.ci.slice(5, 7)} a ${ev.co.slice(8)}/${ev.co.slice(5, 7)} em ${casa} voltou a aparecer no ${rotulo}.`;
        avisos.parceiro.push(txt); avisos.gestor.push(txt);
        continue;
      }
      if (ex.estado === 'cancelada' || ex.estado === 'substituida' || ex.estado === 'terminada') { await ex.save(); continue; }

      if (dMudou) {
        alt.datas_alteradas += 1;
        const dAntes = `${Rv.iso(ex.check_in)}>${Rv.iso(ex.check_out)}`;
        if (ex.estado === 'confirmada' && ex.reserva_manual_id) {
          const r = await Rv.mudarDatasDaReserva(ex, ev.ci, ev.co);
          if (r.ok) {
            ex.check_in = Rv.dataDe(ev.ci); ex.check_out = Rv.dataDe(ev.co); ex.noites = ev.noites; ex.conflito = null;
            hist(ex, 'datas', dAntes, `${ev.ci}>${ev.co}`);
            avisos.parceiro.push(`O ${rotulo} mudou as datas da reserva em ${casa}: agora ${ev.ci.slice(8)}/${ev.ci.slice(5, 7)} a ${ev.co.slice(8)}/${ev.co.slice(5, 7)}.`);
          } else {
            ex.conflito = r.conflito || 'limpeza_concluida';
            alt.conflitos += 1;
            const txt = `O ${rotulo} mudou as datas de uma reserva em ${casa} (agora ${ev.ci.slice(8)}/${ev.ci.slice(5, 7)} a ${ev.co.slice(8)}/${ev.co.slice(5, 7)}), mas a limpeza já não pode mudar: ${r.erro || 'confirma com o proprietário'}.`;
            avisos.parceiro.push(txt); avisos.gestor.push(txt);
          }
          await ex.save();
        } else {
          ex.check_in = Rv.dataDe(ev.ci); ex.check_out = Rv.dataDe(ev.co); ex.noites = ev.noites;
          hist(ex, 'datas', dAntes, `${ev.ci}>${ev.co}`);
          if (ex.estado === 'duplicada') {
            // volta a ser avaliada: já pode deixar de coincidir com a outra reserva
            const d = decidirNovo(ev, ex.duplicada_de && ex.duplicada_de.id);
            if (d.estado !== 'duplicada') await aplicar(ex, ev, d); else await ex.save();
          } else await ex.save();
        }
      } else {
        await ex.save();
      }
      continue;
    }

    // UID novo ----------------------------------------------------------------------------------------
    // Troca de UID: mesmas datas de uma externa desta fonte ausente neste calendário (ou fonte com UID instável).
    const mesmasDatas = (x) => x.estado !== 'substituida' && Rv.iso(x.check_in) === ev.ci && Rv.iso(x.check_out) === ev.co;
    let antiga = externas.find((x) => !vistos.has(x.uid) && !uidsDoFeed.has(x.uid) && mesmasDatas(x));
    if (!antiga && fonte.uid_instavel) antiga = externas.find((x) => mesmasDatas(x) && x.uid !== ev.uid);
    let herdarBloqueio = false;
    if (antiga && antiga.estado === 'cancelada' && antiga.motivo_cancelamento === 'faltou') {
      // Reserva nova nas datas de uma que tinha desaparecido: não herda «cancelada» (nem espera outra leitura).
      // Só um bloqueio já decidido pelo proprietário/gestor continua a valer.
      if (antiga.estado_antes_cancelar === 'bloqueio' && antiga.decidido_por !== 'automatico') herdarBloqueio = true;
      else antiga = null;
    }
    if (antiga) {
      const nova = new ReservaExterna({
        empresa_id: fonte.empresa_id, propriedade_id: propriedade._id, parceiro_id: fonte.parceiro_id, fonte_id: fonte._id,
        canal: fonte.canal, canal_chave: fonte.canal_chave, uid: ev.uid, codigo_ref_hash: ev.codigo_ref_hash,
        check_in: Rv.dataDe(ev.ci), check_out: Rv.dataDe(ev.co), noites: ev.noites, classe: ev.classe, resumo_tipo: ev.resumo_tipo,
        estado: herdarBloqueio ? 'bloqueio' : antiga.estado, motivo: herdarBloqueio ? null : antiga.motivo,
        motivo_cancelamento: herdarBloqueio ? null : antiga.motivo_cancelamento, estado_antes_cancelar: herdarBloqueio ? null : antiga.estado_antes_cancelar,
        decidido_por: antiga.decidido_por, decidido_por_id: antiga.decidido_por_id, decidido_em: antiga.decidido_em,
        presente_no_feed: true, leituras_em_falta: 0, primeiro_visto_em: antiga.primeiro_visto_em, visto_em: agora,
        reserva_manual_id: antiga.reserva_manual_id, duplicada_de: antiga.duplicada_de, conflito: antiga.conflito,
        historico: antiga.historico, apagar_apos: apagarApos(ev.co),
      });
      hist(nova, 'uid_trocado', antiga.uid.slice(-12), ev.uid.slice(-12));
      antiga.estado = 'substituida'; antiga.reserva_manual_id = undefined;
      antiga.apagar_apos = new Date(agora.getTime() + 30 * 86400000);
      await antiga.save();
      await nova.save();
      if (nova.reserva_manual_id) await ReservaManual.updateOne({ _id: nova.reserva_manual_id }, { $set: { reserva_externa_id: nova._id } });
      // as duplicadas que apontavam para a antiga passam a apontar para a nova
      await ReservaExterna.updateMany({ propriedade_id: propriedade._id, estado: 'duplicada', 'duplicada_de.id': antiga._id }, { $set: { 'duplicada_de.id': nova._id } });
      porUid.set(ev.uid, nova);
      alt.uid_trocados += 1;
      continue;
    }
    if (semNovos) continue; // leitura anómala (reservas novas a mais): não cria nada até o gestor aceitar

    const d = decidirNovo(ev);
    const ex = new ReservaExterna({
      empresa_id: fonte.empresa_id, propriedade_id: propriedade._id, parceiro_id: fonte.parceiro_id, fonte_id: fonte._id,
      canal: fonte.canal, canal_chave: fonte.canal_chave, uid: ev.uid, codigo_ref_hash: ev.codigo_ref_hash,
      check_in: Rv.dataDe(ev.ci), check_out: Rv.dataDe(ev.co), noites: ev.noites, classe: ev.classe, resumo_tipo: ev.resumo_tipo,
      estado: d.estado, presente_no_feed: true, primeiro_visto_em: agora, visto_em: agora, apagar_apos: apagarApos(ev.co),
    });
    porUid.set(ev.uid, ex);
    hist(ex, 'criada', '', d.estado);
    await aplicar(ex, ev, d);
  }

  /* ---------------- Calendário vazio ---------------- */
  // Vazio (incluindo o caso de 1 só reserva futura): nada se cancela antes de `horasFeedVazio` seguidas vazio.
  const vazio = eventos ? eventos.length === 0 : !!fonte.vazio_desde;
  if (eventos && eventos.length === 0) {
    // Limpeza a começar nas próximas 48 h: avisa já o gestor e o proprietário, que confirmam à mão (sem esperar).
    const datas = [];
    for (const x of externas) {
      if (x.estado !== 'confirmada' || !x.reserva_manual_id || Rv.iso(x.check_out) < hoje || (x.avisos_enviados || []).includes('vazio_48h')) continue;
      const reserva = await ReservaManual.findById(x.reserva_manual_id).select('tarefa_gerada_id').lean();
      const tarefa = reserva && reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id).select('data estado').lean() : null;
      if (!tarefa || ['cancelada', 'concluida', 'em_curso'].includes(tarefa.estado) || !dentroDas48h(tarefa.data, agora)) continue;
      x.avisos_enviados.push('vazio_48h');
      await x.save();
      datas.push(`${Rv.iso(tarefa.data).slice(8)}/${Rv.iso(tarefa.data).slice(5, 7)}`);
    }
    if (datas.length) {
      const txt = `O calendário ${rotulo} de ${casa} ficou vazio e há ${datas.length === 1 ? 'uma limpeza' : 'limpezas'} a ${datas.join(', ')} (próximas 48 h). Não cancelámos nada: confirma à mão se a${datas.length === 1 ? '' : 's'} reserva${datas.length === 1 ? '' : 's'} ainda existe${datas.length === 1 ? '' : 'm'}.`;
      avisos.parceiro.push(txt); avisos.gestor.push(txt);
    }
  }

  /* ---------------- Faltas e cancelamento ---------------- */
  if (!suspeita) {
    const ausentes = [
      ...ausentesAntes.filter((x) => !vistos.has(x.uid)),
      ...externas.filter((x) => viraBloqueio.has(x.uid)),
    ];
    const jaVistos = new Set();
    for (const ex of ausentes) {
      if (jaVistos.has(String(ex._id))) continue;
      jaVistos.add(String(ex._id));
      if (!['confirmada', 'por_confirmar', 'bloqueio', 'duplicada'].includes(ex.estado)) continue;
      // 304: só conta falta quem já estava ausente na leitura anterior
      if (eventos === null && ex.presente_no_feed !== false) continue;
      const ci = Rv.iso(ex.check_in); const co = Rv.iso(ex.check_out);
      if (co <= hoje) { if (co < hoje) { ex.estado = 'terminada'; await ex.save(); } continue; }
      const decorrer = ci <= hoje && hoje < co;
      ex.presente_no_feed = false;
      ex.leituras_em_falta = (ex.leituras_em_falta || 0) + 1;
      if (!ex.primeira_falta_em) ex.primeira_falta_em = agora;
      alt.faltas_contadas += 1;
      hist(ex, 'falta', String(ex.leituras_em_falta), '');
      const horas = (agora.getTime() - ex.primeira_falta_em.getTime()) / 3600000;
      let limite = ex.leituras_em_falta >= cfg.leiturasParaCancelar && horas >= cfg.horasMinimasFalta;
      // Calendário vazio: além disso, só depois de `horasFeedVazio` horas SEGUIDAS vazio.
      if (limite && vazio && (agora.getTime() - (fonte.vazio_desde ? new Date(fonte.vazio_desde).getTime() : agora.getTime())) / 3600000 < (cfg.horasFeedVazio || 0)) limite = false;
      if (!limite) { await ex.save(); continue; }

      const periodo = `${ci.slice(8)}/${ci.slice(5, 7)} a ${co.slice(8)}/${co.slice(5, 7)}`;
      if (decorrer && ex.estado === 'confirmada') {
        // Estadia a decorrer: nunca se cancela sozinha; só avisa (uma vez).
        if (!ex.avisos_enviados.includes('decorrer_falta')) {
          ex.avisos_enviados.push('decorrer_falta');
          const txt = `A reserva a decorrer (${periodo}) em ${casa} desapareceu do ${rotulo}. Não a cancelámos: confirma o que aconteceu.`;
          avisos.parceiro.push(txt); avisos.gestor.push(txt);
        }
        await ex.save();
        continue;
      }
      if (ex.estado === 'confirmada') {
        // A mesma estadia noutro canal (duplicada) que ainda está viva herda a reserva e a limpeza, sem cancelar e recriar.
        const promovida = await promoverDuplicada(ex, { hoje });
        const r = promovida ? { cancelada: true, conflito: null } : await Rv.cancelarReservaDaExterna(ex, { motivo: 'canal', textoMotivo: `foi cancelada (a reserva foi cancelada no ${rotulo}).` });
        if (!r.cancelada) {
          ex.conflito = r.conflito; alt.conflitos += 1;
          if (!ex.avisos_enviados.includes('cancel_conflito')) {
            ex.avisos_enviados.push('cancel_conflito');
            const txt = `A reserva ${periodo} em ${casa} desapareceu do ${rotulo}, mas a limpeza já ${r.conflito === 'limpeza_em_curso' ? 'está em curso' : 'foi concluída'} e não foi alterada.`;
            avisos.parceiro.push(txt); avisos.gestor.push(txt);
          }
          await ex.save();
          continue;
        }
        const viraB = viraBloqueio.has(ex.uid);
        ex.estado_antes_cancelar = 'confirmada';
        ex.estado = viraB ? 'bloqueio' : 'cancelada';
        ex.motivo_cancelamento = viraB ? null : 'faltou';
        if (viraB) ex.classe = 'bloqueio';
        hist(ex, 'cancelada', 'confirmada', ex.estado);
        alt.canceladas += 1;
        if (promovida) {
          alt.promovidas += 1;
          const outro = Rv.plataformaDe(promovida.canal);
          const txt = `A reserva ${periodo} em ${casa} deixou de aparecer no ${rotulo}, mas a estadia continua no ${outro}: a limpeza foi mantida.`;
          avisos.parceiro.push(txt); avisos.gestor.push(txt);
        } else {
          const incerta = viraB ? null : await perguntarIncertas(ex, { hoje });
          if (incerta) alt.por_confirmar += 1;
          const txt = `A reserva ${periodo} em ${casa} foi cancelada no ${rotulo}: a limpeza também foi cancelada.${incerta ? ` Há um período com as mesmas datas no ${Rv.plataformaDe(incerta.canal)}: diz se é uma reserva.` : ''}`;
          avisos.parceiro.push(txt); avisos.gestor.push(txt);
        }
      } else if (ex.estado === 'por_confirmar') {
        ex.estado_antes_cancelar = 'por_confirmar'; ex.estado = 'cancelada'; ex.motivo_cancelamento = 'faltou';
        hist(ex, 'cancelada', 'por_confirmar', 'cancelada');
        alt.canceladas += 1;
        avisos.parceiro.push(`O período ${periodo} em ${casa} deixou de aparecer no ${rotulo}.`);
      } else {
        ex.estado_antes_cancelar = ex.estado; ex.estado = 'cancelada'; ex.motivo_cancelamento = 'faltou';
        hist(ex, 'cancelada', ex.estado_antes_cancelar, 'cancelada');
      }
      await ex.save();
    }
  }
  // Resumo ao proprietário (uma só notificação por leitura).
  if (alt.criadas - alt.reaparecidas > 0) avisos.parceiro.unshift(`${alt.criadas === 1 ? '1 limpeza nova' : `${alt.criadas} limpezas novas`} em ${casa}.`);
  if (alt.por_confirmar > 0) avisos.parceiro.unshift(`${alt.por_confirmar === 1 ? '1 período por confirmar' : `${alt.por_confirmar} períodos por confirmar`} em ${casa}: diz se são reservas.`);
  return { alteracoes: alt, avisos };
}

module.exports = { reconciliar, sobrepoe, mesmaEstadia, NOITES_PERIODO_LONGO };
