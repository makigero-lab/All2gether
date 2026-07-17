/**
 * Ausência Controller — FisioCell
 *
 * Gestão de Folgas e Férias da equipa.
 *
 * Endpoints (montados em /api/admin/ausencias):
 *   GET    /            — lista ausências da empresa (populate utilizador)
 *   POST   /            — regista nova ausência (valida intervalo + pertença)
 *   DELETE /:id         — elimina ausência
 *
 * O `empresa_id` vem do JWT (via `req.user.empresa_id`, injetado pelo
 * middleware `auth`). v1.10.0: fallback legacy `x-empresa-id` REMOVIDO.
 * Todas as operações validam que a ausência / utilizador pertence à mesma empresa.
 */

const mongoose = require('mongoose');
const Ausencia = require('../models/Ausencia');
const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const { registarAuditoria } = require('../utils/auditoria');

/**
 * Lê o `empresa_id` do JWT (req.user.empresa_id).
 * v1.10.0: sem fallback legacy — o middleware `auth` já garante req.user.
 */
function obterEmpresaId(req, res) {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    res.status(400).json({ erro: 'empresa_id em falta no token.' });
    return { ok: false };
  }
  if (!mongoose.isValidObjectId(empresaId)) {
    res.status(400).json({ erro: 'empresa_id do token inválido.' });
    return { ok: false };
  }
  return { ok: true, empresaId };
}

