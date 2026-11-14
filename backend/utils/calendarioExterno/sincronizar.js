/**
 * Sincronização de UMA fonte de calendário — All2gether.
 *
 * Usada pelo job (a cada hora por fonte), pelo botão «Atualizar agora» e por «Testar». Passos:
 *  0 elegibilidade (casa/proprietário/empresa ativos, sem Smoobu) · 1 ler (fora do lock) · 2 validar o formato
 *  · 3 regra de sanidade (decide se as faltas contam) · 4 reconciliar dentro do lock da casa · 5 registo mínimo.
 * Um erro ou uma leitura suspeita NUNCA cancela nada.
 */
const FonteCalendario = require('../../models/FonteCalendario');
const ReservaExterna = require('../../models/ReservaExterna');
const LeituraCalendario = require('../../models/LeituraCalendario');
const Propriedade = require('../../models/Propriedade');
const Utilizador = require('../../models/Utilizador');
const Empresa = require('../../models/Empresa');
const H = require('../horario');
const { obterLock, libertarLock, renovarLock } = require('../lockEmpresa');
const { estadoDaCasa } = require('../casaAtiva');
const { acordoPermiteLigar } = require('../acordoRgpd');
const { chavesConfiguradas, decifrar, hmac, semUrl } = require('./cifra');
const { buscarFeed, ErroFeed, pedir } = require('./buscar');
const { analisarIcal, hashNormalizado, amostraRedigida } = require('./parser');
const { reconciliar } = require('./reconciliar');
const { enviarAvisosDaLeitura, avisarParceiro, avisarGestor } = require('./avisos');
const { mensagemErro, canalTexto } = require('./mensagens');
const { removerFonte } = require('./decisoes');
const Rv = require('./reservas');

const MAX_EVENTOS_REGISTO = 300;

/** Configuração lida do ambiente (todas com valor por omissão seguro). */
function configDoAmbiente(env = process.env) {
  const n = (v, def, min, max) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : def; };
  return {
    leiturasParaCancelar: n(env.ICAL_LEITURAS_PARA_CANCELAR, 3, 2, 6),
    horasMinimasFalta: Number.isFinite(Number(env.ICAL_HORAS_MINIMAS_FALTA)) && env.ICAL_HORAS_MINIMAS_FALTA !== undefined && env.ICAL_HORAS_MINIMAS_FALTA !== '' ? Math.max(0, Number(env.ICAL_HORAS_MINIMAS_FALTA)) : 2,
    intervaloMin: n(env.ICAL_INTERVALO_MIN, 60, 5, 1440),
    limiteFontesCasa: n(env.ICAL_MAX_FONTES_CASA, 3, 1, 10),
    limiteFontesParceiro: n(env.ICAL_MAX_FONTES_PARCEIRO, 60, 1, 1000),
    limiteFontesEmpresa: n(env.ICAL_MAX_FONTES_EMPRESA, 500, 1, 10000),
    // Calendário VAZIO: só cancela depois de tantas horas seguidas vazio (em vez das horasMinimasFalta normais).
    horasFeedVazio: Number.isFinite(Number(env.ICAL_HORAS_FEED_VAZIO)) && env.ICAL_HORAS_FEED_VAZIO !== undefined && env.ICAL_HORAS_FEED_VAZIO !== '' ? Math.max(0, Number(env.ICAL_HORAS_FEED_VAZIO)) : 24,
    // Reservas novas por leitura: acima disto a leitura é anómala e não cria nada até o gestor aceitar.
    maxNovosPorLeitura: n(env.ICAL_MAX_NOVOS_LEITURA, 60, 5, 1000),
    // Teto de bytes do registo de leituras por fonte.
    tetoBytesLeituras: n(env.ICAL_TETO_BYTES_LEITURAS, 512 * 1024, 16 * 1024, 20 * 1024 * 1024),
  };
}

/** A funcionalidade está ligada? (interruptor de emergência + chaves configuradas) */
function funcionalidadeLigada(env = process.env) {
  return env.ICAL_SYNC_ATIVO !== 'false' && chavesConfiguradas(env);
}

const desvioMs = (id) => (parseInt(String(id).slice(-4), 16) % 10) * 60000;

function proximaPorSucesso(fonte, agora, cfg) {
  return new Date(agora.getTime() + cfg.intervaloMin * 60000 + desvioMs(fonte._id));
}

