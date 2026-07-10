/**
 * Rotas do Super Admin — Autocell
 *
 * Prefixo montado em server.js: /api/admin
 *
 * Endpoints exclusivos do Super Admin (role 'admin'):
 *   GET    /empresas                                          — lista todas as empresas + gestor principal
 *   POST   /empresas/:id/impersonar                           — gera token JWT do gestor (impersonation)
 *   GET    /empresas/:empresaId/utilizadores                  — lista utilizadores de uma empresa (Prompt 101)
 *   POST   /empresas/:empresaId/utilizadores                  — cria gestor/staff numa empresa (Prompt 101)
 *   PATCH  /empresas/:empresaId/utilizadores/:utilizadorId/estado — alterna ativo/inativo (Prompt 101)
 *   DELETE /hard-reset                                        — apaga Propriedades + Tarefas (Prompt 108)
 *   POST   /sincronizar-propriedades                          — importa propriedades do Smoobu (Prompt 109)
 *   POST   /sincronizar-reservas                              — sincroniza reservas/tarefas do Smoobu (Prompt 109)
 *   POST   /registrar-webhooks                                — regista webhooks no Smoobu (Prompt 109)
 *
 * Segurança: todas as rotas usam auth + isAdmin (ESTRITO — só role 'admin').
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/requireRole');
const {
  listarEmpresas,
  impersonarGestor,
  listarUtilizadoresEmpresa,
  criarUtilizadorEmpresa,
  alternarEstadoUtilizadorEmpresa,
} = require('../controllers/superAdminController');
const {
  sincronizarPropriedades,
  importarPropriedades,
  sincronizarReservas,
} = require('../controllers/smoobuController');

// Todas as rotas exigem auth + isAdmin (só Super Admin).
router.use(auth, isAdmin);

// Listar todas as empresas (cross-tenant) com gestor principal.
router.get('/empresas', listarEmpresas);

// Impersonar gestor de uma empresa (gera token JWT do gestor).
router.post('/empresas/:id/impersonar', impersonarGestor);

// Prompt 101 — Gestão de utilizadores de empresas terceiras.
router.get('/empresas/:empresaId/utilizadores', listarUtilizadoresEmpresa);
router.post('/empresas/:empresaId/utilizadores', criarUtilizadorEmpresa);
router.patch(
  '/empresas/:empresaId/utilizadores/:utilizadorId/estado',
  alternarEstadoUtilizadorEmpresa
);

// Prompt 108 — Hard Reset: apaga TODAS as Propriedades e Tarefas da empresa
// do utilizador autenticado (admin). Se o admin for cross-tenant, apaga tudo.
router.delete('/hard-reset', async (req, res) => {
  try {
    const Propriedade = require('../models/Propriedade');
    const Tarefa = require('../models/Tarefa');
    const mongoose = require('mongoose');

    const empresaId = req.user && req.user.empresa_id;
    const filtro = empresaId && mongoose.isValidObjectId(empresaId)
      ? { empresa_id: empresaId }
      : {};

    const propsResult = await Propriedade.deleteMany(filtro);
    const tarefasResult = await Tarefa.deleteMany(filtro);

    console.log(
      `🗑️  Hard Reset por admin ${req.user?.email || '?'} — ` +
        `${propsResult.deletedCount} propriedade(s) e ${tarefasResult.deletedCount} tarefa(s) apagadas` +
        (empresaId ? ` (empresa ${empresaId}).` : ' (TODAS as empresas).')
    );

    return res.status(200).json({
      message: 'Base de dados limpa com sucesso. Propriedades e Tarefas eliminadas.',
      detalhe: {
        propriedades_apagadas: propsResult.deletedCount,
        tarefas_apagadas: tarefasResult.deletedCount,
        ambito: empresaId ? `empresa ${empresaId}` : 'todas as empresas',
      },
    });
  } catch (err) {
    console.error('❌ hard-reset:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.', detalhe: err.message });
  }
});

// Prompt 109 — Cockpit de Sistema: operações de infraestrutura.

// Sincronizar Propriedades — importa apartamentos do Smoobu em massa.
// Reutiliza o importarPropriedades do smoobuController (scoped por empresa_id
// do admin). Se o admin não tiver empresa_id, devolve erro.
router.post('/sincronizar-propriedades', async (req, res) => {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    return res.status(400).json({ erro: 'Admin sem empresa_id associada. Use a página de Empresas para gerir uma empresa específica.' });
  }
  // Simula o req.user com a empresa_id do admin para o importarPropriedades.
  req.user.empresa_id = empresaId;
  return importarPropriedades(req, res);
});

// Sincronizar Reservas — vai buscar reservas futuras do Smoobu via REST API.
router.post('/sincronizar-reservas', async (req, res) => {
  return sincronizarReservas(req, res);
});

// Registrar Webhooks no Smoobu — configura o webhook URL no Smoobu via API.
router.post('/registrar-webhooks', async (req, res) => {
  const { _obterApiKeySmoobu } = require('../controllers/smoobuController');
  const empresaId = req.user && req.user.empresa_id;
  const apiKey = await _obterApiKeySmoobu(empresaId);
  if (!apiKey) {
    return res.status(400).json({ erro: 'API Key do Smoobu não configurada. Define-a nas Configurações da empresa.' });
  }

  // O URL do webhook deve ser o endpoint público do backend.
  const WEBHOOK_URL = process.env.SMOOBU_WEBHOOK_URL || '';
  if (!WEBHOOK_URL) {
    return res.status(400).json({
      erro: 'SMOOBU_WEBHOOK_URL não configurada. Define o URL público do webhook (ex: https://autocell-backend.onrender.com/webhooks/smoobu).',
    });
  }

  try {
    // O Smoobu usa o endpoint /api/webhooks para registar webhooks.
    const resp = await fetch('https://login.smoobu.com/api/webhooks', {
      method: 'POST',
      headers: {
        'Api-Key': apiKey.trim(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        isActive: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error(`❌ registrar-webhooks: Smoobu devolveu ${resp.status}`, body);
      // Se já existe (409 ou mensagem de duplicado), não é erro crítico.
      const msg = body?.message || body?.error || JSON.stringify(body);
      if (resp.status === 409 || /already|exist|duplicate/i.test(msg)) {
        return res.status(200).json({
          message: 'Webhook já estava registado no Smoobu.',
          url: WEBHOOK_URL,
          ja_existia: true,
        });
      }
      return res.status(502).json({
        erro: `Smoobu devolveu erro ${resp.status}.`,
        detalhe: msg,
      });
    }

    console.log(`✅ Webhook registado no Smoobu: ${WEBHOOK_URL}`);
    return res.status(200).json({
      message: 'Webhook registado com sucesso no Smoobu.',
      url: WEBHOOK_URL,
      resposta: body,
    });
  } catch (err) {
    console.error('❌ registrar-webhooks:', err.message);
    return res.status(502).json({ erro: 'Erro ao ligar ao Smoobu.', detalhe: err.message });
  }
});

// Prompt 109 (update) — Forçar Cron Jobs manualmente.

// Forçar Daily Briefing.
router.post('/forcar-daily-briefing', async (req, res) => {
  try {
    const { executarBriefing } = require('../jobs/dailyBriefing');
    await executarBriefing();
    return res.status(200).json({ message: 'Daily Briefing executado com sucesso.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Daily Briefing.', detalhe: err.message });
  }
});

// Forçar Agenda de Amanhã.
router.post('/forcar-agenda-amanha', async (req, res) => {
  try {
    const { executarAgendaAmanha } = require('../jobs/agendaAmanha');
    await executarAgendaAmanha();
    return res.status(200).json({ message: 'Agenda de Amanhã executada com sucesso.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Agenda de Amanhã.', detalhe: err.message });
  }
});

// Forçar Cão de Guarda.
router.post('/forcar-cao-guarda', async (req, res) => {
  try {
    const { executarCaoGuarda } = require('../jobs/caoGuarda');
    const resultado = await executarCaoGuarda();
    return res.status(200).json({
      message: 'Cão de Guarda executado com sucesso.',
      failSafe: resultado.failSafe,
      alertas: resultado.alertas,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Cão de Guarda.', detalhe: err.message });
  }
});

// Enviar Push de Teste para o utilizador atual.
router.post('/push-teste', async (req, res) => {
  try {
    const { notificarUtilizador } = require('../utils/notificar');
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(400).json({ erro: 'Utilizador sem ID no token.' });
    }
    notificarUtilizador(
      String(userId),
      '🧪 Push de Teste',
      'Se estás a ver esta notificação, o sistema de push notifications está a funcionar!',
      '/admin/sistema'
    );
    return res.status(200).json({ message: 'Push de teste enviado. Verifica o teu dispositivo (se tiveres subscrição ativa).' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao enviar push.', detalhe: err.message });
  }
});

// Prompt 109 — Configuração da Empresa (SaaS).
// GET: devolve a configuração atual da empresa do admin.
router.get('/config-empresa', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'Admin sem empresa_id associada.' });
    }
    const empresa = await Empresa.findById(empresaId).select('nome smoobu_api_key').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    // Mascara a API key (mostra só os últimos 4 caracteres).
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

// PUT: atualiza a configuração da empresa do admin.
router.put('/config-empresa', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'Admin sem empresa_id associada.' });
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

// Prompt 111 — CRUD de Empresas (Super Admin).

// Criar Nova Empresa.
router.post('/empresas', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { nome, smoobu_api_key } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Nome da empresa é obrigatório.' });
    }
    const nova = await Empresa.create({
      nome: String(nome).trim(),
      smoobu_api_key: smoobu_api_key ? String(smoobu_api_key).trim() : '',
    });
    return res.status(201).json({ empresa: nova });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar empresa.', detalhe: err.message });
  }
});

// Eliminar Empresa (soft — marca plano_ativo = false).
router.delete('/empresas/:id', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const empresa = await Empresa.findByIdAndDelete(id);
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    return res.status(200).json({ message: 'Empresa eliminada com sucesso.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao eliminar empresa.', detalhe: err.message });
  }
});

module.exports = router;
