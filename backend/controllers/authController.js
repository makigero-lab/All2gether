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

    // Prompt 116 — Bloqueia o login se a empresa estiver inativa (ativa: false).
    // O Super Admin (role 'admin') é exceção — pode sempre entrar para
    // reativar a empresa. O admin não tem empresa_id de operações.
    if (utilizador.role !== 'admin' && utilizador.empresa_id) {
      const Empresa = require('../models/Empresa');
      const empresa = await Empresa.findById(utilizador.empresa_id).select('ativa').lean();
      if (empresa && empresa.ativa === false) {
        return res.status(403).json({
          erro: 'A tua empresa está desativada. Contacta o suporte.',
        });
      }
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

    // Prompt 131 — Inclui tarefas dos últimos 30 dias + futuras, para o staff
    // poder navegar para dias anteriores e rever tarefas concluídas.
    const limitePassado = new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000);

    const tarefas = await Tarefa.find({
      utilizador_id: req.user.id,
      data: { $gte: limitePassado },
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome morada coordenadas checklist capacidade_hospedes observacoes' })
      .sort({ data: 1 })
      .lean();

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos para tarefas
    // antigas (mesma lógica do getDadosCalendario).
    const { calcularTempoViagem } = require('../utils/scheduler');
    const tarefasComViagem = tarefas.map((t) => {
      if (t.tempo_viagem_minutos && Number(t.tempo_viagem_minutos) > 0) {
        return t;
      }
      if (!t.utilizador_id || !t.propriedade_id) {
        return { ...t, tempo_viagem_minutos: 0 };
      }
      const diaTarefa = new Date(t.data);
      const diaStr = diaTarefa.toISOString().slice(0, 10);
      const tarefaAnterior = tarefas.find((outra) => {
        if (String(outra._id) === String(t._id)) return false;
        if (!outra.utilizador_id || !outra.propriedade_id) return false;
        if (String(outra.utilizador_id) !== String(t.utilizador_id)) return false;
        const diaOutra = new Date(outra.data).toISOString().slice(0, 10);
        return diaOutra === diaStr && new Date(outra.data).getTime() < diaTarefa.getTime();
      });
      if (tarefaAnterior && tarefaAnterior.propriedade_id?.coordenadas && t.propriedade_id?.coordenadas) {
        const viagem = calcularTempoViagem(
          tarefaAnterior.propriedade_id.coordenadas,
          t.propriedade_id.coordenadas
        );
        return { ...t, tempo_viagem_minutos: viagem };
      }
      return { ...t, tempo_viagem_minutos: 0 };
    });

    return res.status(200).json({ tarefas: tarefasComViagem });
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
      // Prompt 114 — Inclui capacidade_hospedes para destaque no detalhe.
      // Prompt 133 — Inclui modelo_checklist_id e observacoes.
      .populate({ path: 'propriedade_id', select: 'nome morada coordenadas checklist capacidade_hospedes observacoes modelo_checklist_id' })
      .lean();

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    // Prompt 135 — Se a tarefa não tem checklist_dinamica mas a propriedade
    // tem modelo_checklist_id, injeta o snapshot on-the-fly. Isto garante que
    // tarefas criadas antes de o modelo ser associado também mostram a
    // checklist dinâmica. O snapshot é guardado na tarefa para persistência.
    if (
      (!tarefa.checklist_dinamica || tarefa.checklist_dinamica.length === 0) &&
      tarefa.propriedade_id?.modelo_checklist_id
    ) {
      try {
        const ModeloChecklist = require('../models/ModeloChecklist');
        const modelo = await ModeloChecklist.findById(tarefa.propriedade_id.modelo_checklist_id).lean();
        if (modelo && Array.isArray(modelo.seccoes) && modelo.seccoes.length > 0) {
          tarefa.checklist_dinamica = modelo.seccoes.map((sec) => ({
            nome: sec.nome,
            items: (sec.items || []).map((item) => ({
              texto: item,
              concluido: false,
            })),
          }));
          // Persiste o snapshot na tarefa (para futuras visualizações não
          // precisarem de voltar a procurar o modelo).
          await Tarefa.updateOne(
            { _id: tarefa._id },
            { $set: { checklist_dinamica: tarefa.checklist_dinamica } }
          );
          console.log(`[minhaTarefaDetalhe] Checklist dinâmica injetada na tarefa ${tarefa._id} a partir do modelo ${modelo._id}.`);
        }
      } catch (chkErr) {
        console.error('⚠️  minhaTarefaDetalhe: erro ao injetar checklist dinâmica:', chkErr.message);
      }
    }

    // Prompt 137 — Debug log para confirmar que detalhes_reserva é devolvido.
    console.log('📋 minhaTarefaDetalhe — tarefa', tarefa._id, 'detalhes_reserva:', JSON.stringify(tarefa.detalhes_reserva));

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos se a tarefa não
    // tem o campo preenchido. Procura a tarefa anterior do mesmo staff no
    // mesmo dia e calcula a viagem Haversine.
    if ((!tarefa.tempo_viagem_minutos || Number(tarefa.tempo_viagem_minutos) === 0) && tarefa.propriedade_id?.coordenadas) {
      try {
        const { calcularTempoViagem, obterRangeDia } = require('../utils/scheduler');
        const range = obterRangeDia(new Date(tarefa.data));
        const tarefaAnterior = await Tarefa.findOne({
          utilizador_id: tarefa.utilizador_id,
          data: { $gte: range.start, $lt: tarefa.data },
          estado: { $nin: ['cancelada'] },
        })
          .populate({ path: 'propriedade_id', select: 'coordenadas' })
          .sort({ data: -1 })
          .lean();
        if (tarefaAnterior && tarefaAnterior.propriedade_id?.coordenadas) {
          tarefa.tempo_viagem_minutos = calcularTempoViagem(
            tarefaAnterior.propriedade_id.coordenadas,
            tarefa.propriedade_id.coordenadas
          );
        } else {
          tarefa.tempo_viagem_minutos = 0;
        }
      } catch (viagemErr) {
        console.error('⚠️  minhaTarefaDetalhe: erro ao calcular tempo_viagem:', viagemErr.message);
        tarefa.tempo_viagem_minutos = tarefa.tempo_viagem_minutos || 0;
      }
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
