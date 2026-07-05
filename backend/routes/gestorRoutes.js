/**
 * Rotas do Painel de Administração.
 *
 * Prefixo montado em server.js: /api/admin
 *
 * Endpoints:
 *   GET    /api/admin/propriedades      — lista propriedades da empresa (PROTEGIDO)
 *   POST   /api/admin/propriedades      — cria propriedade para a empresa (PROTEGIDO)
 *   GET    /api/admin/equipa            — lista utilizadores da empresa (PROTEGIDO)
 *   POST   /api/admin/equipa            — cria utilizador (membro de equipa) (PROTEGIDO)
 *   PUT    /api/admin/equipa/:id        — atualiza utilizador (nome/email/role/password) (PROTEGIDO)
 *   PATCH  /api/admin/equipa/:id/estado — alterna ativo/desativo (PROTEGIDO)
 *   DELETE /api/admin/equipa/:id        — elimina utilizador (PROTEGIDO)
 *   GET    /api/admin/setup             — bootstrap do "Cliente Zero" (PÚBLICO)
 *
 * Autenticação:
 *   - As rotas de propriedades e equipa são protegidas pelo middleware `auth`
 *     (JWT, com fallback legacy x-empresa-id durante a transição).
 *   - A rota /setup é PÚBLICA de propósito: é o endpoint de bootstrap que
 *     cria o primeiro utilizador (ainda não há token para a chamar). Em
 *     produção, deve ser desativada ou protegida por outro mecanismo após
 *     o setup inicial.
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isGestor } = require('../middleware/requireRole');
const {
  getDashboard,
  getPropriedades,
  criarPropriedade,
  atualizarPropriedade,
  alternarEstadoPropriedade,
  getTarefas,
  getDadosCalendario,
  getEquipa,
  criarMembroEquipa,
  atualizarMembroEquipa,
  alternarEstadoMembro,
  eliminarMembroEquipa,
  reportarFaltaSubita,
  registarBaixaProlongada,
  exportarTarefasCSV,
  getAuditoria,
  getWebhooks,
  reprocessarWebhook,
  setupClienteZero,
} = require('../controllers/gestorController');
const { reportarAtrasoTarefa, criarTarefa, atribuirTarefa, atualizarEstadoTarefa } = require('../controllers/tarefaController');
const { sincronizarReservas, getPropriedadesSmoobu, sincronizarPropriedades } = require('../controllers/smoobuController');

// Bootstrap do ambiente de testes — Cliente Zero. PÚBLICO (sem auth).
router.get('/setup', setupClienteZero);

// Dashboard com dados reais.
router.get('/dashboard', auth, isGestor, getDashboard);

// Gestão de propriedades da empresa. PROTEGIDO por JWT.
router.get('/propriedades', auth, isGestor, getPropriedades);
router.post('/propriedades', auth, isGestor, criarPropriedade);
router.put('/propriedades/:id', auth, isGestor, atualizarPropriedade);
router.patch('/propriedades/:id/estado', auth, isGestor, alternarEstadoPropriedade);

// Calendário Geral de Operações — lista tarefas com filtro de datas.
router.get('/tarefas', auth, isGestor, getTarefas);

// Calendário Visual Avançado — endpoint unificado com filtros + populate.
router.get('/calendario/dados', auth, isGestor, getDadosCalendario);

// Exportação CSV de tarefas.
router.get('/tarefas/export', auth, isGestor, exportarTarefasCSV);

// Reportar atraso numa tarefa.
router.post('/tarefas/:id/atraso', auth, isGestor, reportarAtrasoTarefa);

// Gestão manual de tarefas.
router.post('/tarefas', auth, isGestor, criarTarefa);
router.patch('/tarefas/:id/atribuir', auth, isGestor, atribuirTarefa);
router.patch('/tarefas/:id/estado', auth, isGestor, atualizarEstadoTarefa);

// Gestão de equipa (utilizadores) da empresa. PROTEGIDO por JWT.
router.get('/equipa', auth, isGestor, getEquipa);
router.post('/equipa', auth, isGestor, criarMembroEquipa);
router.put('/equipa/:id', auth, isGestor, atualizarMembroEquipa);
router.patch('/equipa/:id/estado', auth, isGestor, alternarEstadoMembro);
router.delete('/equipa/:id', auth, isGestor, eliminarMembroEquipa);

// Falta súbita — reatribuição de emergência.
router.post('/equipa/:id/falta-subita', auth, isGestor, reportarFaltaSubita);

// Baixa prolongada / férias — redistribuição de tarefas futuras.
router.post('/equipa/:id/baixa', auth, isGestor, registarBaixaProlongada);

// Auditoria.
router.get('/auditoria', auth, isGestor, getAuditoria);

// Webhooks — logs do Smoobu (lista + reproccessamento manual).
router.get('/webhooks', auth, isGestor, getWebhooks);
router.post('/webhooks/:id/reprocessar', auth, isGestor, reprocessarWebhook);

// Smoobu — sincronização em massa de reservas (REST API pull).
router.post('/smoobu/sincronizar', auth, isGestor, sincronizarReservas);

// Smoobu — listar propriedades (apartamentos) para mapeamento no fluxo de criação.
router.get('/smoobu/propriedades', auth, isGestor, getPropriedadesSmoobu);

// Smoobu — sincronizar propriedades (upsert em massa do /api/apartments).
router.post('/smoobu/sincronizar-propriedades', auth, isGestor, sincronizarPropriedades);

module.exports = router;
