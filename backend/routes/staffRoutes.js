/**
 * Rotas do Staff — FisioCell
 *
 * Prefixo montado em server.js: /api/staff
 *
 * Endpoints:
 *   GET    /ausencias            — histórico de ausências do próprio utilizador
 *   POST   /ausencias            — criar pedido de ausência (sempre 'pendente')
 *   DELETE /ausencias/:id        — cancelar pedido pendente (só pendentes)
 *   POST   /falta-hoje           — reportar falta de emergência para o dia atual
 *   PATCH  /tarefas/:id/concluir — concluir tarefa (v1.34.0)
 *   POST   /tarefas/:id/avaria   — reportar avaria (v1.38.0)
 *   POST   /tarefas/:id/atraso   — reportar atraso (v1.55.0 — Prompt 77)
 *
 * Autenticação: middleware `auth` (JWT). O utilizador_id vem do token.
 * O staff só pode gerir as SUAS ausências e tarefas — não pode aprovar/rejeitar.
 *
 * Nota (Prompt 77): a rota de atraso usa apenas `auth` (sem requireRole),
 * porque o staff tem de conseguir reportar atrasos nas suas próprias tarefas.
 * A validação de pertença (tarefa.utilizador_id === req.user.id) é feita no
 * controller staffController.reportarAtraso.
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const {
  minhasAusencias,
  criarAusencia,
  cancelarAusencia,
  cancelarAusenciaSoft,
  faltaHoje,
  concluirTarefa,
  reportarAvaria,
  reportarAtraso,
  toggleChecklistItem,
} = require('../controllers/staffController');

router.get('/ausencias', auth, minhasAusencias);
router.post('/ausencias', auth, criarAusencia);
router.delete('/ausencias/:id', auth, cancelarAusencia);
// Prompt 132 — Soft cancel (mantém histórico)
router.patch('/ausencias/:id/cancelar', auth, cancelarAusenciaSoft);
router.post('/falta-hoje', auth, faltaHoje);
router.patch('/tarefas/:id/concluir', auth, concluirTarefa);
router.post('/tarefas/:id/avaria', auth, reportarAvaria);
router.post('/tarefas/:id/atraso', auth, reportarAtraso);
// Prompt 133 — Toggle item da checklist dinâmica
router.patch('/tarefas/:id/checklist/:seccaoIndex/item/:itemIndex', auth, toggleChecklistItem);

module.exports = router;
