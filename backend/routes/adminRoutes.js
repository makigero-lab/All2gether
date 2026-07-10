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
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ erro: 'SMOOBU_API_KEY não configurada nas variáveis de ambiente.' });
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

module.exports = router;
