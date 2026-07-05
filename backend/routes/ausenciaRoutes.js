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
const { isGestor } = require('../middleware/requireRole');
const {
  listarAusencias,
  registarAusencia,
  eliminarAusencia,
  aprovarRejeitarAusencia,
} = require('../controllers/ausenciaController');

// v1.28.0: endpoints de gestão de ausências exigem role admin OU manager
// (o staff não pode aprovar/rejeitar nem ver ausências de outros).
router.get('/', auth, isGestor, listarAusencias);
router.post('/', auth, isGestor, registarAusencia);
router.delete('/:id', auth, isGestor, eliminarAusencia);
router.patch('/:id/estado', auth, isGestor, aprovarRejeitarAusencia);

module.exports = router;
