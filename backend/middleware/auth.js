/**
 * Middleware de Autenticação (JWT) — All2gether
 *
 * Lê o token do header `Authorization: Bearer <token>`, verifica-o e injeta
 * o payload em `req.user` ({ id, role, empresa_id }).
 *
 * Comportamento (ESTRITO — sem fallback legacy):
 *   - Se o token for válido → `req.user` fica preenchido e o pedido continua.
 *   - Se faltar o header / token malformado / token inválido ou expirado →
 *     responde 401 e o pedido pára.
 *
 * v1.10.0: o fallback legacy `x-empresa-id` foi REMOVIDO. O frontend está
 * 100% com JWT, pelo que qualquer pedido sem token válido é recusado.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Utilizador = require('../models/Utilizador');

// SEGURANÇA (fail-closed): em produção o segredo é OBRIGATÓRIO (>= 32 chars).
// O fallback só existe para desenvolvimento/testes locais.
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
) {
  throw new Error(
    'JWT_SECRET em falta ou demasiado curto (mín. 32 caracteres) em produção. Defina-o nas variáveis de ambiente.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET || 'all2gether-dev-secret-change-me';

function extrairToken(req) {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) return null;
  // Formato esperado: "Bearer <token>"
  const partes = header.split(' ');
  if (partes.length === 2 && /^bearer$/i.test(partes[0])) {
    return partes[1];
  }
  return null;
}

// SEGURANÇA (A4): o JWT dura vários dias, por isso confirmamos a cada pedido
// que o utilizador continua ativo e não foi eliminado. Cache curta (30 s) para
// não sobrecarregar a BD; 0 em testes para resultados determinísticos.
const CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 30 * 1000;
const cacheUtilizadores = new Map(); // id -> { ok, ate }

async function utilizadorContinuaAtivo(id) {
  if (!mongoose.isValidObjectId(id)) return false;
  const agora = Date.now();
  const emCache = cacheUtilizadores.get(String(id));
  if (emCache && emCache.ate > agora) return emCache.ok;

  const u = await Utilizador.findById(id).select('ativo eliminado_em').lean();
  const ok = Boolean(u && u.ativo !== false && !u.eliminado_em);
  if (CACHE_TTL_MS > 0) {
    if (cacheUtilizadores.size > 5000) cacheUtilizadores.clear();
    cacheUtilizadores.set(String(id), { ok, ate: agora + CACHE_TTL_MS });
  }
  return ok;
}

async function auth(req, res, next) {
  const token = extrairToken(req);

  if (!token) {
    return res.status(401).json({
      erro: 'Autenticação obrigatória. Envie Authorization: Bearer <token>.',
    });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }

  try {
    if (!(await utilizadorContinuaAtivo(payload.id))) {
      return res.status(401).json({ erro: 'Sessão inválida. Inicie sessão novamente.' });
    }
  } catch (err) {
    console.error('❌ auth: falha a validar utilizador:', err.message);
    return res.status(503).json({ erro: 'Serviço temporariamente indisponível.' });
  }

  req.user = {
    id: payload.id,
    role: payload.role,
    empresa_id: payload.empresa_id,
  };
  return next();
}

module.exports = { auth, JWT_SECRET };
