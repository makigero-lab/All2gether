/**
 * Serviço de ligações de calendário (criar, testar, substituir, reativar, atualizar, listar) — All2gether.
 *
 * Partilhado pelo proprietário (portal) e pelo gestor (na página da propriedade). `escopo` limita sempre:
 * { empresaId, parceiroId? } (o proprietário só vê as dele; o gestor as da empresa). Devolve { status, body }.
 * A API NUNCA devolve o link: só a máscara, o domínio e o canal.
 */
const mongoose = require('mongoose');
const FonteCalendario = require('../../models/FonteCalendario');
const ReservaExterna = require('../../models/ReservaExterna');
const ReservaManual = require('../../models/ReservaManual');
const LeituraCalendario = require('../../models/LeituraCalendario');
const Propriedade = require('../../models/Propriedade');
const H = require('../horario');
const { estadoDaCasa } = require('../casaAtiva');
const { registarAuditoria } = require('../auditoria');
const { chavesConfiguradas, cifrar, decifrar, hmac, semUrl } = require('./cifra');
const { analisarUrl, normalizarUrl, mascara, modoTesteAtivo } = require('./seguranca');
const { buscarFeed, pedir } = require('./buscar');
const { analisarIcal } = require('./parser');
const { sincronizarFonte, configDoAmbiente } = require('./sincronizar');
const { removerFonte, contarImpactoRemocao } = require('./decisoes');
const { MENSAGENS_ESTADO, mensagemErro } = require('./mensagens');
const Rv = require('./reservas');

const resp = (status, body) => ({ status, body });
const MSG_DESLIGADA = 'A ligação a calendários externos ainda não está configurada. Fala com o gestor.';
const INTERVALO_MANUAL_MS = 10 * 60000;

/** Limite em memória «Testar»: 10 por hora por utilizador. */
const testes = new Map();
function limiteTestar(userId, { agora = Date.now(), max = 10, janelaMs = 3600000 } = {}) {
  const k = String(userId);
  const lista = (testes.get(k) || []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) { testes.set(k, lista); return false; }
  lista.push(agora); testes.set(k, lista);
  return true;
}
const limparLimiteTestar = () => testes.clear();

const MESES_ERRO_DIAS = 14;

/** Forma pública de uma fonte (sem link). */
function fonteParaApi(f, extra = {}) {
  const erro = f.ultimo_erro && f.ultimo_erro.codigo
    ? { em: f.ultimo_erro.em, codigo: f.ultimo_erro.codigo, http_status: f.ultimo_erro.http_status, mensagem: semUrl(mensagemErro(f.ultimo_erro.codigo)) }
    : null;
  return {
    _id: String(f._id),
    propriedade_id: String(f.propriedade_id && f.propriedade_id._id ? f.propriedade_id._id : f.propriedade_id),
    propriedade_nome: f.propriedade_id && f.propriedade_id.nome ? f.propriedade_id.nome : undefined,
    parceiro_id: String(f.parceiro_id),
    canal: f.canal, rotulo: f.rotulo || null,
    canal_texto: f.canal === 'outro' ? (f.rotulo || 'Outro canal') : ({ airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo' })[f.canal],
    url_mascara: f.url_mascara, url_host: f.url_host,
    estado: f.estado, motivo_estado: f.motivo_estado || null,
    estado_texto: f.motivo_estado ? MENSAGENS_ESTADO[f.motivo_estado] || null : null,
    ultima_leitura_em: f.ultima_leitura_em || null, ultimo_sucesso_em: f.ultimo_sucesso_em || null, ultima_alteracao_em: f.ultima_alteracao_em || null,
    proxima_leitura_em: f.proxima_leitura_em || null,
    erros_consecutivos: f.erros_consecutivos || 0, suspeitas_consecutivas: f.suspeitas_consecutivas || 0,
    ultimo_erro: erro, createdAt: f.createdAt,
    ...extra,
  };
}

/** Casa do pedido, dentro do escopo. Devolve { casa } ou { erro: resp }. */
async function casaDoEscopo(propriedadeId, escopo) {
  if (!mongoose.isValidObjectId(propriedadeId)) return { erro: resp(400, { erro: 'propriedade_id inválido.' }) };
  const casa = await Propriedade.findOne({ _id: propriedadeId, empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}) })
    .select('nome ativo parceiro_id smoobu_id empresa_id').lean();
  if (!casa) return { erro: resp(404, { erro: 'Casa não encontrada.' }) };
  if (!casa.parceiro_id) return { erro: resp(400, { erro: 'Esta casa não tem proprietário. Associa primeiro um proprietário.' }) };
  return { casa };
}

