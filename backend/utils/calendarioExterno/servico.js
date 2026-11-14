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
const { acordoPermiteLigar, MSG_POR_ACEITAR } = require('../acordoRgpd');
const { registarAuditoria } = require('../auditoria');
const { chavesConfiguradas, cifrar, decifrar, hmac, semUrl } = require('./cifra');
const { analisarUrl, normalizarUrl, mascara, modoTesteAtivo } = require('./seguranca');
const { buscarFeed, pedir } = require('./buscar');
const { analisarIcal } = require('./parser');
const { sincronizarFonte, configDoAmbiente } = require('./sincronizar');
const { removerFonte, contarImpactoRemocao } = require('./decisoes');
const { MENSAGENS_ESTADO, mensagemErro, textoMuitosNovos, eErroTemporario, canalTexto } = require('./mensagens');
const { tentarTeste, limparLimiteTestes } = require('./limiteTestes');
const Empresa = require('../../models/Empresa');
const Utilizador = require('../../models/Utilizador');
const { avisarParceiro } = require('./avisos');
const Rv = require('./reservas');

const resp = (status, body) => ({ status, body });
const MSG_DESLIGADA = 'A ligação a calendários externos ainda não está configurada. Fala com o gestor.';
const INTERVALO_MANUAL_MS = 10 * 60000;

const limparLimiteTestar = limparLimiteTestes;

const MESES_ERRO_DIAS = 14;

/** Forma pública de uma fonte (sem link). */
function fonteParaApi(f, extra = {}, { paraGestor = false } = {}) {
  const nomeCanal = canalTexto(f.canal, f.rotulo);
  const erro = f.ultimo_erro && f.ultimo_erro.codigo
    ? {
      em: f.ultimo_erro.em, codigo: f.ultimo_erro.codigo, http_status: f.ultimo_erro.http_status,
      temporario: eErroTemporario(f.ultimo_erro.codigo),
      mensagem: semUrl(mensagemErro(f.ultimo_erro.codigo, { canal: nomeCanal, paraGestor })),
    }
    : null;
  return {
    _id: String(f._id),
    propriedade_id: String(f.propriedade_id && f.propriedade_id._id ? f.propriedade_id._id : f.propriedade_id),
    propriedade_nome: f.propriedade_id && f.propriedade_id.nome ? f.propriedade_id.nome : undefined,
    parceiro_id: String(f.parceiro_id),
    canal: f.canal, rotulo: f.rotulo || null,
    canal_texto: nomeCanal,
    url_mascara: f.url_mascara, url_host: f.url_host,
    estado: f.estado, motivo_estado: f.motivo_estado || null,
    estado_texto: f.motivo_estado ? MENSAGENS_ESTADO[f.motivo_estado] || null : null,
    ultima_leitura_em: f.ultima_leitura_em || null, ultimo_sucesso_em: f.ultimo_sucesso_em || null, ultima_alteracao_em: f.ultima_alteracao_em || null,
    proxima_leitura_em: f.proxima_leitura_em || null,
    erros_consecutivos: f.erros_consecutivos || 0, suspeitas_consecutivas: f.suspeitas_consecutivas || 0,
    ultimo_erro: erro, createdAt: f.createdAt,
    em_validacao: !!f.aviso_muitos_novos_em,
    aviso_validacao: f.aviso_muitos_novos_em ? textoMuitosNovos(f.ultimo_n_futuros || 0, paraGestor) : null,
    ...extra,
  };
}