/** Espera entre tentativas depois de erros: 1 h até 3 erros, depois 2 h, 4 h, máx. 6 h; 404/410/401/403 → 6 h; 429 respeita Retry-After. */
function proximaPorErro(fonte, codigo, agora, { http_status, retryAfter } = {}) {
  const h = 3600000;
  let ms;
  if (codigo === 'http_429') ms = Math.max(h, (retryAfter || 0) * 1000);
  else if (codigo === 'http_404_410' || http_status === 401 || http_status === 403) ms = 6 * h;
  else {
    const e = fonte.erros_consecutivos || 1;
    ms = e <= 3 ? h : e === 4 ? 2 * h : e === 5 ? 4 * h : 6 * h;
  }
  return new Date(agora.getTime() + ms + desvioMs(fonte._id));
}

/** A fonte pode ler? Devolve { ok } ou { ok:false, estado, motivo, remover } sem fazer nenhum pedido. */
async function elegibilidade(fonte) {
  const p = await Propriedade.findById(fonte.propriedade_id).select('ativo parceiro_id smoobu_id nome empresa_id').lean();
  if (!p) return { ok: false, remover: true };
  if (p.smoobu_id) return { ok: false, estado: 'suspensa', motivo: 'casa_ligada_smoobu', propriedade: p };
  if (!p.parceiro_id || String(p.parceiro_id) !== String(fonte.parceiro_id)) return { ok: false, remover: true, propriedade: p };
  const dono = await Utilizador.findById(p.parceiro_id).select('ativo eliminado_em').lean();
  if (!dono || dono.eliminado_em) return { ok: false, remover: true, propriedade: p };
  const empresa = await Empresa.findById(fonte.empresa_id).select('ativa eliminacao_agendada_para').lean();
  if (!empresa || empresa.ativa === false || empresa.eliminacao_agendada_para) return { ok: false, estado: 'pausada', motivo: 'empresa_inativa', propriedade: p };
  const est = await estadoDaCasa(p);
  if (est.inativa) return { ok: false, estado: 'pausada', motivo: est.motivo === 'proprietario' ? 'parceiro_inativo' : 'casa_inativa', propriedade: p };
  if (!(await acordoPermiteLigar(p.parceiro_id))) return { ok: false, estado: 'pausada', motivo: 'acordo_por_aceitar', propriedade: p };
  return { ok: true, propriedade: p };
}

/** Regra de sanidade: devolve a lista de motivos de suspeita (vazia = leitura normal). */
async function motivosDeSuspeita({ fonte, eventos, prodid, hoje, cfg = configDoAmbiente() }) {
  const motivos = [];
  const R = fonte.referencia_futuros || 0;
  const F = eventos.length;
  if (R >= 2 && F === 0) motivos.push('vazio_repentino');
  if (R >= 6 && F < 0.5 * R) motivos.push('queda_grande');
  const externas = await ReservaExterna.find({
    propriedade_id: fonte.propriedade_id, canal_chave: fonte.canal_chave, estado: { $in: ['confirmada', 'por_confirmar', 'bloqueio', 'duplicada'] }, check_out: { $gt: Rv.dataDe(hoje) },
  }).select('uid check_in check_out leituras_em_falta').lean();
  const uids = new Set(eventos.map((e) => e.uid));
  // Só conta o desaparecimento SÚBITO (as que já vinham a faltar foram aceites ou já estão em contagem).
  const faltariam = externas.filter((x) => !uids.has(x.uid) && !(x.leituras_em_falta > 0)).length;
  if (externas.length && faltariam > Math.max(3, Math.ceil(0.4 * externas.length))) motivos.push('muitas_ausencias');
  // Reservas novas a mais de uma só vez (feed hostil ou com erro): não cria 200 limpezas de uma vez.
  if (eventos.length > cfg.maxNovosPorLeitura) {
    const conhecidos = new Set((await ReservaExterna.find({ propriedade_id: fonte.propriedade_id, canal_chave: fonte.canal_chave, uid: { $in: eventos.map((e) => e.uid) } }).select('uid').lean()).map((x) => x.uid));
    if (eventos.filter((e) => !conhecidos.has(e.uid)).length > cfg.maxNovosPorLeitura) motivos.push('muitos_novos');
  }
  const p = String(prodid || '');
  if (fonte.canal === 'airbnb' && !/airbnb/i.test(p)) motivos.push('prodid_diferente');
  else if (fonte.canal === 'booking' && !/booking\.com/i.test(p)) motivos.push('prodid_diferente');
  else if (fonte.canal !== 'airbnb' && fonte.canal !== 'booking' && fonte.prodid_esperado && p && p !== fonte.prodid_esperado) motivos.push('prodid_diferente');
  // 80 % ou mais dos UID são novos e 80 % ou mais deles têm datas de eventos conhecidos (calendário que troca os UID)
  if (F >= 3 && externas.length) {
    const conhecidosUid = new Set(externas.map((x) => x.uid));
    const datas = new Set(externas.map((x) => `${Rv.iso(x.check_in)}|${Rv.iso(x.check_out)}`));
    const novos = eventos.filter((e) => !conhecidosUid.has(e.uid));
    if (novos.length >= 0.8 * F && novos.filter((e) => datas.has(`${e.ci}|${e.co}`)).length >= 0.8 * novos.length) motivos.push('uids_todos_novos');
  }
  return motivos;
}

