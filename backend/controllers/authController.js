/**
 * Auth Controller — Autocell
 *
 * Autenticação com JWT + bcrypt.
 *
 * Endpoint: POST /api/auth/login
 *   Recebe { email, password }, valida as credenciais e devolve um JWT
 *   com { id, role, empresa_id }.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const Ausencia = require('../models/Ausencia');
const Propriedade = require('../models/Propriedade');
const { JWT_SECRET } = require('../middleware/auth');

// Tempo de expiração do token (pode ser overridden por env).
const TOKEN_EXPIRACAO = process.env.JWT_EXPIRACAO || '7d';

/**
 * POST /api/auth/login
 *
 * Body: { email, password }
 *
 * Resposta 200:
 *   {
 *     "token": "<jwt>",
 *     "utilizador": { "id", "nome", "email", "role", "empresa_id" }
 *   }
 *
 * Respostas de erro:
 *   400 — email/password em falta
 *   401 — credenciais inválidas / utilizador inativo / sem password definida
 *   500 — erro interno
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ erro: 'Email e password são obrigatórios.' });
    }

    // Procura o utilizador por email (único).
    const utilizador = await Utilizador.findOne({
      email: String(email).toLowerCase().trim(),
    });

    // Mensagem genérica para não revelar se o email existe ou não.
    const MSG_INVALIDAS = 'Credenciais inválidas.';

    if (!utilizador) {
      return res.status(401).json({ erro: MSG_INVALIDAS });
    }

    if (!utilizador.ativo) {
      return res
        .status(401)
        .json({ erro: 'Utilizador inativo. Contacta o administrador.' });
    }

    if (!utilizador.password_hash) {
      // Utilizador migrado sem password (ex.: criado antes do auth).
      return res.status(401).json({
        erro: 'Ainda não tem password definida. Contacta o administrador.',
      });
    }

    // Verifica a password contra a hash bcrypt.
    const passwordOk = await bcrypt.compare(password, utilizador.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ erro: MSG_INVALIDAS });
    }

    // Gera o JWT com o payload essencial.
    const token = jwt.sign(
      {
        id: String(utilizador._id),
        role: utilizador.role,
        empresa_id: String(utilizador.empresa_id),
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRACAO }
    );

    return res.status(200).json({
      token,
      utilizador: {
        id: String(utilizador._id),
        nome: utilizador.nome,
        email: utilizador.email,
        role: utilizador.role,
        empresa_id: String(utilizador.empresa_id),
      },
    });
  } catch (err) {
    console.error('❌ login:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/auth/me  (requer JWT)
 * Devolve os dados do utilizador autenticado (a partir do token).
 *
 * Resposta 200: { utilizador: { id, nome, email, role, empresa_id } }
 */