/** Validações comuns antes de gravar ou testar: casa, Smoobu, link. Devolve { casa, analise } ou { erro }. */
async function validarPedido({ propriedadeId, url, escopo, rotulo }) {
  if (!chavesConfiguradas()) return { erro: resp(503, { erro: MSG_DESLIGADA, codigo: 'DESLIGADA' }) };
  if (typeof url !== 'string') return { erro: resp(400, { erro: 'O link tem de ser um texto.' }) };
  if (rotulo !== undefined && rotulo !== null && typeof rotulo !== 'string') return { erro: resp(400, { erro: 'O nome do canal é inválido.' }) };
  const c = await casaDoEscopo(propriedadeId, escopo);
  if (c.erro) return c;
  if (c.casa.smoobu_id) return { erro: resp(400, { erro: 'Esta casa já recebe as reservas pelo Smoobu. Só pode haver uma ligação automática por casa.', codigo: 'CASA_SMOOBU' }) };
  const est = await estadoDaCasa(c.casa);
  if (est.inativa) return { erro: resp(409, { erro: est.mensagem, codigo: 'CASA_INATIVA' }) };
  const analise = analisarUrl(url);
  if (!analise.ok) return { erro: resp(400, { erro: analise.erro, codigo: analise.codigo }) };
  return { casa: c.casa, analise };
}

/** «Testar ligação»: lê e analisa SEM gravar nada. */
async function testarLigacao({ propriedadeId, url, escopo, transporte = pedir }) {
  const v = await validarPedido({ propriedadeId, url, escopo });
  if (v.erro) return v.erro;
  const { casa, analise } = v;
  const hash = hmac(normalizarUrl(analise.url, analise.canal));
  const outra = await FonteCalendario.findOne({ url_hash: hash, removida: false }).select('propriedade_id').lean();
  if (outra && String(outra.propriedade_id) !== String(casa._id)) return resp(409, { erro: 'Este link já está a ser usado noutra casa.' });
  const existente = await FonteCalendario.findOne({ propriedade_id: casa._id, canal_chave: analise.canal_chave, removida: false }).select('_id').lean();
  let feed; let parsed;
  try {
    feed = await buscarFeed(url.trim(), { transporte });
    parsed = analisarIcal(feed.texto, { canal: analise.canal, hmac: (t) => hmac(t) });
  } catch (e) {
    return resp(200, { ok: false, canal: analise.canal, canal_texto: analise.rotulo, erro: mensagemErro(e.codigo || 'outro'), codigo: e.codigo || 'outro' });
  }
  const p = String(parsed.prodid || '');
  const prodidOk = analise.canal === 'airbnb' ? /airbnb/i.test(p) : analise.canal === 'booking' ? /booking\.com/i.test(p) : true;
  const c = parsed.contadores;
  const manuais = await ReservaManual.find({ propriedade_id: casa._id, check_out: { $gte: Rv.dataDe(H.hojeLisboa()) }, cancelada_em: null }).select('check_in check_out').lean();
  const coincidem = parsed.eventos.filter((e) => manuais.some((m) => Rv.iso(m.check_out) === e.co && Rv.iso(m.check_in) < e.co && e.ci < Rv.iso(m.check_out))).length;
  return resp(200, {
    ok: true, canal: analise.canal, canal_texto: analise.rotulo, host: analise.host, prodid_ok: prodidOk,
    reservas: c.reserva, bloqueios: c.bloqueio, por_confirmar: c.incerto,
    amostra: parsed.eventos.slice(0, 5).map((e) => ({ check_in: e.ci, check_out: e.co, tipo: e.classe })),
    ja_existiam: coincidem, ja_ligada: !!existente,
  });
}

