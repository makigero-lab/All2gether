/**
 * Rotas do Staff — Autocell
 *
 * Prefixo montado em server.js: /api/staff
 *
 * Endpoints:
 *   GET    /ausencias       — histórico de ausências do próprio utilizador
 *   POST   /ausencias       — criar pedido de ausência (sempre 'pendente')
 *   DELETE /ausencias/:id   — cancelar pedido pendente (só pendentes)
 *
 * Autenticação: middleware `auth` (JWT). O utilizador_id vem do token.
 * O staff só pode gerir as SUAS ausências — não pode aprovar/rejeitar.
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const {
  minhasAusencias,
  criarAusencia,
  cancelarAusencia,
  faltaHoje,
} = require('../controllers/staffController');

router.get('/ausencias', auth, minhasAusencias);
router.post('/ausencias', auth, criarAusencia);
router.delete('/ausencias/:id', auth, cancelarAusencia);
router.post('/falta-hoje', auth, faltaHoje);

module.exports = router;
