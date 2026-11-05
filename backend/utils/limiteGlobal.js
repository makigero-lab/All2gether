/**
 * Limite global de pedidos de /api/ — All2gether.
 *
 * Problema que resolve: os proxies Next (Vercel) chamam o backend a partir do
 * servidor e NÃO reencaminham o IP do cliente, pelo que em produção muitos
 * utilizadores chegam com os mesmos IPs da Vercel e partilhavam 100 pedidos /
 * 15 min. Agora:
 *   - pedido com JWT VÁLIDO (assinatura, expiração e algoritmo verificados
 *     pelo mesmo código do middleware `auth`) -> chave `u:<id>`, 1000 / 15 min;
 *   - sem JWT válido (ausente, malformado, forjado, expirado) -> chave por IP
 *     (`req.ip`, já tratado por `trust proxy`), 100 / 15 min.
 * Um token não verificado NUNCA gera uma chave própria, por isso forjar tokens
 * não permite contornar o limite nem criar entradas novas.
 * Não se confia em cabeçalhos do cliente (x-forwarded-for etc.) além do que
 * `trust proxy` já faz.
 */

const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { extrairToken, verificarJwt } = require('../middleware/auth');

const JANELA_MS = 15 * 60 * 1000;
const MAX_UTILIZADOR = 1000;
const MAX_IP = 100;

// Devolve o id do utilizador se o pedido trouxer um JWT válido; senão null.
function utilizadorDoPedido(req) {
  const token = extrairToken(req);
  if (!token) return null;
  const payload = verificarJwt(token);
  if (!payload || !payload.id) return null;
  const id = String(payload.id);
  return mongoose.isValidObjectId(id) ? id : null;
}

function chaveGlobal(req) {
  const id = utilizadorDoPedido(req);
  return id ? `u:${id}` : `ip:${ipKeyGenerator(req.ip || '')}`;
}

function maximoGlobal(req) {
  return utilizadorDoPedido(req) ? MAX_UTILIZADOR : MAX_IP;
}

// Rotas isentas do limite global:
//  - /api/smoobu: webhooks M2M (têm o seu limitador e autenticação próprios);
//  - POST /api/auth/login: tem loginLimiter + loginAccountLimiter e não pode
//    ser bloqueado por pedidos normais da aplicação.
// req.originalUrl (e não req.path): dentro de app.use('/api/') o path é relativo.
function isentoDoLimiteGlobal(req) {
  const url = req.originalUrl || '';
  if (url.startsWith('/api/smoobu')) return true;
  return req.method === 'POST' && /^\/api\/auth\/login(?:[/?]|$)/.test(url);
}

// `forcar` permite aos testes ativar os limites reais (em NODE_ENV=test o
// limite é infinito para não bloquear os testes de integração).
function criarLimiteGlobal({ forcar = false } = {}) {
  const desligado = process.env.NODE_ENV === 'test' && !forcar;
  return rateLimit({
    windowMs: JANELA_MS,
    limit: desligado ? Infinity : maximoGlobal,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitos pedidos. Tente novamente mais tarde.' },
    keyGenerator: chaveGlobal,
    validate: { keyGeneratorIpFallback: false },
    skip: isentoDoLimiteGlobal,
  });
}

module.exports = {
  criarLimiteGlobal,
  chaveGlobal,
  maximoGlobal,
  isentoDoLimiteGlobal,
  MAX_UTILIZADOR,
  MAX_IP,
};