/**
 * Regista a leitura de forma MÍNIMA. Leituras iguais seguidas fundem-se numa só (`repetidas`); os UID e a amostra
 * só ficam quando o calendário muda ou há erro de formato/anomalia; amostras só nas 3 mais recentes; teto por fonte.
 */
async function registarLeitura({ tetoBytes = 512 * 1024, fonte, origem, iniciada, duracao, resultado, http_status, n_eventos, n_futuros, hash, prodid, erro, motivoSuspeita, eventos, amostra }) {
  const base = { empresa_id: fonte.empresa_id, propriedade_id: fonte.propriedade_id, fonte_id: fonte._id };
  const ultima = await LeituraCalendario.findOne({ fonte_id: fonte._id }).sort({ iniciada_em: -1 }).select('resultado erro.codigo http_status').lean();
  // Fusão: leituras «sem alterações» seguidas, ou o mesmo erro repetido, ficam num só documento.
  const fundir = ultima && (
    (resultado === 'sem_alteracoes' && ultima.resultado === 'sem_alteracoes')
    || (resultado === 'erro' && ultima.resultado === 'erro' && erro && ultima.erro && ultima.erro.codigo === erro.codigo && ultima.http_status === http_status)
  );
  if (fundir) {
    await LeituraCalendario.updateOne({ _id: ultima._id }, { $inc: { repetidas: 1 }, $set: { ultima_em: iniciada, duracao_ms: duracao } });
    return;
  }
  const doc = {
    ...base, origem, iniciada_em: iniciada, ultima_em: iniciada, duracao_ms: duracao, resultado, http_status, n_eventos, n_futuros, hash_normalizado: hash,
    prodid: prodid ? String(prodid).slice(0, 120) : undefined,
    ...(erro ? { erro: { codigo: erro.codigo, mensagem: semUrl(erro.mensagem).slice(0, 300) } } : {}),
    ...(motivoSuspeita && motivoSuspeita.length ? { motivo_suspeita: motivoSuspeita } : {}),
  };
  const guardarDetalhe = (resultado === 'ok' && eventos) || resultado === 'suspeita' || (resultado === 'erro' && erro && erro.codigo === 'formato');
  if (guardarDetalhe && eventos) {
    doc.eventos = eventos.slice(0, MAX_EVENTOS_REGISTO).map((e) => `${e.uid.slice(0, 60)}|${e.ci}|${e.co}|${e.classe}`);
    if (eventos.length > MAX_EVENTOS_REGISTO) doc.eventos_truncados = true;
    if (amostra) doc.amostra_redigida = amostra;
  }
  doc.bytes = Buffer.byteLength(JSON.stringify(doc));
  await LeituraCalendario.create(doc);
  // Só as 3 amostras mais recentes
  const comAmostra = await LeituraCalendario.find({ fonte_id: fonte._id, amostra_redigida: { $exists: true } }).sort({ iniciada_em: -1 }).skip(3).select('_id').lean();
  if (comAmostra.length) await LeituraCalendario.updateMany({ _id: { $in: comAmostra.map((x) => x._id) } }, { $unset: { amostra_redigida: 1 } });
  await aplicarTetos(fonte._id, tetoBytes);
}