/** Ids de proprietários que ainda não aceitaram o acordo (vazio se o acordo não for exigido). */
async function parceirosSemAcordo(ids) {
  const { acordoObrigatorio, aceitacoesVigentes } = require('../acordoRgpd');
  if (!acordoObrigatorio()) return new Set();
  const unicos = [...new Set(ids)];
  const aceites = await aceitacoesVigentes(unicos);
  return new Set(unicos.filter((i) => !aceites.has(i)));
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
  if (c.casa.smoobu_id) return { erro: resp(400, { erro: 'Esta casa recebe as reservas do Smoobu; não pode ter também calendários Airbnb/Booking.', codigo: 'CASA_SMOOBU' }) };
  const est = await estadoDaCasa(c.casa);
  if (est.inativa) return { erro: resp(409, { erro: est.mensagem, codigo: 'CASA_INATIVA' }) };
  if (!(await acordoPermiteLigar(c.casa.parceiro_id))) return { erro: resp(409, { erro: MSG_POR_ACEITAR, codigo: 'ACORDO_POR_ACEITAR' }) };
  const analise = analisarUrl(url);
  if (!analise.ok) return { erro: resp(400, { erro: analise.erro, codigo: analise.codigo }) };
  return { casa: c.casa, analise };
}

/**
 * Corpo do erro «link já usado»: diz em que casa (e de que proprietário) está, mas só se for da MESMA empresa;
 * um link de outra empresa nunca revela nada (nem nomes, nem que casa é).
 */
async function corpoLinkUsado(outra, empresaId, codigo) {
  if (String(outra.empresa_id) !== String(empresaId)) return { erro: 'Este link já está a ser usado noutro sítio. Confirma que copiaste o da casa certa.', codigo };
  const [casa, dono] = await Promise.all([
    Propriedade.findById(outra.propriedade_id).select('nome').lean(),
    Utilizador.findById(outra.parceiro_id).select('nome').lean(),
  ]);
  const onde = casa && casa.nome ? `na casa ${casa.nome}${dono && dono.nome ? `, de ${dono.nome}` : ''}` : 'noutra casa';
  return {
    erro: `Este link já está a ser usado ${onde}. Confirma que copiaste o da casa certa.`, codigo,
    ...(casa ? { casa: { nome: casa.nome }, proprietario: dono ? { nome: dono.nome } : null } : {}),
  };
}

