/**
 * Rotas do Portal de Parceiros (B2B) — All2gether (Fase 3 / HF17)
 *
 * Prefixo montado em server.js: /api/parceiro
 *
 * Endpoints:
 *   GET  /propriedades  — lista as propriedades do parceiro
 *   POST /propriedades  — cria uma propriedade manual
 *   GET  /tarefas       — lista as tarefas do parceiro
 *   POST /tarefas       — cria uma limpeza manual/espontânea
 *
 * Segurança: todas as rotas exigem auth + isParceiro.
 */

const express = require('express');
const { auth } = require('../middleware/auth');
const { isParceiro } = require('../middleware/requireRole');
const {
  criarPropriedade,
  listarPropriedades,
  criarTarefa,
  listarTarefas,
  criarReserva,
  listarReservas,
} = require('../controllers/parceiroController');

const router = express.Router();

router.get('/propriedades', auth, isParceiro, listarPropriedades);
router.post('/propriedades', auth, isParceiro, criarPropriedade);
router.get('/tarefas', auth, isParceiro, listarTarefas);
router.post('/tarefas', auth, isParceiro, criarTarefa);
// HF23 — Reservas manuais
router.get('/reservas', auth, isParceiro, listarReservas);
router.post('/reservas', auth, isParceiro, criarReserva);

module.exports = router;
