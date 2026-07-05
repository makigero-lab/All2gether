/**
 * Rotas de Gestão de Ausências (Folgas e Férias).
 *
 * Prefixo montado em server.js: /api/admin/ausencias
 *
 * Endpoints:
 *   GET    /                  — lista ausências da empresa (populate utilizador)
 *   POST   /                  — regista nova ausência (folga/férias) — admin, estado 'aprovada'
 *   DELETE /:id               — elimina ausência
 *   PATCH  /:id/estado        — aprovar/rejeitar pedido do staff (v1.24.0)
 *
 * Autenticação: middleware `auth` (JWT).
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { requireManager } = require('../middleware/requireRole');
const {
  listarAusencias,
  registarAusencia,
  eliminarAusencia,
  aprovarRejeitarAusencia,
} = require('../controllers/ausenciaController');

// v1.28.0: endpoints de gestão de ausências exigem role admin OU manager
// (o staff não pode aprovar/rejeitar nem ver ausências de outros).
router.get('/', auth, requireManager, listarAusencias);
router.post('/', auth, requireManager, registarAusencia);
router.delete('/:id', auth, requireManager, eliminarAusencia);
router.patch('/:id/estado', auth, requireManager, aprovarRejeitarAusencia);

module.exports = router;