/** «Testar ligação»: lê e analisa SEM gravar nada. */
async function testarLigacao({ propriedadeId, url, escopo, utilizadorId = null, transporte = pedir, agora = Date.now() }) {
  const v = await validarPedido({ propriedadeId, url, escopo });
  if (v.erro) return v.erro;
  const { casa, analise } = v;
  const hash = hmac(normalizarUrl(analise.url, analise.canal));
  const outra = await FonteCalendario.findOne({ url_hash: hash, removida: false }).select('propriedade_id parceiro_id empresa_id').lean();
  if (outra && String(outra.propriedade_id) !== String(casa._id)) return resp(409, await corpoLinkUsado(outra, escopo.empresaId, 'LINK_USADO'));
  // Os travões só contam testes que chegam à rede: links inválidos ou repetidos já foram recusados acima.
  const limite = tentarTeste({ utilizadorId, empresaId: escopo.empresaId, host: analise.host, linkHash: hash, agora });
  if (!limite.ok) return resp(429, { erro: limite.mensagem, codigo: 'LIMITE_TESTES', motivo: limite.motivo, ate: limite.ate });
  const existente = await FonteCalendario.findOne({ propriedade_id: casa._id, canal_chave: analise.canal_chave, removida: false }).select('_id').lean();
  let feed; let parsed;
  try {
    feed = await buscarFeed(url.trim(), { transporte });
    parsed = analisarIcal(feed.texto, { canal: analise.canal, hmac: (t) => hmac(t) });
  } catch (e) {
    return resp(200, { ok: false, canal: analise.canal, canal_texto: analise.rotulo, erro: mensagemErro(e.codigo || 'outro', { canal: analise.rotulo }), codigo: e.codigo || 'outro', temporario: eErroTemporario(e.codigo || 'outro') });
  }
  const p = String(parsed.prodid || '');
  const prodidOk = analise.canal === 'airbnb' ? /airbnb/i.test(p) : analise.canal === 'booking' ? /booking\.com/i.test(p) : true;
  const c = parsed.contadores;
  const manuais = await ReservaManual.find({ propriedade_id: casa._id, check_out: { $gte: Rv.dataDe(H.hojeLisboa()) }, cancelada_em: null }).select('check_in check_out').lean();
  const coincidem = parsed.eventos.filter((e) => manuais.some((m) => Rv.iso(m.check_out) === e.co && Rv.iso(m.check_in) < e.co && e.ci < Rv.iso(m.check_out))).length;
  return resp(200, {
    ok: true, canal: analise.canal, canal_texto: analise.rotulo, host: analise.host, prodid_ok: prodidOk,
    reservas: c.reserva, bloqueios: c.bloqueio, por_confirmar: c.incerto,
    periodo: parsed.eventos.length ? { de: parsed.eventos.reduce((m, e) => (e.ci < m ? e.ci : m), parsed.eventos[0].ci), ate: parsed.eventos.reduce((m, e) => (e.co > m ? e.co : m), parsed.eventos[0].co) } : null,
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
  const repetida = await FonteCalendario.findOne({ url_hash: hash, removida: false }).select('propriedade_id parceiro_id empresa_id').lean();
  if (repetida) {
    if (String(repetida.propriedade_id) === String(casa._id)) return resp(409, { erro: 'Este link já está a ser usado nesta casa.', codigo: 'LINK_REPETIDO' });
    return resp(409, await corpoLinkUsado(repetida, escopo.empresaId, 'LINK_REPETIDO'));
  }
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
  if (ator.tipo === 'gestor') {
    avisarParceiro(casa.parceiro_id, escopo.empresaId, `O gestor ligou o calendário ${analise.rotulo} da casa ${casa.nome}.`);
  }
  let leitura = null;
  try { leitura = await sincronizarFonte(_id, { origem: 'agendada', transporte }); } catch (e) { console.error('⚠️  primeira leitura do calendário:', semUrl(e.message)); }
  const atual = await FonteCalendario.findById(_id).lean();
  return resp(201, { fonte: fonteParaApi(atual, {}, { paraGestor: !escopo.parceiroId }), leitura: resumoLeitura(leitura) });
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
  if (!(await acordoPermiteLigar(fonte.parceiro_id))) return resp(409, { erro: MSG_POR_ACEITAR, codigo: 'ACORDO_POR_ACEITAR' });
  if (typeof url !== 'string') return resp(400, { erro: 'O link tem de ser um texto.' });
  const analise = analisarUrl(url);
  if (!analise.ok) return resp(400, { erro: analise.erro, codigo: analise.codigo });
  if (analise.canal_chave !== fonte.canal_chave) return resp(400, { erro: 'O novo link tem de ser do mesmo canal.' });
  const hash = hmac(normalizarUrl(analise.url, analise.canal));
  const usada = await FonteCalendario.findOne({ url_hash: hash, removida: false, _id: { $ne: fonte._id } }).select('propriedade_id parceiro_id empresa_id').lean();
  if (usada) return resp(409, await corpoLinkUsado(usada, escopo.empresaId, 'LINK_REPETIDO'));
  fonte.url_cifrada = cifrar(analise.url.href, String(fonte._id)); fonte.url_hash = hash; fonte.url_mascara = mascara(analise.url); fonte.url_host = analise.host.slice(0, 120);
  fonte.estado = 'ativa'; fonte.motivo_estado = null; fonte.erros_consecutivos = 0; fonte.etag = undefined; fonte.last_modified = undefined; fonte.ultimo_erro = undefined; fonte.aviso_falha_enviado_em = undefined;
  fonte.proxima_leitura_em = new Date();
  await fonte.save();
  registarAuditoria({ utilizador_id: ator.id, utilizador_nome: ator.nome || '', empresa_id: escopo.empresaId, acao: 'atualizar', recurso: 'calendario_externo', recurso_id: String(fonte._id), descricao: `Link do calendário substituído (${fonte.url_mascara})` });
  let leitura = null;
  try { leitura = await sincronizarFonte(fonte._id, { origem: 'agendada', transporte }); } catch (e) { console.error('⚠️  leitura após substituir:', semUrl(e.message)); }
  return resp(200, { fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean(), {}, { paraGestor: !escopo.parceiroId }), leitura: resumoLeitura(leitura) });
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
  return resp(200, { fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean(), {}, { paraGestor: !escopo.parceiroId }), leitura: resumoLeitura(l) });
}

