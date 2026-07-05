/**
 * Rotas do Super Admin — Autocell
 *
 * Prefixo montado em server.js: /api/admin
 *
 * Endpoints exclusivos do Super Admin (role 'admin'):
 *   GET  /empresas                    — lista todas as empresas + gestor principal
 *   POST /empresas/:id/impersonar     — gera token JWT do gestor (impersonation)
 *
 * Segurança: todas as rotas usam auth + isAdmin (ESTRITO — só role 'admin').
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/requireRole');
const { listarEmpresas, impersonarGestor } = require('../controllers/superAdminController');

// Todas as rotas exigem auth + isAdmin (só Super Admin).
router.use(auth, isAdmin);

// Listar todas as empresas (cross-tenant) com gestor principal.
router.get('/empresas', listarEmpresas);

// Impersonar gestor de uma empresa (gera token JWT do gestor).
router.post('/empresas/:id/impersonar', impersonarGestor);

module.exports = router;
