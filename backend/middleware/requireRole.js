/**
 * Middleware de Controlo de Acesso por Role — Autocell
 *
 * Hierarquia:
 *   admin   → dono da conta (gestão total)
 *   manager → gestor responsável (gere equipa, aprova faltas, vê dashboard)
 *   staff   → executante de limpezas (vê só as suas tarefas)
 *
 * Uso:
 *   const { requireRole } = require('../middleware/requireRole');
 *   router.patch('/ausencias/:id/estado', auth, requireRole('admin', 'manager'), aprovar);
 *
 * Nota: o `auth` deve ser sempre chamado antes (injeta req.user com o role).
 */

/**
 * Cria um middleware que só deixa passar se o role do utilizador (req.user.role)
 * estiver na lista de roles permitidas.
 *
 * @param  {...string} rolesPermitidas — ex: 'admin', 'manager'
 * @returns {Function} middleware Express
 */
function requireRole(...rolesPermitidas) {
  return (req, res, next) => {
    const role = req.user && req.user.role;

    if (!role) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    if (!rolesPermitidas.includes(role)) {
      return res.status(403).json({
        erro: `Acesso negado. Esta ação requer role: ${rolesPermitidas.join(' ou ')}.`,
      });
    }

    return next();
  };
}

// Atalhos pré-configurados para uso comum.
const requireAdmin = requireRole('admin');
const requireManager = requireRole('admin', 'manager'); // admin pode tudo; manager gere
const requireStaff = requireRole('staff', 'manager'); // staff e manager (manager também executa limpezas)

module.exports = { requireRole, requireAdmin, requireManager, requireStaff };