/** Tetos por fonte: no máximo TETO_POR_FONTE documentos E `tetoBytes` bytes. Apaga as leituras mais antigas; guarda sempre a mais recente. */
async function aplicarTetos(fonteId, tetoBytes) {
  const todas = await LeituraCalendario.find({ fonte_id: fonteId }).sort({ iniciada_em: -1 }).select('_id bytes').lean();
  let soma = 0;
  const apagar = [];
  todas.forEach((l, i) => {
    soma += l.bytes || 1500; // documentos antigos sem tamanho: estimativa
    if (i > 0 && (i >= LeituraCalendario.TETO_POR_FONTE || soma > tetoBytes)) apagar.push(l._id);
  });
  if (apagar.length) await LeituraCalendario.deleteMany({ _id: { $in: apagar } });
}

/** Trata um erro de leitura: conta, agenda a próxima tentativa, avisa ao fim de 24 h e suspende ao fim de 14 dias. Nunca mexe em reservas. */
async function tratarErro({ fonte, err, agora, origem, iniciada, cfg }) {
  const codigo = err && err.codigo ? err.codigo : 'outro';
  const erros = (fonte.erros_consecutivos || 0) + 1;
  const set = {
    ultima_leitura_em: agora, erros_consecutivos: erros,
    ultimo_erro: { em: agora, codigo, http_status: err.http_status, mensagem: semUrl(mensagemErro(codigo, { canal: canalTexto(fonte.canal, fonte.rotulo) })).slice(0, 300) },
  };
  if (erros >= 3 && fonte.estado === 'ativa') set.estado = 'erro';
  fonte.erros_consecutivos = erros;
  set.proxima_leitura_em = proximaPorErro(fonte, codigo, agora, err);
  const desde = fonte.ultimo_sucesso_em || fonte.createdAt || agora;
  const horas = (agora.getTime() - new Date(desde).getTime()) / 3600000;
  if (horas >= 14 * 24) { set.estado = 'suspensa'; set.motivo_estado = 'erros_persistentes'; }
  await FonteCalendario.updateOne({ _id: fonte._id }, { $set: set });
  await registarLeitura({ fonte, origem, iniciada, duracao: Date.now() - iniciada.getTime(), resultado: 'erro', http_status: err.http_status, erro: { codigo, mensagem: err.message } });
  if (horas >= 24 && !fonte.aviso_falha_enviado_em) {
    await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { aviso_falha_enviado_em: agora } });
    const p = await Propriedade.findById(fonte.propriedade_id).select('nome').lean();
    const txt = `O calendário ${fonte.rotulo || Rv.plataformaDe(fonte.canal)} de ${(p && p.nome) || 'uma casa'} não responde há mais de 24 horas. ${mensagemErro(codigo, { canal: canalTexto(fonte.canal, fonte.rotulo) })} As limpezas já marcadas continuam.`;
    await avisarParceiro(fonte.parceiro_id, fonte.empresa_id, txt);
    await avisarGestor(fonte.empresa_id, 'Calendário externo com erro', txt);
  }
  return { resultado: 'erro', codigo, mensagem: mensagemErro(codigo, { canal: canalTexto(fonte.canal, fonte.rotulo) }) };
}

/**
 * Lê e processa uma fonte.
 * @returns {Promise<object>} { resultado: 'ok'|'sem_alteracoes'|'suspeita'|'erro'|'pausada'|'suspensa'|'ocupado'|'desligada'|'ignorada', ... }
 */
