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
  atualizarReserva,
  eliminarReserva,
} = require('../controllers/parceiroController');
const { getLimpezaDoParceiro } = require('../controllers/provaController');
// FIX (excel parceiro) — Controller de Excel partilhado (funções dedicadas).
const { exportarExcelParceiro } = require('../controllers/excelController');

const router = express.Router();

router.get('/propriedades', auth, isParceiro, listarPropriedades);
router.post('/propriedades', auth, isParceiro, criarPropriedade);
router.get('/tarefas', auth, isParceiro, listarTarefas);
router.post('/tarefas', auth, isParceiro, criarTarefa);
// HF23 — Reservas manuais
router.get('/reservas', auth, isParceiro, listarReservas);
router.post('/reservas', auth, isParceiro, criarReserva);
router.get('/reservas/:id/limpeza', auth, isParceiro, getLimpezaDoParceiro);
router.put('/reservas/:id', auth, isParceiro, atualizarReserva);
router.delete('/reservas/:id', auth, isParceiro, eliminarReserva);

// FIX (excel parceiro) — Rotas de importação/exportação de Excel (parceiro).
router.get('/reservas/exportar-excel', auth, isParceiro, exportarExcelParceiro);

// Calendários externos (Airbnb, Booking...) das casas do proprietário e períodos por confirmar.
const cal = require('../controllers/calendarioController').parceiro;
router.get('/calendarios', auth, isParceiro, cal.listar);
router.post('/calendarios/testar', auth, isParceiro, cal.testar);
router.post('/calendarios', auth, isParceiro, cal.criar);
router.put('/calendarios/:id', auth, isParceiro, cal.substituir);
router.post('/calendarios/:id/atualizar', auth, isParceiro, cal.atualizar);
router.post('/calendarios/:id/reativar', auth, isParceiro, cal.reativar);
router.get('/calendarios/:id/impacto-remocao', auth, isParceiro, cal.impacto);
router.delete('/calendarios/:id', auth, isParceiro, cal.remover);
router.get('/calendarios/:id/leituras', auth, isParceiro, cal.leituras);
router.get('/reservas-externas', auth, isParceiro, cal.listarExternas);
router.post('/reservas-externas/:id/confirmar', auth, isParceiro, cal.confirmar);
router.post('/reservas-externas/:id/bloqueio', auth, isParceiro, cal.bloqueio);
router.post('/reservas-externas/:id/reabrir', auth, isParceiro, cal.reabrir);

module.exports = router;