async function contarLimites(casa, escopo, cfg) {
  const [nCasa, nParceiro, nEmpresa] = await Promise.all([
    FonteCalendario.countDocuments({ propriedade_id: casa._id, removida: false }),
    FonteCalendario.countDocuments({ parceiro_id: casa.parceiro_id, removida: false }),
    FonteCalendario.countDocuments({ empresa_id: escopo.empresaId, removida: false }),
  ]);
  if (nCasa >= cfg.limiteFontesCasa) return `Cada casa pode ter no máximo ${cfg.limiteFontesCasa} calendários.`;
  if (nParceiro >= cfg.limiteFontesParceiro) return 'Atingiste o limite de calendários deste proprietário.';
  if (nEmpresa >= cfg.limiteFontesEmpresa) return 'Atingiste o limite de calendários da empresa.';
  return null;
}

/** Grava a ligação e faz a primeira leitura. */
async function criarLigacao({ propriedadeId, url, rotulo, escopo, ator, transporte = pedir }) {
  const v = await validarPedido({ propriedadeId, url, escopo, rotulo });
  if (v.erro) return v.erro;
  const { casa, analise } = v;
  const cfg = configDoAmbiente();
  const limite = await contarLimites(casa, escopo, cfg);
  if (limite) return resp(400, { erro: limite, codigo: 'LIMITE' });
  const hash = hmac(normalizarUrl(analise.url, analise.canal));
  if (await FonteCalendario.exists({ url_hash: hash, removida: false })) return resp(409, { erro: 'Este link já está a ser usado (nesta ou noutra casa).', codigo: 'LINK_REPETIDO' });
  if (await FonteCalendario.exists({ propriedade_id: casa._id, canal_chave: analise.canal_chave, removida: false })) {
    return resp(409, { erro: `Esta casa já tem um calendário ${analise.rotulo}. Remove-o ou substitui o link.`, codigo: 'CANAL_REPETIDO' });
  }
  const _id = new mongoose.Types.ObjectId();
  const lbl = analise.canal === 'outro' ? ((typeof rotulo === 'string' && rotulo.trim().slice(0, 40)) || analise.host.slice(0, 40)) : null;
  let fonte;
  try {
    fonte = await FonteCalendario.create({
      _id, empresa_id: escopo.empresaId, propriedade_id: casa._id, parceiro_id: casa.parceiro_id, criada_por: ator.id,
      canal: analise.canal, canal_chave: analise.canal_chave, rotulo: lbl,
      url_cifrada: cifrar(analise.url.href, String(_id)), url_hash: hash, url_mascara: mascara(analise.url), url_host: analise.host.slice(0, 120),
      estado: 'ativa', proxima_leitura_em: new Date(),
    });
  } catch (e) {
    if (e && e.code === 11000) return resp(409, { erro: 'Este link ou canal já está ligado.', codigo: 'LINK_REPETIDO' });
    throw e;
  }
  registarAuditoria({ utilizador_id: ator.id, utilizador_nome: ator.nome || '', empresa_id: escopo.empresaId, acao: 'criar', recurso: 'calendario_externo', recurso_id: String(_id), descricao: `Calendário ${analise.rotulo} ligado à casa ${casa.nome} (${fonte.url_mascara})` });
  let leitura = null;
  try { leitura = await sincronizarFonte(_id, { origem: 'agendada', transporte }); } catch (e) { console.error('⚠️  primeira leitura do calendário:', semUrl(e.message)); }
  const atual = await FonteCalendario.findById(_id).lean();
  return resp(201, { fonte: fonteParaApi(atual), leitura: resumoLeitura(leitura) });
}

