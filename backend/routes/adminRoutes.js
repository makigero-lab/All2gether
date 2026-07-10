/**
 * Rotas do Super Admin — Autocell
 *
 * Prefixo montado em server.js: /api/admin
 *
 * Endpoints exclusivos do Super Admin (role 'admin'):
 *   GET    /empresas                                          — lista todas as empresas + gestor principal
 *   POST   /empresas/:id/impersonar                           — gera token JWT do gestor (impersonation)
 *   GET    /empresas/:empresaId/utilizadores                  — lista utilizadores de uma empresa (Prompt 101)
 *   POST   /empresas/:empresaId/utilizadores                  — cria gestor/staff numa empresa (Prompt 101)
 *   PATCH  /empresas/:empresaId/utilizadores/:utilizadorId/estado — alterna ativo/inativo (Prompt 101)
 *   DELETE /hard-reset                                        — apaga Propriedades + Tarefas da empresa (Prompt 108)
 *
 * Segurança: todas as rotas usam auth + isAdmin (ESTRITO — só role 'admin').
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/requireRole');
const {
  listarEmpresas,
  impersonarGestor,
  listarUtilizadoresEmpresa,
  criarUtilizadorEmpresa,
  alternarEstadoUtilizadorEmpresa,
} = require('../controllers/superAdminController');

// Todas as rotas exigem auth + isAdmin (só Super Admin).
router.use(auth, isAdmin);

// Listar todas as empresas (cross-tenant) com gestor principal.
router.get('/empresas', listarEmpresas);

// Impersonar gestor de uma empresa (gera token JWT do gestor).
router.post('/empresas/:id/impersonar', impersonarGestor);

// Prompt 101 — Gestão de utilizadores de empresas terceiras.
router.get('/empresas/:empresaId/utilizadores', listarUtilizadoresEmpresa);
router.post('/empresas/:empresaId/utilizadores', criarUtilizadorEmpresa);
router.patch(
  '/empresas/:empresaId/utilizadores/:utilizadorId/estado',
  alternarEstadoUtilizadorEmpresa
);

// Prompt 108 — Hard Reset: apaga TODAS as Propriedades e Tarefas da empresa
// do utilizador autenticado (admin). Rotas admin usam req.user.empresa_id
// do token. Se o admin for cross-tenant (sem empresa_id), apaga tudo.
router.delete('/hard-reset', async (req, res) => {
  try {
    const Propriedade = require('../models/Propriedade');
    const Tarefa = require('../models/Tarefa');
    const mongoose = require('mongoose');

    // Se o admin tem empresa_id, apaga só dessa empresa; senão apaga tudo.
    const empresaId = req.user && req.user.empresa_id;
    const filtro = empresaId && mongoose.isValidObjectId(empresaId)
      ? { empresa_id: empresaId }
      : {};

    const propsResult = await Propriedade.deleteMany(filtro);
    const tarefasResult = await Tarefa.deleteMany(filtro);

    console.log(
      `🗑️  Hard Reset por admin ${req.user?.email || '?'} — ` +
        `${propsResult.deletedCount} propriedade(s) e ${tarefasResult.deletedCount} tarefa(s) apagadas` +
        (empresaId ? ` (empresa ${empresaId}).` : ' (TODAS as empresas).')
    );

    return res.status(200).json({
      message: 'Base de dados limpa com sucesso. Propriedades e Tarefas eliminadas.',
      detalhe: {
        propriedades_apagadas: propsResult.deletedCount,
        tarefas_apagadas: tarefasResult.deletedCount,
        ambito: empresaId ? `empresa ${empresaId}` : 'todas as empresas',
      },
    });
  } catch (err) {
    console.error('❌ hard-reset:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.', detalhe: err.message });
  }
});

module.exports = router;
