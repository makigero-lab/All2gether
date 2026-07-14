/**
 * Rotas de Gestão de Ausências (Folgas e Férias).
 *
 * Prefixo montado em server.js: /api/gestor/ausencias
 *
 * Endpoints:
 *   GET    /                  — lista ausências da empresa (populate utilizador)
 *   POST   /                  — regista nova ausência (folga/férias) — admin, estado 'aprovada'
 *   DELETE /:id               — elimina ausência
 *   PATCH  /:id/estado        — aprovar/rejeitar pedido do staff (v1.24.0)
 *   PATCH  /:id/cancelar      — soft cancel: marca estado='cancelada' (v1.39.0/Prompt 131b)
 *
 * Autenticação:
 *   - A maioria das rotas exige `auth` + `isGestor` (admin/gestor).
 *   - A rota PATCH /:id/cancelar exige apenas `auth` (staff pode cancelar
 *     as SUAS ausências pendentes/aprovadas; o controller valida ownership).
 *     Isto permite que o staff use o mesmo endpoint que o gestor para
 *     cancelar ausências (soft cancel mantém histórico para auditoria).
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
  cancelarAusencia,
} = require('../controllers/ausenciaController');

// v1.28.0: endpoints de gestão de ausências exigem role admin OU manager
// (o staff não pode aprovar/rejeitar nem ver ausências de outros).
router.get('/', auth, isGestor, listarAusencias);
router.post('/', auth, isGestor, registarAusencia);
router.delete('/:id', auth, isGestor, eliminarAusencia);
router.patch('/:id/estado', auth, isGestor, aprovarRejeitarAusencia);

// v1.39.0 (Prompt 131b) — Soft cancel: marca estado='cancelada' (mantém histórico).
// Apenas `auth` (sem isGestor): o staff pode cancelar as SUAS ausências; o
// gestor/admin pode cancelar qualquer ausência da empresa. O controller
// valida ownership consoante o role.
router.patch('/:id/cancelar', auth, cancelarAusencia);

module.exports = router;