function resumoLeitura(l) {
  if (!l) return null;
  return { resultado: l.resultado, motivos: l.motivos || [], n_eventos: l.n_eventos ?? null, alteracoes: l.alteracoes || null, codigo: l.codigo || null, mensagem: l.mensagem || null };
}

async function fonteDoEscopo(id, escopo) {
  if (!mongoose.isValidObjectId(id)) return null;
  return FonteCalendario.findOne({ _id: id, removida: false, empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}) });
}

/** Substituir o link (o canal regenerou-o): mesma fonte e mesmo canal; as reservas continuam a corresponder pelo UID. */
async function substituirLigacao({ id, url, escopo, ator, transporte = pedir }) {
  if (!chavesConfiguradas()) return resp(503, { erro: MSG_DESLIGADA, codigo: 'DESLIGADA' });
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  if (typeof url !== 'string') return resp(400, { erro: 'O link tem de ser um texto.' });
  const analise = analisarUrl(url);
  if (!analise.ok) return resp(400, { erro: analise.erro, codigo: analise.codigo });
  if (analise.canal_chave !== fonte.canal_chave) return resp(400, { erro: 'O novo link tem de ser do mesmo canal.' });
  const hash = hmac(normalizarUrl(analise.url, analise.canal));
  if (await FonteCalendario.exists({ url_hash: hash, removida: false, _id: { $ne: fonte._id } })) return resp(409, { erro: 'Este link já está a ser usado noutra ligação.', codigo: 'LINK_REPETIDO' });
  fonte.url_cifrada = cifrar(analise.url.href, String(fonte._id)); fonte.url_hash = hash; fonte.url_mascara = mascara(analise.url); fonte.url_host = analise.host.slice(0, 120);
  fonte.estado = 'ativa'; fonte.motivo_estado = null; fonte.erros_consecutivos = 0; fonte.etag = undefined; fonte.last_modified = undefined; fonte.ultimo_erro = undefined; fonte.aviso_falha_enviado_em = undefined;
  fonte.proxima_leitura_em = new Date();
  await fonte.save();
  registarAuditoria({ utilizador_id: ator.id, utilizador_nome: ator.nome || '', empresa_id: escopo.empresaId, acao: 'atualizar', recurso: 'calendario_externo', recurso_id: String(fonte._id), descricao: `Link do calendário substituído (${fonte.url_mascara})` });
  let leitura = null;
  try { leitura = await sincronizarFonte(fonte._id, { origem: 'agendada', transporte }); } catch (e) { console.error('⚠️  leitura após substituir:', semUrl(e.message)); }
  return resp(200, { fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean()), leitura: resumoLeitura(leitura) });
}

/** «Atualizar agora»: 1 vez a cada 10 minutos por fonte. */
async function atualizarAgora({ id, escopo, ator, transporte = pedir, agora = new Date() }) {
  if (!chavesConfiguradas()) return resp(503, { erro: MSG_DESLIGADA, codigo: 'DESLIGADA' });
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  if (fonte.pedido_manual_em && agora.getTime() - fonte.pedido_manual_em.getTime() < INTERVALO_MANUAL_MS) {
    const falta = Math.ceil((INTERVALO_MANUAL_MS - (agora.getTime() - fonte.pedido_manual_em.getTime())) / 60000);
    return resp(429, { erro: `Já atualizaste há pouco. Tenta outra vez dentro de ${falta} min.`, codigo: 'DEMASIADO_CEDO' });
  }
  await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { pedido_manual_em: agora } });
  const l = await sincronizarFonte(fonte._id, { origem: ator.tipo === 'gestor' ? 'manual_gestor' : 'manual_parceiro', transporte, agora, esperaLockMs: 3000 });
  if (l.resultado === 'ocupado') return resp(409, { erro: 'Já estamos a ler este calendário. Espera um momento.', codigo: 'OCUPADO' });
  return resp(200, { fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean()), leitura: resumoLeitura(l) });
}

