/**
 * Rotas do Staff — All2gether
 *
 * Prefixo montado em server.js: /api/staff
 *
 * Endpoints:
 *   GET    /ausencias            — histórico de ausências do próprio utilizador
 *   POST   /ausencias            — criar pedido de ausência (sempre 'pendente')
 *   DELETE /ausencias/:id        — cancelar pedido pendente (só pendentes)
 *   POST   /falta-hoje           — reportar falta de emergência para o dia atual
 *   PATCH  /tarefas/:id/iniciar — «Comecei» (em_curso)
 *   POST   /tarefas/:id/nao-consegui — «Não consegui começar»
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
const { requireRole } = require('../middleware/requireRole');
// Ausências e faltas: só quem faz limpezas (staff) ou gere (gestor/admin); parceiros e fornecedores não.
const equipaOuGestor = requireRole('staff', 'gestor', 'admin');
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
const { iniciarTarefa, naoConseguiComecar } = require('../controllers/staffInicioController');
const { listarVagasLivres, aceitarVagaLivre } = require('../controllers/staffVagasController');

router.get('/ausencias', auth, equipaOuGestor, minhasAusencias);
router.post('/ausencias', auth, equipaOuGestor, criarAusencia);
router.delete('/ausencias/:id', auth, equipaOuGestor, cancelarAusencia);
// Prompt 132 — Soft cancel (mantém histórico)
router.patch('/ausencias/:id/cancelar', auth, equipaOuGestor, cancelarAusenciaSoft);
// Limpezas livres: vagas que ninguém tinha disponibilidade para fazer, oferecidas à equipa.
router.get('/vagas-livres', auth, requireRole('staff'), listarVagasLivres);
router.post('/vagas-livres/:id/aceitar', auth, requireRole('staff'), aceitarVagaLivre);
router.post('/falta-hoje', auth, equipaOuGestor, faltaHoje);
router.patch('/tarefas/:id/iniciar', auth, iniciarTarefa);
router.post('/tarefas/:id/nao-consegui', auth, naoConseguiComecar);
router.patch('/tarefas/:id/concluir', auth, concluirTarefa);
router.post('/tarefas/:id/avaria', auth, reportarAvaria);
router.post('/tarefas/:id/atraso', auth, reportarAtraso);
// Prompt 133 — Toggle item da checklist dinâmica
router.patch('/tarefas/:id/checklist/:seccaoIndex/item/:itemIndex', auth, toggleChecklistItem);

module.exports = router;
