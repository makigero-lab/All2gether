/**
 * Acordo de Tratamento de Dados do proprietário (art. 28.º RGPD) — All2gether.
 *
 * O mecanismo está sempre construído, mas SÓ É EXIGIDO quando ACORDO_RGPD_OBRIGATORIO=true (fase de testes:
 * desligado). Com o interruptor ligado: o gestor não liga calendários de um proprietário que não aceitou a
 * versão em vigor (409) e as ligações existentes ficam em pausa até ele aceitar.
 * O texto vive em PROP-DPA-1.0.md; a versão e o hash saem dele (alterar o texto exige nova versão).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const AceitacaoAcordo = require('../../models/AceitacaoAcordo');

const VERSAO_ATUAL = 'PROP-DPA-1.0';
const FICHEIRO = path.join(__dirname, `${VERSAO_ATUAL}.md`);
const MSG_POR_ACEITAR = 'O proprietário ainda não aceitou o Acordo de Tratamento de Dados. Só depois de aceitar é que podes ligar calendários das casas dele.';

const acordoObrigatorio = (env = process.env) => String(env.ACORDO_RGPD_OBRIGATORIO || '').toLowerCase() === 'true';

let cache = null;
function textoAtual() {
  if (!cache) {
    const bruto = fs.readFileSync(FICHEIRO, 'utf8').replace(/\r\n/g, '\n');
    const texto = bruto.replace(/^<!--[\s\S]*?-->\n/, '').trim() + '\n';
    cache = { versao: VERSAO_ATUAL, texto, hash: crypto.createHash('sha256').update(texto, 'utf8').digest('hex') };
  }
  return cache;
}

/** Último registo válido da versão em vigor (ou null). */
async function aceitacaoVigente(parceiroId) {
  if (!mongoose.isValidObjectId(parceiroId)) return null;
  const { versao, hash } = textoAtual();
  return AceitacaoAcordo.findOne({ parceiro_id: parceiroId, versao, hash_texto: hash, revogado_em: null }).sort({ aceite_em: -1 }).lean();
}

/** Mapa parceiroId -> aceitação vigente, numa só consulta (para a vista geral). */
async function aceitacoesVigentes(parceiroIds) {
  const { versao, hash } = textoAtual();
  const ids = parceiroIds.filter((i) => mongoose.isValidObjectId(i));
  if (!ids.length) return new Map();
  const regs = await AceitacaoAcordo.find({ parceiro_id: { $in: ids }, versao, hash_texto: hash, revogado_em: null }).select('parceiro_id aceite_em').lean();
  return new Map(regs.map((r) => [String(r.parceiro_id), r]));
}

/** 'nao_exigido' (interruptor desligado) | 'aceite' | 'por_aceitar'. */
async function estadoAcordo(parceiroId, env = process.env) {
  if (!acordoObrigatorio(env)) return 'nao_exigido';
  return (await aceitacaoVigente(parceiroId)) ? 'aceite' : 'por_aceitar';
}

/** true se o gestor pode ligar calendários deste proprietário. */
async function acordoPermiteLigar(parceiroId, env = process.env) {
  return (await estadoAcordo(parceiroId, env)) !== 'por_aceitar';
}

/** IP com o último octeto a zero (IPv4) ou só o prefixo (IPv6): suficiente como prova, menos pessoal. */
function truncarIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.replace(/\.\d{1,3}$/, '.0');
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + '::';
  return undefined;
}

/** Regista a aceitação (idempotente por versão: se já aceitou, devolve a existente). */
async function aceitar({ user, versao, hash, confirmo, ip, agente }) {
  const t = textoAtual();
  if (confirmo !== true) return { status: 400, body: { erro: 'Assinala a caixa para aceitar o acordo.' } };
  if (versao !== t.versao || hash !== t.hash) return { status: 409, body: { erro: 'O acordo foi atualizado. Volta a abrir e ler a versão atual.', codigo: 'VERSAO_DESATUALIZADA' } };
  const ja = await aceitacaoVigente(user.id);
  if (ja) return { status: 200, body: { aceite_em: ja.aceite_em, versao: t.versao } };
  const reg = await AceitacaoAcordo.create({
    empresa_id: user.empresa_id, parceiro_id: user.id, aceite_por_id: user.id, aceite_por_nome: user.nome || '', aceite_por_email: user.email || '',
    versao: t.versao, hash_texto: t.hash, contexto: 'portal', ip_truncado: truncarIp(ip), agente: String(agente || '').slice(0, 200),
  });
  return { status: 201, body: { aceite_em: reg.aceite_em, versao: t.versao } };
}

async function resumoParaPortal(user, env = process.env) {
  const t = textoAtual();
  const reg = await aceitacaoVigente(user.id);
  return { obrigatorio: acordoObrigatorio(env), versao: t.versao, hash: t.hash, texto: t.texto, aceite: !!reg, aceite_em: reg ? reg.aceite_em : null };
}

const limparCache = () => { cache = null; };

module.exports = {
  VERSAO_ATUAL, MSG_POR_ACEITAR, acordoObrigatorio, textoAtual, aceitacaoVigente, aceitacoesVigentes, estadoAcordo, acordoPermiteLigar, aceitar, resumoParaPortal, truncarIp, limparCache,
};