/** Normaliza uma data para meia-noite UTC. */
function normalizarDia(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * GET /api/admin/ausencias
 * Lista as ausências da empresa, com o utilizador populado.
 *
 * Query params opcionais:
 *   ?futuras=true  — só ausências com data_fim >= hoje (úteis para o calendário)
 *
 * Resposta 200: { ausencias: [...] }
 */
exports.listarAusencias = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const filtro = { empresa_id: empresaId };
    if (req.query.futuras === 'true') {
      const hoje = normalizarDia(new Date());
      filtro.data_fim = { $gte: hoje };
    }
    // v1.25.0: filtro por estado (pendente/aprovada/rejeitada) — usado pelo
    // Centro de Aprovações de RH para mostrar só pendentes.
    // v1.26.0: suporta comma-separated (ex: ?estado=pendente,pendente_emergencia)
    // v1.39.0 (Prompt 131b): adicionado 'cancelada' (soft cancel mantém histórico).
    const ESTADOS_VALIDOS = ['pendente', 'pendente_emergencia', 'aprovada', 'rejeitada', 'cancelada'];
    if (req.query.estado) {
      const estados = String(req.query.estado)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => ESTADOS_VALIDOS.includes(s));
      if (estados.length === 1) {
        filtro.estado = estados[0];
      } else if (estados.length > 1) {
        filtro.estado = { $in: estados };
      }
    }

    const ausencias = await Ausencia.find(filtro)
      .populate({ path: 'utilizador_id', select: 'nome email role' })
      .sort({ data_inicio: 1 })
      .lean();

    // Transforma: utilizador_id (objeto populated) → campo `utilizador` limpo
    // + utilizador_id como string.
    const transformadas = ausencias.map((a) => {
      const u = a.utilizador_id;
      return {
        ...a,
        utilizador_id: u ? String(u._id) : null,
        utilizador: u
          ? { _id: String(u._id), nome: u.nome, email: u.email, role: u.role }
          : null,
      };
    });

    return res.status(200).json({ ausencias: transformadas });
  } catch (err) {
    console.error('❌ listarAusencias:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/admin/ausencias
 * Regista uma nova ausência (folga ou férias).
 *
 * Body: { utilizador_id, data_inicio, data_fim, tipo, notas? }
 *
 * Validações:
 *   - utilizador_id tem de pertencer à empresa e ter role staff/gestor (não admin).
 *   - data_inicio e data_fim obrigatórias e data_fim >= data_inicio.
 *   - tipo em ['ferias','folga'].
 *   - Não pode haver sobreposição com outra ausência do mesmo utilizador.
 *
 * Resposta 201: { ausencia: { ... } }.
 */
exports.registarAusencia = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { utilizador_id, data_inicio, data_fim, tipo, notas } = req.body || {};

    // Validações de presença.
    if (!utilizador_id || !data_inicio || !data_fim) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: utilizador_id, data_inicio, data_fim.',
      });
    }
    if (!mongoose.isValidObjectId(utilizador_id)) {
      return res.status(400).json({ erro: 'utilizador_id inválido.' });
    }

    // Valida o utilizador: existe, pertence à empresa, e NÃO é admin
    // (admins não recebem tarefas de limpeza, não fazem sentido ter folgas).
    const utilizador = await Utilizador.findOne({
      _id: utilizador_id,
      empresa_id: empresaId,
      role: { $in: ['staff', 'gestor'] },
    });
    if (!utilizador) {
      return res.status(400).json({
        erro:
          'Utilizador não encontrado (ou não é staff/gestor da empresa).',
      });
    }

    // Normaliza datas.
    const inicio = normalizarDia(data_inicio);
    const fim = normalizarDia(data_fim);
    if (!inicio || !fim) {
      return res.status(400).json({ erro: 'data_inicio ou data_fim inválidas.' });
    }
    if (fim < inicio) {
      return res.status(400).json({
        erro: 'data_fim não pode ser anterior a data_inicio.',
      });
    }

    // Valida tipo (v1.24.0: enum alargado para ferias/doenca/outro).
    const tipoFinal = tipo || 'ferias';
    if (!['ferias', 'doenca', 'outro'].includes(tipoFinal)) {
      return res.status(400).json({
        erro: 'tipo inválido. Valores permitidos: ferias, doenca, outro.',
      });
    }

    // Valida sobreposição: não pode haver outra ausência do mesmo utilizador
    // cujo intervalo se sobreponha [inicio, fim].
    // Sobreposição: existing.data_inicio <= fim AND existing.data_fim >= inicio
    // Prompt 123 — SÓ bloqueia se houver uma ausência com estado 'pendente'
    // ou 'aprovada'. 'rejeitada' e 'pendente_emergencia' NÃO bloqueiam.
    const sobreposta = await Ausencia.findOne({
      utilizador_id,
      data_inicio: { $lte: fim },
      data_fim: { $gte: inicio },
      estado: { $in: ['pendente', 'aprovada'] },
    });
    if (sobreposta) {
      return res.status(409).json({
        erro: 'Já existe uma ausência registada que se sobrepõe a este período.',
      });
    }

    // Prompt 131 — Remove o índice único antigo antes de tentar criar.
    try {
      const indexes = await Ausencia.collection.listIndexes().toArray();
      for (const idx of indexes) {
        if (idx.unique && idx.key && idx.key.utilizador_id) {
          console.log(`[registarAusencia] A remover índice único antigo: ${idx.name}`);
          await Ausencia.collection.dropIndex(idx.name);
        }
      }
    } catch (idxErr) {
      // Não bloqueia se falhar.
    }

    // v1.24.0: admin a criar ausência diretamente → estado 'aprovada'
    // (o fluxo de aprovação só se aplica aos pedidos do staff via /api/auth/me/ausencias).
    const nova = await Ausencia.create({
      utilizador_id,
      empresa_id: empresaId,
      data_inicio: inicio,
      data_fim: fim,
      tipo: tipoFinal,
      estado: 'aprovada',
      notas: notas ? String(notas).trim() : '',
    });

    // Prompt 97 — Desatribui as tarefas do utilizador no período (SEM load
    // balancer): passam a utilizador_id = null + estado = 'por_atribuir'.
    // O recálculo fica a cargo do Gestor (manual) ou do Fail-Safe noturno.
    const desatribuicao = await desatribuirTarefasPeriodo(utilizador_id, inicio, fim);
    if (desatribuicao.desatribuidas > 0) {
      console.log(
        `📤 [registarAusencia] ${desatribuicao.desatribuidas} tarefa(s) desatribuída(s) ` +
          `(utilizador ${utilizador_id}, período ${inicio.toISOString().slice(0, 10)} ` +
          `a ${fim.toISOString().slice(0, 10)}).`
      );
    }

    // Resposta com utilizador populado (para o frontend não precisar de refetch).
    const resp = await Ausencia.findById(nova._id)
      .populate({ path: 'utilizador_id', select: 'nome email role' })
      .lean();
    const u = resp.utilizador_id;
    return res.status(201).json({
      ausencia: {
        ...resp,
        utilizador_id: u ? String(u._id) : null,
        utilizador: u
          ? { _id: String(u._id), nome: u.nome, email: u.email, role: u.role }
          : null,
      },
      desatribuicao,
    });
  } catch (err) {
    console.error('❌ registarAusencia:', err.message);

    // Prompt 131 — Erro de duplicate key (índice único antigo na BD).
    // O índice único é removido no arranque do servidor. NÃO elimina ausências.
    if (err.code === 11000) {
      console.error('[registarAusencia] Erro 11000 (duplicate key). O índice único antigo pode ainda existir na BD.');
      return res.status(409).json({
        erro: 'Já existe uma ausência com esta data de início. O índice único será removido no próximo arranque do servidor.',
      });
    }

    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * DELETE /api/admin/ausencias/:id
 * Elimina uma ausência.
 *
 * Validações:
 *   - A ausência tem de pertencer à empresa do JWT.
 *
 * Resposta 200: { mensagem, ausencia_id }.
 */
exports.eliminarAusencia = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de ausência inválido.' });
    }

    const ausencia = await Ausencia.findOne({ _id: id, empresa_id: empresaId });
    if (!ausencia) {
      return res.status(404).json({
        erro: 'Ausência não encontrada (ou não pertence a esta empresa).',
      });
    }

    await Ausencia.deleteOne({ _id: id });

    return res.status(200).json({
      mensagem: 'Ausência eliminada com sucesso.',
      ausencia_id: id,
    });
  } catch (err) {
    console.error('❌ eliminarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Aprovar / Rejeitar ausência (v1.24.0)                              */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/admin/ausencias/:id/estado
 *
 * Aprova ou rejeita um pedido de ausência (criado pelo staff como 'pendente').
 *
 * Body: { estado: 'aprovada' | 'rejeitada' }
 *
 * Lógica (Prompt 97 — "Desligar a Histeria Automática"):
 *   - Se 'aprovada': NÃO chama o load balancer. Apenas desatribui as tarefas
 *     futuras do utilizador no período [data_inicio, data_fim]: passam a
 *     utilizador_id = null + estado = 'por_atribuir'. O recálculo/atribuição
 *     fica a cargo do Gestor (manual) ou do Fail-Safe noturno. Isto evita
 *     disparos automáticos e spam de notificações.
 *   - Se 'rejeitada': apenas atualiza o estado (não mexe nas tarefas).
 *
 * Resposta 200:
 *   {
 *     mensagem, ausencia,
 *     redistribuicao: { total, desatribuidas } | null
 *   }
 */
exports.aprovarRejeitarAusencia = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de ausência inválido.' });
    }

    const novoEstado = req.body?.estado;
    if (!['aprovada', 'rejeitada'].includes(novoEstado)) {
      return res.status(400).json({
        erro: "estado inválido. Valores permitidos: 'aprovada' ou 'rejeitada'.",
      });
    }

    const ausencia = await Ausencia.findOne({ _id: id, empresa_id: empresaId });
    if (!ausencia) {
      return res.status(404).json({
        erro: 'Ausência não encontrada (ou não pertence a esta empresa).',
      });
    }

    // Se já está no estado pedido, não faz nada (idempotente).
    if (ausencia.estado === novoEstado) {
      return res.status(200).json({
        mensagem: `Ausência já estava ${novoEstado}.`,
        ausencia,
        redistribuicao: null,
      });
    }

    // Atualiza o estado.
    ausencia.estado = novoEstado;
    await ausencia.save();

    let redistribuicao = null;

    // Se aprovada → desatribui tarefas do período (SEM load balancer).
    if (novoEstado === 'aprovada') {
      redistribuicao = await desatribuirTarefasPeriodo(
        ausencia.utilizador_id,
        ausencia.data_inicio,
        ausencia.data_fim
      );
    }

    // Auditoria.
    const utilizador = await Utilizador.findById(ausencia.utilizador_id).select('nome').lean();
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: novoEstado === 'aprovada' ? 'aprovar_ausencia' : 'rejeitar_ausencia',
      recurso: 'ausencia',
      recurso_id: ausencia._id,
      descricao: `Ausência de "${utilizador?.nome ?? '?'}" ${novoEstado}${
        redistribuicao ? `: ${redistribuicao.desatribuidas} tarefa(s) desatribuída(s)` : ''
      }`,
      detalhes: {
        utilizador_id: String(ausencia.utilizador_id),
        data_inicio: ausencia.data_inicio,
        data_fim: ausencia.data_fim,
        tipo: ausencia.tipo,
        redistribuicao,
      },
    });

    // v1.37.0 — Notificação push ao staff (se tiver subscrição ativa).
    const { notificarUtilizador } = require('../utils/notificar');
    const dataInicioFmt = new Date(ausencia.data_inicio).toLocaleDateString('pt-PT');
    const dataFimFmt = new Date(ausencia.data_fim).toLocaleDateString('pt-PT');
    if (novoEstado === 'aprovada') {
      notificarUtilizador(
        String(ausencia.utilizador_id),
        '✅ Ausência aprovada',
        `O teu pedido de ${ausencia.tipo} (${dataInicioFmt} a ${dataFimFmt}) foi aprovado.`,
        '/staff/ausencias',
        // Prompt 115 — Decisão de ausência é "principal" → cria in-app.
        { criarInApp: true, tipo: 'sistema' }
      );
    } else {
      notificarUtilizador(
        String(ausencia.utilizador_id),
        '❌ Ausência rejeitada',
        `O teu pedido de ${ausencia.tipo} (${dataInicioFmt} a ${dataFimFmt}) foi rejeitado.`,
        '/staff/ausencias',
        { criarInApp: true, tipo: 'sistema' }
      );
    }

    return res.status(200).json({
      mensagem:
        novoEstado === 'aprovada'
          ? `Ausência aprovada. ${redistribuicao.desatribuidas} tarefa(s) desatribuída(s) (por atribuir).`
          : 'Ausência rejeitada.',
      ausencia,
      redistribuicao,
    });
  } catch (err) {
    console.error('❌ aprovarRejeitarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Cancelar ausência (soft cancel — Prompt 131b / v1.39.0)             */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/gestor/ausencias/:id/cancelar
 *
 * Soft cancel de uma ausência: NÃO elimina o registo (mantém-se para
 * auditoria/histórico). Apenas marca o estado como 'cancelada'.
 *
 * Regras:
 *   - Só pode cancelar ausências com estado 'pendente', 'pendente_emergencia'
 *     ou 'aprovada' (NÃO pode cancelar 'rejeitada' nem 'cancelada').
 *   - Staff (role 'staff') só pode cancelar as SUAS ausências
 *     (valida utilizador_id === req.user.id).
 *   - Gestor/admin pode cancelar qualquer ausência da sua empresa
 *     (valida empresa_id).
 *   - Se a ausência estava 'aprovada', as tarefas que foram desatribuídas
 *     NÃO são automaticamente reatribuídas (apenas log warning — o gestor
 *     pode reatribuir manualmente ou via "Auto-Atribuir Pendentes").
 *
 * Resposta 200: { mensagem, ausencia }
 *   400 — ID inválido / estado não permite cancelamento
 *   403 — sem permissão (staff a tentar cancelar ausência de outro)
 *   404 — ausência não encontrada
 */
exports.cancelarAusencia = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de ausência inválido.' });
    }

    // Constrói o filtro consoante o role:
    //   - Staff: só as suas ausências (utilizador_id = req.user.id).
    //   - Gestor/admin: qualquer ausência da empresa.
    const role = req.user && req.user.role;
    const userId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;

    const filtro = { _id: id };
    if (role === 'staff') {
      if (!userId) {
        return res.status(401).json({ erro: 'Não autenticado.' });
      }
      filtro.utilizador_id = userId;
    } else {
      // gestor/admin — valida empresa_id do token.
      const { ok, empresaId: empId } = obterEmpresaId(req, res);
      if (!ok) return;
      filtro.empresa_id = empId;
    }

    const ausencia = await Ausencia.findOne(filtro);
    if (!ausencia) {
      return res.status(404).json({
        erro: 'Ausência não encontrada (ou não tens permissão para a cancelar).',
      });
    }

    // Só cancela pendentes/aprovadas.
    const estadosCancelaveis = ['pendente', 'pendente_emergencia', 'aprovada'];
    if (!estadosCancelaveis.includes(ausencia.estado)) {
      return res.status(400).json({
        erro: `Não é possível cancelar uma ausência já ${ausencia.estado}.`,
      });
    }

    const estadoAnterior = ausencia.estado;
    ausencia.estado = 'cancelada';
    await ausencia.save();

    // Se estava aprovada, avisa que as tarefas desatribuídas não são
    // automaticamente reatribuídas — o gestor tem de o fazer manualmente.
    let reatribuicaoAviso = null;
    if (estadoAnterior === 'aprovada') {
      reatribuicaoAviso =
        'A ausência estava aprovada e as tarefas do período foram desatribuídas. ' +
        'Reatribui manualmente ou usa "Auto-Atribuir Pendentes".';
      console.log(
        `⚠️  [cancelarAusencia] Ausência ${ausencia._id} estava aprovada — ` +
          `tarefas desatribuídas NÃO foram reatribuídas automaticamente.`
      );
    }

    // Auditoria.
    const utilizador = await Utilizador.findById(ausencia.utilizador_id)
      .select('nome')
      .lean();
    registarAuditoria({
      utilizador_id: userId,
      utilizador_nome: req.user.nome || (role === 'staff' ? 'Staff' : 'Admin'),
      empresa_id: ausencia.empresa_id,
      acao: 'cancelar_ausencia',
      recurso: 'ausencia',
      recurso_id: ausencia._id,
      descricao: `Ausência de "${utilizador?.nome ?? '?'}" cancelada (estado anterior: ${estadoAnterior})`,
      detalhes: {
        utilizador_id: String(ausencia.utilizador_id),
        data_inicio: ausencia.data_inicio,
        data_fim: ausencia.data_fim,
        tipo: ausencia.tipo,
        estado_anterior: estadoAnterior,
        estado_novo: 'cancelada',
        cancelado_por_role: role,
      },
    });

    // Notificação push ao staff dono da ausência (se não for ele a cancelar).
    if (role !== 'staff' && String(ausencia.utilizador_id) !== String(userId)) {
      const { notificarUtilizador } = require('../utils/notificar');
      const dataInicioFmt = new Date(ausencia.data_inicio).toLocaleDateString('pt-PT');
      const dataFimFmt = new Date(ausencia.data_fim).toLocaleDateString('pt-PT');
      notificarUtilizador(
        String(ausencia.utilizador_id),
        '🚫 Ausência cancelada',
        `O teu pedido de ${ausencia.tipo} (${dataInicioFmt} a ${dataFimFmt}) foi cancelado pelo gestor.`,
        '/staff/ausencias',
        { criarInApp: true, tipo: 'sistema' }
      );
    }

    // Resposta com utilizador populado.
    const resp = await Ausencia.findById(ausencia._id)
      .populate({ path: 'utilizador_id', select: 'nome email role' })
      .lean();
    const u = resp.utilizador_id;
    return res.status(200).json({
      mensagem: 'Ausência cancelada com sucesso.',
      ausencia: {
        ...resp,
        utilizador_id: u ? String(u._id) : null,
        utilizador: u
          ? { _id: String(u._id), nome: u.nome, email: u.email, role: u.role }
          : null,
      },
      reatribuicaoAviso,
    });
  } catch (err) {
    console.error('❌ cancelarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Helper: desatribuir tarefas de um utilizador num período           */
/* (Prompt 97 — substitui o antigo redistribuirTarefasPeriodo)        */
/* ------------------------------------------------------------------ */

/**
 * Desatribui as tarefas atribuídas de um utilizador num período
 * [inicio, fim]: passa utilizador_id = null + estado = 'por_atribuir'.
 *
 * Prompt 97 — NÃO chama o load balancer (evita disparos automáticos e spam
 * de notificações). O recálculo/atribuição fica a cargo do Gestor (manual,
 * via "Auto-Atribuir Pendentes") ou do Fail-Safe noturno.
 *
 * @param {ObjectId} utilizadorId
 * @param {Date} inicio
 * @param {Date} fim
 * @returns {Promise<{ total, desatribuidas }>}
 */
async function desatribuirTarefasPeriodo(utilizadorId, inicio, fim) {
  // fim do dia = meia-noite do dia seguinte (para query <).
  const fimDia = new Date(fim.getTime() + 24 * 60 * 60 * 1000);

  // Procura tarefas atribuídas no período (não concluídas nem canceladas).
  const tarefas = await Tarefa.find({
    utilizador_id: utilizadorId,
    data: { $gte: inicio, $lt: fimDia },
    estado: 'atribuida',
  });

  if (tarefas.length === 0) {
    return { total: 0, desatribuidas: 0 };
  }

  let desatribuidas = 0;
  for (const tarefa of tarefas) {
    tarefa.utilizador_id = null;
    tarefa.estado = 'por_atribuir';
    await tarefa.save();
    desatribuidas++;
  }

  return { total: tarefas.length, desatribuidas };
}

// Exporta o helper para reutilização (registarBaixaProlongada, falta súbita).
exports.desatribuirTarefasPeriodo = desatribuirTarefasPeriodo;