exports.me = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }
    const utilizador = await Utilizador.findById(req.user.id).select(
      '-password_hash'
    );
    if (!utilizador) {
      return res.status(404).json({ erro: 'Utilizador não encontrado.' });
    }
    return res.status(200).json({
      utilizador: {
        id: String(utilizador._id),
        nome: utilizador.nome,
        email: utilizador.email,
        role: utilizador.role,
        empresa_id: String(utilizador.empresa_id),
      },
    });
  } catch (err) {
    console.error('❌ me:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/auth/me/calendario (requer JWT)
 *
 * Devolve o calendário pessoal do utilizador autenticado:
 *   - Tarefas atribuídas a ele (a partir de hoje), com populate da propriedade.
 *   - Ausências dele (a partir de hoje).
 *
 * Resposta 200: { tarefas: [...], ausencias: [...] }
 */
exports.meuCalendario = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const utilizadorId = req.user.id;

    // Data de hoje em meia-noite UTC.
    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    // Tarefas do utilizador a partir de hoje (não canceladas).
    const tarefas = await Tarefa.find({
      utilizador_id: utilizadorId,
      data: { $gte: hoje },
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    // Ausências do utilizador a partir de hoje.
    const ausencias = await Ausencia.find({
      utilizador_id: utilizadorId,
      data_fim: { $gte: hoje },
    })
      .sort({ data_inicio: 1 })
      .lean();

    return res.status(200).json({ tarefas, ausencias });
  } catch (err) {
    console.error('❌ meuCalendario:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/auth/me/tarefas (requer JWT)
 *
 * Devolve as tarefas de HOJE do utilizador autenticado, com populate da
 * propriedade (nome, morada, coordenadas). Usado pelo /staff (mobile).
 *
 * Resposta 200: { tarefas: [...] }
 */
exports.minhasTarefas = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const amanha = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);

    const tarefas = await Tarefa.find({
      utilizador_id: req.user.id,
      data: { $gte: hoje, $lt: amanha },
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome morada coordenadas checklist' })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ tarefas });
  } catch (err) {
    console.error('❌ minhasTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/auth/me/tarefas/:id (requer JWT)
 *
 * Devolve o detalhe de uma tarefa do utilizador autenticado.
 * Valida que a tarefa pertence ao utilizador.
 *
 * Resposta 200: { tarefa: { ... } }
 */
exports.minhaTarefaDetalhe = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }

    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: req.user.id,
    })
      .populate({ path: 'propriedade_id', select: 'nome morada coordenadas checklist' })
      .lean();

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    return res.status(200).json({ tarefa });
  } catch (err) {
    console.error('❌ minhaTarefaDetalhe:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/auth/me/tarefas/:id/concluir (requer JWT)
 *
 * Marca uma tarefa como concluída. Guarda observações e checklist
 * preenchida pelo staff.
 *
 * Body: { observacoes?: string, checklist_concluida?: boolean }
 *
 * Resposta 200: { tarefa: { ... } }
 */
exports.concluirMinhaTarefa = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }

    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: req.user.id,
    });

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    if (tarefa.estado === 'concluida') {
      return res.status(400).json({ erro: 'Tarefa já concluída.' });
    }

    // Atualiza estado e guarda observações.
    tarefa.estado = 'concluida';
    tarefa.concluida_em = new Date();
    if (req.body?.observacoes !== undefined) {
      tarefa.observacoes = String(req.body.observacoes || '');
    }

    await tarefa.save();

    const resp = tarefa.toObject();
    delete resp.password_hash;

    return res.status(200).json({ tarefa: resp });
  } catch (err) {
    console.error('❌ concluirMinhaTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Notificações Push (Web Push API) — v1.27.0                          */
/* ------------------------------------------------------------------ */

/**
 * GET /api/auth/me/push-vapid-public-key
 *
 * Devolve a chave pública VAPID para o frontend pedir a subscrição
 * do browser (PushManager.subscribe({ applicationServerKey })).
 *
 * Resposta 200: { publicKey: string }
 * Resposta 503: Web Push não configurado (chaves VAPID em falta).
 */
exports.pushVapidPublicKey = async (req, res) => {
  try {
    const { isConfigured, getPublicKey } = require('../utils/push');
    if (!isConfigured()) {
      return res.status(503).json({
        erro: 'Notificações push não configuradas no servidor.',
      });
    }
    return res.status(200).json({ publicKey: getPublicKey() });
  } catch (err) {
    console.error('❌ pushVapidPublicKey:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/auth/me/push-subscribe
 *
 * Guarda a subscrição push gerada pelo browser no utilizador logado.
 * O frontend chama isto depois de obter a subscrição via:
 *   const sub = await registration.pushManager.subscribe({...});
 *   fetch('/api/auth/me/push-subscribe', { method: 'POST', body: sub })
 *
 * Body: { subscription: PushSubscription }
 *   - objeto com { endpoint, keys: { p256dh, auth }, expirationTime? }
 *
 * Resposta 200: { mensagem: 'Subscrição guardada com sucesso.' }
 * Resposta 400: subscription em falta ou inválida
 * Resposta 503: Web Push não configurado
 */
exports.pushSubscribe = async (req, res) => {
  try {
    const { isConfigured } = require('../utils/push');
    if (!isConfigured()) {
      return res.status(503).json({
        erro: 'Notificações push não configuradas no servidor.',
      });
    }

    const { subscription } = req.body || {};

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        erro: 'Subscrição inválida: falta o objeto subscription com endpoint.',
      });
    }

    // Guarda a subscrição no utilizador logado.
    const utilizador = await Utilizador.findById(req.user.id);
    if (!utilizador) {
      return res.status(404).json({ erro: 'Utilizador não encontrado.' });
    }

    utilizador.pushSubscription = subscription;
    await utilizador.save();

    return res.status(200).json({
      mensagem: 'Subscrição guardada com sucesso.',
    });
  } catch (err) {
    console.error('❌ pushSubscribe:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/auth/me/push-unsubscribe
 *
 * Remove a subscrição push do utilizador (ex: user fez logout, ou o
 * browser reportou que a subscrição expirou).
 *
 * Resposta 200: { mensagem: 'Subscrição removida.' }
 */
exports.pushUnsubscribe = async (req, res) => {
  try {
    const utilizador = await Utilizador.findById(req.user.id);
    if (!utilizador) {
      return res.status(404).json({ erro: 'Utilizador não encontrado.' });
    }

    utilizador.pushSubscription = null;
    await utilizador.save();

    return res.status(200).json({ mensagem: 'Subscrição removida.' });
  } catch (err) {
    console.error('❌ pushUnsubscribe:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