/** Reativar uma fonte em erro/suspensa depois de testar a ligação (não serve para casas com Smoobu). */
async function reativarLigacao({ id, escopo, transporte = pedir }) {
  if (!chavesConfiguradas()) return resp(503, { erro: MSG_DESLIGADA, codigo: 'DESLIGADA' });
  const fonte = await FonteCalendario.findOne({ _id: mongoose.isValidObjectId(id) ? id : null, removida: false, empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}) }).select('+url_cifrada');
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  if (fonte.motivo_estado === 'casa_ligada_smoobu') return resp(400, { erro: 'Esta casa recebe as reservas pelo Smoobu: não pode ter calendários externos.' });
  try {
    const feed = await buscarFeed(decifrar(fonte.url_cifrada, String(fonte._id)), { transporte });
    analisarIcal(feed.texto, { canal: fonte.canal, hmac: (t) => hmac(t) });
  } catch (e) {
    return resp(200, { ok: false, erro: mensagemErro(e.codigo || 'outro'), codigo: e.codigo || 'outro' });
  }
  await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { estado: 'ativa', motivo_estado: null, erros_consecutivos: 0, proxima_leitura_em: new Date() }, $unset: { ultimo_erro: 1, pausada_em: 1 } });
  const l = await sincronizarFonte(fonte._id, { origem: 'retoma', transporte, esperaLockMs: 3000 });
  return resp(200, { ok: true, fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean()), leitura: resumoLeitura(l) });
}

async function impactoRemocao({ id, escopo }) {
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  const i = await contarImpactoRemocao(fonte);
  return resp(200, { limpezas_a_cancelar: i.limpezas, reservas: i.reservas });
}

async function removerLigacao({ id, escopo, ator }) {
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  const r = await removerFonte(fonte, { ator });
  registarAuditoria({ utilizador_id: ator.id, utilizador_nome: ator.nome || '', empresa_id: escopo.empresaId, acao: 'eliminar', recurso: 'calendario_externo', recurso_id: String(fonte._id), descricao: `Calendário removido (${fonte.url_mascara}); ${r.canceladas} limpezas futuras canceladas` });
  return resp(200, { mensagem: 'Calendário desligado.', limpezas_canceladas: r.canceladas });
}

/** Lista as ligações do escopo (com contagens). */
async function listarLigacoes({ escopo, propriedadeId = null, estado = null }) {
  const filtro = { removida: false, empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}) };
  if (propriedadeId && mongoose.isValidObjectId(propriedadeId)) filtro.propriedade_id = propriedadeId;
  if (estado && ['ativa', 'erro', 'pausada', 'suspensa'].includes(estado)) filtro.estado = estado;
  const fontes = await FonteCalendario.find(filtro).populate('propriedade_id', 'nome').sort({ createdAt: 1 }).lean();
  const out = [];
  const hoje = Rv.dataDe(H.hojeLisboa());
  for (const f of fontes) {
    const [reservas, por_confirmar] = await Promise.all([
      ReservaExterna.countDocuments({ propriedade_id: f.propriedade_id._id, canal_chave: f.canal_chave, estado: 'confirmada', check_out: { $gte: hoje } }),
      ReservaExterna.countDocuments({ propriedade_id: f.propriedade_id._id, canal_chave: f.canal_chave, estado: 'por_confirmar', check_out: { $gte: hoje } }),
    ]);
    out.push(fonteParaApi(f, { n_reservas: reservas, n_por_confirmar: por_confirmar }));
  }
  return resp(200, { fontes: out, ligado: chavesConfiguradas(), modo_teste: modoTesteAtivo() });
}

