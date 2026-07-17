/**
 * Middleware de Autenticação (JWT) — FisioCell
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

const JWT_SECRET = process.env.JWT_SECRET || 'fisiocell-dev-secret-change-me';

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

function auth(req, res, next) {
  const token = extrairToken(req);

  if (!token) {
    return res.status(401).json({
      erro: 'Autenticação obrigatória. Envie Authorization: Bearer <token>.',
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      role: payload.role,
      empresa_id: payload.empresa_id,
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      erro: 'Token inválido ou expirado.',
      detalhe: err.message,
    });
  }
}

module.exports = { auth, JWT_SECRET };
