/**
 * Fornecedor Routes — Portal da Lavandaria (FIX: portal lavandaria).
 *
 * Prefixo montado em server.js: /api/fornecedor
 *
 * Todas as rotas usam `auth` + `isFornecedor` (role 'fornecedor').
 * O fornecedor vê tarefas dos próximos 7 dias e marca roupa_entregue.
 */

const express = require('express');
const { auth } = require('../middleware/auth');
const { isFornecedor } = require('../middleware/requireRole');
const {
  listarTarefas,
  marcarRoupaEntregue,
} = require('../controllers/fornecedorController');

const router = express.Router();

// GET /api/fornecedor/tarefas — Tarefas dos próximos 7 dias.
router.get('/tarefas', auth, isFornecedor, listarTarefas);

// PATCH /api/fornecedor/tarefas/:id/roupa — Marca/desmarca roupa_entregue.
router.patch('/tarefas/:id/roupa', auth, isFornecedor, marcarRoupaEntregue);

module.exports = router;