/** Reativar uma fonte em erro/suspensa depois de testar a ligação (não serve para casas com Smoobu). */
async function reativarLigacao({ id, escopo, transporte = pedir }) {
  if (!chavesConfiguradas()) return resp(503, { erro: MSG_DESLIGADA, codigo: 'DESLIGADA' });
  const fonte = await FonteCalendario.findOne({ _id: mongoose.isValidObjectId(id) ? id : null, removida: false, empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}) }).select('+url_cifrada');
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  if (fonte.motivo_estado === 'casa_ligada_smoobu') return resp(400, { erro: 'Esta casa recebe as reservas pelo Smoobu: não pode ter calendários externos.' });
  if (!(await acordoPermiteLigar(fonte.parceiro_id))) return resp(409, { erro: MSG_POR_ACEITAR, codigo: 'ACORDO_POR_ACEITAR' });
  try {
    const feed = await buscarFeed(decifrar(fonte.url_cifrada, String(fonte._id)), { transporte });
    analisarIcal(feed.texto, { canal: fonte.canal, hmac: (t) => hmac(t) });
  } catch (e) {
    return resp(200, { ok: false, erro: mensagemErro(e.codigo || 'outro', { canal: canalTexto(fonte.canal, fonte.rotulo) }), codigo: e.codigo || 'outro', temporario: eErroTemporario(e.codigo || 'outro') });
  }
  await FonteCalendario.updateOne({ _id: fonte._id }, { $set: { estado: 'ativa', motivo_estado: null, erros_consecutivos: 0, proxima_leitura_em: new Date() }, $unset: { ultimo_erro: 1, pausada_em: 1 } });
  const l = await sincronizarFonte(fonte._id, { origem: 'retoma', transporte, esperaLockMs: 3000 });
  return resp(200, { ok: true, fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean(), {}, { paraGestor: !escopo.parceiroId }), leitura: resumoLeitura(l) });
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
  const semAcordo = await parceirosSemAcordo(fontes.map((f) => String(f.parceiro_id)));
  for (const f of fontes) {
    if (semAcordo.has(String(f.parceiro_id)) && f.estado === 'ativa') Object.assign(f, { estado: 'pausada', motivo_estado: 'acordo_por_aceitar' });
    const [reservas, por_confirmar] = await Promise.all([
      ReservaExterna.countDocuments({ propriedade_id: f.propriedade_id._id, canal_chave: f.canal_chave, estado: 'confirmada', check_out: { $gte: hoje } }),
      ReservaExterna.countDocuments({ propriedade_id: f.propriedade_id._id, canal_chave: f.canal_chave, estado: 'por_confirmar', check_out: { $gte: hoje } }),
    ]);
    out.push(fonteParaApi(f, { n_reservas: reservas, n_por_confirmar: por_confirmar }, { paraGestor: !escopo.parceiroId }));
  }
  // O proprietário não corrige links: se algo falha, contacta a empresa (se tiver contacto no perfil).
  let contacto = null;
  if (escopo.parceiroId) {
    const emp = await Empresa.findById(escopo.empresaId).select('nome telefone email').lean();
    if (emp && (emp.telefone || emp.email)) contacto = { nome: emp.nome || null, telefone: emp.telefone || null, email: emp.email || null };
  }
  return resp(200, { fontes: out, ligado: chavesConfiguradas(), modo_teste: modoTesteAtivo(), ...(escopo.parceiroId ? { contacto } : {}) });
}