async function sincronizarFonte(fonteId, { origem = 'agendada', transporte = pedir, agora = new Date(), env = process.env, esperaLockMs = 20000 } = {}) {
  const cfg = configDoAmbiente(env);
  if (!chavesConfiguradas(env)) return { resultado: 'desligada' };
  const fonte = await FonteCalendario.findById(fonteId).select('+url_cifrada');
  if (!fonte || fonte.removida) return { resultado: 'ignorada' };

  // 0. elegibilidade
  const el = await elegibilidade(fonte);
  if (!el.ok) {
    if (el.remover) { await removerFonte(fonte, { silencioso: true }); return { resultado: 'removida' }; }
    await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { estado: el.estado, motivo_estado: el.motivo, pausada_em: fonte.pausada_em || agora } });
    if (el.estado === 'suspensa' && fonte.estado !== 'suspensa') {
      await avisarGestor(fonte.empresa_id, 'Calendário externo suspenso', `A casa ${el.propriedade.nome} passou a receber as reservas pelo Smoobu: o calendário externo foi suspenso. Confirma se há limpezas duplicadas.`);
    }
    return { resultado: el.estado, motivo: el.motivo };
  }
  if (fonte.estado === 'pausada' && ['casa_inativa', 'parceiro_inativo', 'empresa_inativa', 'acordo_por_aceitar'].includes(fonte.motivo_estado)) {
    // A causa passou: retoma sozinha (nada é recriado; só se volta a ler).
    fonte.estado = 'ativa'; fonte.motivo_estado = null; fonte.pausada_em = undefined; origem = 'retoma';
    await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { estado: 'ativa', motivo_estado: null }, $unset: { pausada_em: 1 } });
  }
  if (!['ativa', 'erro'].includes(fonte.estado)) return { resultado: fonte.estado === 'suspensa' ? 'suspensa' : 'pausada', motivo: fonte.motivo_estado };

  const iniciada = new Date();
  let url;
  try { url = decifrar(fonte.url_cifrada, String(fonte._id), env); } catch {
    return tratarErro({ fonte, err: new ErroFeed('outro', 'Não foi possível abrir o link guardado.'), agora, origem, iniciada, cfg });
  }

  // 1-2. ler e validar o formato (fora do lock)
  let feed; let parsed = null;
  try {
    feed = await buscarFeed(url, { etag: fonte.etag, lastModified: fonte.last_modified, transporte, env });
    if (!feed.notModified) {
      const hoje0 = H.hojeLisboa(agora);
      parsed = analisarIcal(feed.texto, { canal: fonte.canal, hoje: hoje0, hmac: (t) => hmac(t, env) });
    }
  } catch (err) {
    return tratarErro({ fonte, err, agora, origem, iniciada, cfg });
  }

  // 3-4. dentro do lock da casa
  const chaveLock = `ical:${fonte.propriedade_id}:${fonte.empresa_id}`;
  const dono = await obterLock(chaveLock, { ttlMs: 120000, esperaMs: esperaLockMs });
  if (!dono) return { resultado: 'ocupado' };
  try {
    const hoje = H.hojeLisboa(agora);
    const fresca = await FonteCalendario.findById(fonte._id).select('referencia_futuros prodid_esperado uid_instavel aceitar_proxima suspeitas_consecutivas aviso_suspeita_enviado_em aviso_muitos_novos_em vazio_desde erros_consecutivos');
    Object.assign(fonte, { referencia_futuros: fresca.referencia_futuros, prodid_esperado: fresca.prodid_esperado, uid_instavel: fresca.uid_instavel, aceitar_proxima: fresca.aceitar_proxima, suspeitas_consecutivas: fresca.suspeitas_consecutivas, aviso_suspeita_enviado_em: fresca.aviso_suspeita_enviado_em, aviso_muitos_novos_em: fresca.aviso_muitos_novos_em, vazio_desde: fresca.vazio_desde });
    const propriedade = el.propriedade;
    let motivos = [];
    let eventos = null; let hash = fonte.ultimo_hash_normalizado;
    if (!feed.notModified) {
      eventos = parsed.eventos;
      hash = hashNormalizado(eventos);
      if (!fonte.aceitar_proxima) motivos = await motivosDeSuspeita({ fonte, eventos, prodid: parsed.prodid, hoje, cfg });
      // Desde quando o calendário vem vazio (leituras seguidas): conta as 24 h antes de cancelar o que faltar.
      if (eventos.length === 0) fonte.vazio_desde = fonte.vazio_desde || agora; else fonte.vazio_desde = undefined;
      if (motivos.includes('uids_todos_novos')) await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { uid_instavel: true } });
    }
    const suspeita = motivos.length > 0;
    await renovarLock(chaveLock, dono);
    const r = await reconciliar({ fonte, propriedade, eventos, suspeita, hoje, agora, cfg, semNovos: motivos.includes('muitos_novos') });
    const mudou = !!eventos && hash !== fonte.ultimo_hash_normalizado;
    const resultado = suspeita ? 'suspeita' : (feed.notModified || (!mudou && !Object.values(r.alteracoes).some(Boolean))) ? 'sem_alteracoes' : 'ok';

    // 5. estado da fonte e registo mínimo
    const set = {
      ultima_leitura_em: agora, ultimo_sucesso_em: agora, erros_consecutivos: 0, ultimo_erro: undefined,
      proxima_leitura_em: proximaPorSucesso(fonte, agora, cfg), aviso_falha_enviado_em: undefined,
      ...(feed.etag ? { etag: feed.etag } : {}), ...(feed.last_modified ? { last_modified: feed.last_modified } : {}),
      ...(hash ? { ultimo_hash_normalizado: hash } : {}), aceitar_proxima: false,
    };
    if (mudou) set.ultima_alteracao_em = agora;
    if (parsed && !fonte.prodid_esperado && parsed.prodid && !suspeita) set.prodid_esperado = parsed.prodid.slice(0, 200);
    if (eventos && !suspeita) set.referencia_futuros = eventos.length;
    if (eventos) set.ultimo_n_futuros = eventos.length;
    if (fonte.estado === 'erro') set.estado = 'ativa';
    set.suspeitas_consecutivas = suspeita ? (fonte.suspeitas_consecutivas || 0) + 1 : 0;
    const unset = { ultimo_erro: 1, aviso_falha_enviado_em: 1 };
    if (eventos) { if (fonte.vazio_desde) set.vazio_desde = fonte.vazio_desde; else unset.vazio_desde = 1; }
    delete set.ultimo_erro; delete set.aviso_falha_enviado_em;
    await FonteCalendario.updateOne({ _id: fonte._id }, { $set: set, $unset: unset });
    await registarLeitura({
      fonte, origem, iniciada, duracao: Date.now() - iniciada.getTime(), resultado, http_status: feed.status,
      n_eventos: eventos ? eventos.length : undefined, n_futuros: eventos ? eventos.length : undefined, hash, prodid: parsed && parsed.prodid,
      tetoBytes: cfg.tetoBytesLeituras, motivoSuspeita: motivos, eventos: (mudou || suspeita) ? eventos : null, amostra: (mudou || suspeita) && parsed ? amostraRedigida(parsed.prodid, eventos) : null,
    });
    await enviarAvisosDaLeitura({ fonte, avisos: r.avisos });
    if (motivos.includes('muitos_novos') && !fonte.aviso_muitos_novos_em) {
      await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { aviso_muitos_novos_em: agora } });
      await avisarGestor(fonte.empresa_id, 'Calendário externo com reservas a mais', `O calendário ${fonte.rotulo || Rv.plataformaDe(fonte.canal)} de ${propriedade.nome} trouxe mais de ${cfg.maxNovosPorLeitura} reservas novas de uma só vez. Não criámos nenhuma limpeza: confirma o calendário e, se estiver certo, aceita-o.`);
    } else if (!motivos.includes('muitos_novos') && fonte.aviso_muitos_novos_em) {
      await FonteCalendario.updateOne({ _id: fonte._id }, { $unset: { aviso_muitos_novos_em: 1 } });
    }
    if (suspeita && set.suspeitas_consecutivas >= 6 && !fonte.aviso_suspeita_enviado_em) {
      await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { aviso_suspeita_enviado_em: agora } });
      const txt = `O calendário ${fonte.rotulo || Rv.plataformaDe(fonte.canal)} de ${propriedade.nome} está vazio ou diferente do normal há várias horas. Nada foi cancelado.`;
      await avisarParceiro(fonte.parceiro_id, fonte.empresa_id, txt);
      await avisarGestor(fonte.empresa_id, 'Calendário externo estranho', txt);
    } else if (!suspeita && fonte.aviso_suspeita_enviado_em) {
      await FonteCalendario.updateOne({ _id: fonte._id }, { $unset: { aviso_suspeita_enviado_em: 1 } });
    }
    return { resultado, motivos, n_eventos: eventos ? eventos.length : null, alteracoes: r.alteracoes };
  } finally {
    await libertarLock(chaveLock, dono);
  }
}

module.exports = { sincronizarFonte, elegibilidade, configDoAmbiente, funcionalidadeLigada, registarLeitura, proximaPorErro, MAX_EVENTOS_REGISTO };