/** Últimas leituras. `completo` (gestor) inclui UID/datas e a amostra; o proprietário só o resumo. */
async function listarLeituras({ id, escopo, limite = 10, completo = false }) {
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  const lim = Math.min(50, Math.max(1, parseInt(limite, 10) || 10));
  const campos = 'iniciada_em ultima_em repetidas resultado http_status n_eventos hash_normalizado prodid erro motivo_suspeita origem duracao_ms' + (completo ? ' eventos eventos_truncados amostra_redigida' : '');
  const leituras = await LeituraCalendario.find({ fonte_id: fonte._id }).sort({ iniciada_em: -1 }).limit(lim).select(campos).lean();
  return resp(200, { leituras: leituras.map((l) => ({ ...l, erro: l.erro ? { codigo: l.erro.codigo, mensagem: semUrl(mensagemErro(l.erro.codigo)) } : undefined })) });
}

/** Gestor: pausar, retomar ou aceitar o calendário como está. */
async function mudarEstado({ id, acao, escopo }) {
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  if (acao === 'pausar') {
    fonte.estado = 'pausada'; fonte.motivo_estado = 'pelo_gestor'; fonte.pausada_em = new Date();
  } else if (acao === 'retomar') {
    if (fonte.motivo_estado === 'casa_ligada_smoobu') return resp(400, { erro: 'Esta casa recebe as reservas pelo Smoobu.' });
    fonte.estado = 'ativa'; fonte.motivo_estado = null; fonte.pausada_em = undefined; fonte.erros_consecutivos = 0; fonte.proxima_leitura_em = new Date();
  } else if (acao === 'aceitar_calendario') {
    fonte.referencia_futuros = fonte.ultimo_n_futuros || 0; fonte.suspeitas_consecutivas = 0; fonte.aceitar_proxima = true; fonte.aviso_suspeita_enviado_em = undefined; fonte.proxima_leitura_em = new Date();
  } else return resp(400, { erro: 'Ação inválida.' });
  await fonte.save();
  return resp(200, { fonte: fonteParaApi(fonte.toObject()) });
}

/** Períodos por confirmar (ou com conflito) do escopo. */
async function listarReservasExternas({ escopo, estado = 'por_confirmar', parceiroId = null }) {
  const hoje = Rv.dataDe(H.hojeLisboa());
  const filtro = { empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}), check_out: { $gte: hoje } };
  if (parceiroId && !escopo.parceiroId && mongoose.isValidObjectId(parceiroId)) filtro.parceiro_id = parceiroId;
  if (estado === 'conflito') filtro.conflito = { $in: ['limpeza_em_curso', 'limpeza_concluida'] };
  else if (['por_confirmar', 'bloqueio'].includes(estado)) filtro.estado = estado;
  else return resp(400, { erro: 'Estado inválido.' });
  const lista = await ReservaExterna.find(filtro).populate('propriedade_id', 'nome').sort({ check_in: 1 }).limit(500)
    .select('propriedade_id canal canal_chave check_in check_out noites classe estado motivo conflito decidido_por').lean();
  return resp(200, {
    reservas_externas: lista.map((x) => ({
      _id: String(x._id), propriedade: { _id: String(x.propriedade_id._id), nome: x.propriedade_id.nome },
      canal: x.canal, canal_texto: ({ airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo' })[x.canal] || 'Outro canal',
      check_in: Rv.iso(x.check_in), check_out: Rv.iso(x.check_out), noites: x.noites, motivo: x.motivo, estado: x.estado, conflito: x.conflito, decidido_por: x.decidido_por,
    })),
  });
}

module.exports = {
  fonteParaApi, testarLigacao, criarLigacao, substituirLigacao, atualizarAgora, reativarLigacao, impactoRemocao, removerLigacao,
  listarLigacoes, listarLeituras, mudarEstado, listarReservasExternas, limiteTestar, limparLimiteTestar, MESES_ERRO_DIAS,
};