/** Últimas leituras. `completo` (gestor) inclui UID/datas e a amostra; o proprietário só o resumo. */
async function listarLeituras({ id, escopo, limite = 10, completo = false }) {
  const fonte = await fonteDoEscopo(id, escopo);
  if (!fonte) return resp(404, { erro: 'Calendário não encontrado.' });
  const lim = Math.min(50, Math.max(1, parseInt(limite, 10) || 10));
  const campos = 'iniciada_em ultima_em repetidas resultado http_status n_eventos hash_normalizado prodid erro motivo_suspeita origem duracao_ms' + (completo ? ' eventos eventos_truncados amostra_redigida' : '');
  const leituras = await LeituraCalendario.find({ fonte_id: fonte._id }).sort({ iniciada_em: -1 }).limit(lim).select(campos).lean();
  return resp(200, { leituras: leituras.map((l) => ({ ...l, erro: l.erro ? { codigo: l.erro.codigo, mensagem: semUrl(mensagemErro(l.erro.codigo, { canal: canalTexto(fonte.canal, fonte.rotulo), paraGestor: completo })) } : undefined })) });
}

/** Gestor: pausar, retomar ou aceitar o calendário como está. */
async function mudarEstado({ id, acao, escopo, ator = null, transporte = pedir }) {
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
  // «Aceitar» dá resposta imediata: lê já o calendário (sem esperar pela próxima leitura agendada) e cria as limpezas.
  // (Só para o gestor: o proprietário não dispara leituras à rede com este botão; a leitura agendada apanha-o logo a seguir.)
  let leitura = null;
  if (acao === 'aceitar_calendario' && !escopo.parceiroId) {
    try { leitura = await sincronizarFonte(fonte._id, { origem: 'manual_gestor', transporte, esperaLockMs: 3000 }); } catch (e) { console.error('⚠️  leitura após aceitar:', semUrl(e.message)); }
    return resp(200, { fonte: fonteParaApi(await FonteCalendario.findById(fonte._id).lean(), {}, { paraGestor: !escopo.parceiroId }), leitura: resumoLeitura(leitura) });
  }
  return resp(200, { fonte: fonteParaApi(fonte.toObject(), {}, { paraGestor: !escopo.parceiroId }) });
}

/**
 * Depois de o proprietário aceitar o acordo: as ligações que estavam em pausa por isso voltam já a funcionar
 * (não esperam pelo job horário). Melhor esforço: nunca lança. Lê já as primeiras; o job apanha as restantes.
 */
async function retomarAposAcordo({ parceiroId, empresaId, transporte = pedir, maxLeiturasImediatas = 5 }) {
  try {
    const filtro = { parceiro_id: parceiroId, empresa_id: empresaId, removida: false, estado: 'pausada', motivo_estado: 'acordo_por_aceitar' };
    const fontes = await FonteCalendario.find(filtro).select('_id').lean();
    if (!fontes.length) return { retomadas: 0 };
    await FonteCalendario.updateMany(filtro, { $set: { estado: 'ativa', motivo_estado: null, proxima_leitura_em: new Date() }, $unset: { pausada_em: 1 } });
    for (const f of fontes.slice(0, maxLeiturasImediatas)) {
      // eslint-disable-next-line no-await-in-loop
      await sincronizarFonte(f._id, { origem: 'retoma', transporte, esperaLockMs: 1000 }).catch((e) => console.error('⚠️  leitura após o acordo:', semUrl(e.message)));
    }
    return { retomadas: fontes.length };
  } catch (e) {
    console.error('⚠️  retomar após o acordo:', semUrl(e.message));
    return { retomadas: 0 };
  }
}

const LIMITE_LISTA_EXTERNAS = 500;

/**
 * Ids dos proprietários e das casas INATIVOS da empresa: os seus períodos não aparecem por defeito (não se
 * podem confirmar: dariam 409) e não contam no selo, no separador nem no painel «Precisam de atenção».
 */
