/**
 * Middleware de Controlo de Acesso por Role (RBAC) — FisioCell
 *
 * Hierarquia (v1.29.0):
 *   admin  → Super Admin (dono da conta, gestão total)
 *   gestor → Gestor de Operações (gere equipa, aprova faltas, vê dashboard)
 *   staff  → Executante de limpezas (vê só as suas tarefas)
 *
 * Middlewares:
 *   isGestor — admin OU gestor (gestão operacional: propriedades, equipa, ausências)
 *   isAdmin  — só admin (ações sensíveis: criar admins, setup, etc.)
 *
 * Uso:
 *   const { isGestor, isAdmin } = require('../middleware/requireRole');
 *   router.patch('/ausencias/:id/estado', auth, isGestor, aprovar);
 *
 * Nota: o `auth` deve ser sempre chamado antes (injeta req.user com o role).
 */

/**
 * Cria um middleware que só deixa passar se o role do utilizador (req.user.role)
 * estiver na lista de roles permitidas.
 *
 * @param  {...string} rolesPermitidas — ex: 'admin', 'gestor'
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

/**
 * isGestor — permite admin e gestor.
 * O admin tem todas as permissões do gestor (para testes e supervisão).
 * Usado para: dashboard, propriedades, equipa, ausências, tarefas, webhooks, etc.
 */
const isGestor = requireRole('admin', 'gestor');

/**
 * isAdmin — ESTRITO. Só admin.
 * Usado para: criar outros admins, setup, configurações sensíveis.
 */
const isAdmin = requireRole('admin');

// Atalhos legacy (compatibilidade — requireManager = isGestor).
const requireManager = isGestor;
const requireAdmin = isAdmin;
const requireStaff = requireRole('staff', 'gestor');

module.exports = {
  requireRole,
  isGestor,
  isAdmin,
  // Legacy (não quebrar código existente)
  requireManager,
  requireAdmin,
  requireStaff,
};
