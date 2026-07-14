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
const { reportarAtrasoTarefa, criarTarefa, atribuirTarefa, reatribuirTarefa, atualizarEstadoTarefa, apagarTarefasFuturas, listarIndisponiveisData, autoAtribuirTarefas } = require('../controllers/tarefaController');
const { sincronizarReservas, getPropriedadesSmoobu, sincronizarPropriedades, importarPropriedades } = require('../controllers/smoobuController');
// Prompt 133 — CRUD de Modelos de Checklist
const { listarModelos, criarModelo, obterModelo, atualizarModelo, apagarModelo } = require('../controllers/checklistController');

// Bootstrap do ambiente de testes — Cliente Zero. PÚBLICO (sem auth).
router.get('/setup', setupClienteZero);

// Dashboard com dados reais.
router.get('/dashboard', auth, isGestor, getDashboard);

// Gestão de propriedades da empresa. PROTEGIDO por JWT.
router.get('/propriedades', auth, isGestor, getPropriedades);
router.post('/propriedades', auth, isGestor, criarPropriedade);
router.put('/propriedades/:id', auth, isGestor, atualizarPropriedade);
router.patch('/propriedades/:id/estado', auth, isGestor, alternarEstadoPropriedade);

// Prompt 113 — Aplica um checklist padrão a TODAS as propriedades ativas da
// empresa do gestor. Endpoint temporário/onboarding para poupar o gestor de
// definir item a item. Substitui o checklist existente (não faz merge).
router.post('/propriedades/default-checklist', auth, isGestor, async (req, res) => {
  try {
    const Propriedade = require('../models/Propriedade');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    const CHECKLIST_PADRAO = [
      'Esvaziar lixo',
      'Trocar roupa da cama',
      'Trocar Toalhas',
      'Limpar chão',
      'Limpar vidros',
      'Limpar pó',
    ];

    const resultado = await Propriedade.updateMany(
      { empresa_id: empresaId },
      { $set: { checklist: CHECKLIST_PADRAO } }
    );

    return res.status(200).json({
      sucesso: true,
      message: `Checklist padrão aplicada a ${resultado.modifiedCount} propriedade(s).`,
      checklist: CHECKLIST_PADRAO,
      modificadas: resultado.modifiedCount,
      correspondidas: resultado.matchedCount,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

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
router.patch('/tarefas/:id/reatribuir', auth, isGestor, reatribuirTarefa);
router.patch('/tarefas/:id/estado', auth, isGestor, atualizarEstadoTarefa);

// Apagar tarefas futuras não concluídas (reset do calendário).
router.delete('/tarefas/futuras', auth, isGestor, apagarTarefasFuturas);

// v1.63.0 (Prompt 86) — Auto-atribuição em lote (corre o load balancer para
// todas as tarefas órfãs a partir de hoje).
router.post('/tarefas/auto-atribuir', auth, isGestor, autoAtribuirTarefas);

// v1.59.0 (Prompt 81) — Staff indisponíveis (férias/doença) numa data.
router.get('/tarefas/indisponiveis', auth, isGestor, listarIndisponiveisData);

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

// Prompt 133 — CRUD de Modelos de Checklist
router.get('/checklists', auth, isGestor, listarModelos);
router.post('/checklists', auth, isGestor, criarModelo);
router.get('/checklists/:id', auth, isGestor, obterModelo);
router.put('/checklists/:id', auth, isGestor, atualizarModelo);
router.delete('/checklists/:id', auth, isGestor, apagarModelo);

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

// Smoobu — importar propriedades (scoped por empresa_id, morada='A definir').
router.post('/smoobu/propriedades', auth, isGestor, importarPropriedades);

// Smoobu — DEBUG temporário: devolve o payload cru do /api/apartments.
router.get('/smoobu-debug', auth, isGestor, async (req, res) => {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ erro: 'SMOOBU_API_KEY não configurada.' });
  }
  try {
    const resp = await fetch('https://login.smoobu.com/api/apartments', {
      method: 'GET',
      headers: { 'Api-Key': apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await resp.json();
    return res.status(resp.status).json(body);
  } catch (err) {
    return res.status(502).json({ erro: 'Erro ao ligar ao Smoobu.', detalhe: err.message });
  }
});

// Smoobu — DEBUG temporário: devolve o payload cru do /api/reservations (5 reservas).
router.get('/smoobu-debug-reservas', auth, isGestor, async (req, res) => {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ erro: 'SMOOBU_API_KEY não configurada.' });
  }
  try {
    const resp = await fetch('https://login.smoobu.com/api/reservations?pageSize=5', {
      method: 'GET',
      headers: { 'Api-Key': apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await resp.json();
    return res.status(resp.status).json(body);
  } catch (err) {
    return res.status(502).json({ erro: 'Erro ao ligar ao Smoobu.', detalhe: err.message });
  }
});

// Prompt 111 — Configurações do Gestor (tenant local).

// GET /api/gestor/configuracoes — devolve a configuração da empresa do gestor.
router.get('/configuracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const empresa = await Empresa.findById(empresaId).select('nome smoobu_api_key').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const key = empresa.smoobu_api_key || '';
    const keyMascarada = key.length > 4 ? '•'.repeat(key.length - 4) + key.slice(-4) : key;
    return res.status(200).json({
      nome: empresa.nome,
      smoobu_api_key_mascarada: keyMascarada,
      tem_api_key: !!key,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// PUT /api/gestor/configuracoes — atualiza a configuração da empresa.
router.put('/configuracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const { nome, smoobu_api_key } = req.body || {};
    const update = {};
    if (nome !== undefined) update.nome = String(nome).trim();
    if (smoobu_api_key !== undefined) update.smoobu_api_key = String(smoobu_api_key).trim();

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
    }

    const empresa = await Empresa.findByIdAndUpdate(empresaId, { $set: update }, { new: true }).select('nome smoobu_api_key').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const key = empresa.smoobu_api_key || '';
    const keyMascarada = key.length > 4 ? '•'.repeat(key.length - 4) + key.slice(-4) : key;
    return res.status(200).json({
      message: 'Configuração guardada com sucesso.',
      nome: empresa.nome,
      smoobu_api_key_mascarada: keyMascarada,
      tem_api_key: !!key,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// POST /api/gestor/configuracoes/forcar-daily-briefing — dispara para a empresa do gestor.
router.post('/configuracoes/forcar-daily-briefing', auth, isGestor, async (req, res) => {
  try {
    const { executarBriefing } = require('../jobs/dailyBriefing');
    await executarBriefing();
    return res.status(200).json({ message: 'Daily Briefing executado.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar.', detalhe: err.message });
  }
});

// POST /api/gestor/configuracoes/forcar-agenda-amanha — dispara para a empresa do gestor.
router.post('/configuracoes/forcar-agenda-amanha', auth, isGestor, async (req, res) => {
  try {
    const { executarAgendaAmanha } = require('../jobs/agendaAmanha');
    await executarAgendaAmanha();
    return res.status(200).json({ message: 'Agenda de Amanhã executada.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar.', detalhe: err.message });
  }
});

module.exports = router;