async function inativosDaEmpresa(empresaId) {
  const [donos, casas] = await Promise.all([
    Utilizador.find({ empresa_id: empresaId, role: 'parceiro', $or: [{ ativo: false }, { eliminado_em: { $ne: null } }] }).select('_id').lean(),
    Propriedade.find({ empresa_id: empresaId, ativo: false }).select('_id').lean(),
  ]);
  return { donos: donos.map((d) => d._id), casas: casas.map((c) => c._id) };
}

/**
 * Períodos por confirmar (ou com conflito) do escopo. Devolve também `total` (para dizer «a mostrar 500 de 612»);
 * `pular` pagina, `proximosDias` filtra pelos que entram nos próximos N dias e `incluirInativos` mostra os de
 * casas/proprietários inativos (que não se podem confirmar).
 */
async function listarReservasExternas({ escopo, estado = 'por_confirmar', parceiroId = null, pular = 0, proximosDias = null, incluirInativos = false }) {
  const hoje = Rv.dataDe(H.hojeLisboa());
  const filtro = { empresa_id: escopo.empresaId, ...(escopo.parceiroId ? { parceiro_id: escopo.parceiroId } : {}), check_out: { $gte: hoje } };
  if (parceiroId && !escopo.parceiroId && mongoose.isValidObjectId(parceiroId)) filtro.parceiro_id = parceiroId;
  if (estado === 'conflito') filtro.conflito = { $in: ['limpeza_em_curso', 'limpeza_concluida'] };
  else if (['por_confirmar', 'bloqueio'].includes(estado)) filtro.estado = estado;
  else return resp(400, { erro: 'Estado inválido.' });
  const dias = parseInt(proximosDias, 10);
  if (Number.isInteger(dias) && dias > 0 && dias <= 365) filtro.check_in = { $lte: Rv.dataDe(H.somarDiasISO(H.hojeLisboa(), dias)) };
  if (!incluirInativos && !escopo.parceiroId) {
    const ina = await inativosDaEmpresa(escopo.empresaId);
    if (ina.donos.length) filtro.parceiro_id = filtro.parceiro_id ? { $eq: filtro.parceiro_id, $nin: ina.donos } : { $nin: ina.donos };
    if (ina.casas.length) filtro.propriedade_id = { $nin: ina.casas };
  }
  const saltar = Math.max(0, parseInt(pular, 10) || 0);
  const [total, lista] = await Promise.all([
    ReservaExterna.countDocuments(filtro),
    ReservaExterna.find(filtro).populate('propriedade_id', 'nome').populate('parceiro_id', 'nome').sort({ check_in: 1, _id: 1 }).skip(saltar).limit(LIMITE_LISTA_EXTERNAS)
      .select('propriedade_id canal canal_chave check_in check_out noites classe estado motivo conflito decidido_por').lean(),
  ]);
  return resp(200, {
    total, limite: LIMITE_LISTA_EXTERNAS, desde: saltar, mostrando: lista.length,
    reservas_externas: lista.map((x) => ({
      _id: String(x._id), propriedade: { _id: String(x.propriedade_id._id), nome: x.propriedade_id.nome },
      parceiro: x.parceiro_id ? { _id: String(x.parceiro_id._id), nome: x.parceiro_id.nome } : null,
      canal: x.canal, canal_texto: ({ airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo' })[x.canal] || 'Outro canal',
      check_in: Rv.iso(x.check_in), check_out: Rv.iso(x.check_out), noites: x.noites, motivo: x.motivo, estado: x.estado, conflito: x.conflito, decidido_por: x.decidido_por,
    })),
  });
}

module.exports = {
  fonteParaApi, testarLigacao, criarLigacao, substituirLigacao, atualizarAgora, reativarLigacao, impactoRemocao, removerLigacao,
  parceirosSemAcordo, retomarAposAcordo, inativosDaEmpresa, listarLigacoes, listarLeituras, mudarEstado, listarReservasExternas, limparLimiteTestar, MESES_ERRO_DIAS,
};
