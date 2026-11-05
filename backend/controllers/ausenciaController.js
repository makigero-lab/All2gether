/**
 * Ausência Controller — All2gether
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
          'Utilizador não encontrado (ou não é da equipa/gestor da empresa).',
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

    // Desatribui as tarefas do utilizador no período e reatribui-as de imediato
    // a outro staff disponível (best-effort). As que ninguém pode fazer ficam
    // 'por_atribuir' e os gestores são avisados. 'em_curso' fica com a pessoa.
    const desatribuicao = await desatribuirTarefasPeriodo(utilizador_id, inicio, fim);
    desatribuicao.reatribuicao = await reatribuirAutomaticamente(empresaId, utilizador_id, inicio, fim);
    if (desatribuicao.em_curso_mantidas > 0) {
      const alvo = await Utilizador.findById(utilizador_id).select('nome').lean();
      await avisarGestoresEmCurso(empresaId, alvo?.nome, desatribuicao);
      desatribuicao.aviso = textoEmCurso(desatribuicao, alvo?.nome);
    }
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
 * Lógica:
 *   - Se 'aprovada': desatribui as tarefas do utilizador no período
 *     [data_inicio, data_fim] e reatribui-as logo, sem clique, a outro staff
 *     disponível (best-effort). As que ninguém pode fazer ficam 'por_atribuir'
 *     e os gestores são avisados. 'em_curso' fica com a pessoa.
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
    if (ausencia.estado === 'cancelada') {
      return res.status(400).json({
        erro: 'Não é possível aprovar/rejeitar uma ausência cancelada. Cria uma nova.',
      });
    }

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

    // Se aprovada → desatribui tarefas do período E TENTA REATRIBUIÇÃO AUTOMÁTICA.
    // FIX (auto-reatribuição inteligente) — Após desatribuir as tarefas do
    // funcionário ausente, o sistema executa o load balancer para cada tarefa,
    // tentando alocá-la a outro staff ATIVO, DISPONÍVEL (sem folga/férias) e
    // com menor carga. Se encontrar alguém, reatribui automaticamente; se não,
    // a tarefa fica 'por_atribuir' para o gestor resolver manualmente.
    if (novoEstado === 'aprovada') {
      redistribuicao = await desatribuirTarefasPeriodo(
        ausencia.utilizador_id,
        ausencia.data_inicio,
        ausencia.data_fim
      );

      // Reatribuição automática (best-effort: se falhar, a aprovação sucede e o
      // resultado traz `erro`).
      redistribuicao.reatribuicao = await reatribuirAutomaticamente(
        empresaId,
        ausencia.utilizador_id,
        ausencia.data_inicio,
        ausencia.data_fim
      );
    }

    // Auditoria.
    const utilizador = await Utilizador.findById(ausencia.utilizador_id).select('nome').lean();
    if (redistribuicao && redistribuicao.em_curso_mantidas > 0) {
      await avisarGestoresEmCurso(empresaId, utilizador?.nome, redistribuicao);
      redistribuicao.aviso = textoEmCurso(redistribuicao, utilizador?.nome);
    }
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
          ? `Ausência aprovada. ${redistribuicao.desatribuidas} tarefa(s) desatribuída(s). ` +
            textoReatribuicao(redistribuicao.reatribuicao) +
            (redistribuicao.aviso ? ` ${redistribuicao.aviso}` : '')
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
 * Lista (só leitura) as tarefas 'em_curso' de um utilizador em [inicio, fimDia[.
 * @returns {Promise<Array<{ tarefa_id, propriedade, data }>>}
 */
async function listarEmCurso(utilizadorId, inicio, fimDia) {
  const docs = await Tarefa.find({
    utilizador_id: utilizadorId,
    data: { $gte: inicio, $lt: fimDia },
    estado: 'em_curso',
  })
    .populate({ path: 'propriedade_id', select: 'nome' })
    .select('data propriedade_id')
    .lean();
  return docs.map((t) => ({
    tarefa_id: String(t._id),
    propriedade: t.propriedade_id?.nome ?? null,
    data: t.data,
  }));
}

/**
 * Desatribui as tarefas ATRIBUÍDAS de um utilizador num período
 * [inicio, fim]: passa utilizador_id = null + estado = 'por_atribuir'.
 *
 * Tarefas 'em_curso' (a pessoa já começou a limpeza) NÃO são desatribuídas:
 * ficam intactas (mesma pessoa, mesmo estado) e são devolvidas em
 * `em_curso_mantidas`/`em_curso` para o gestor ser avisado e decidir se a
 * pessoa termina ou se trata dela. NUNCA mexe em 'concluida' nem 'cancelada'.
 *
 * Esta função só desatribui. A reatribuição automática é feita a seguir por
 * reatribuirAutomaticamente (ausências) ou não é feita (inativação de membro).
 *
 * @param {ObjectId} utilizadorId
 * @param {Date} inicio
 * @param {Date} fim
 * @param {{ incluirEmCurso?: boolean }} [opts] — `incluirEmCurso: true` desatribui também
 *   as 'em_curso' (só para inativação de membro: quem fica inativo não consegue
 *   autenticar-se, por isso a tarefa ficaria presa). Default false.
 * @returns {Promise<{ total, desatribuidas, em_curso_mantidas,
 *   em_curso: Array<{ tarefa_id, propriedade, data }> }>}
 */
async function desatribuirTarefasPeriodo(utilizadorId, inicio, fim, opts = {}) {
  const incluirEmCurso = opts.incluirEmCurso === true;
  // fim do dia = meia-noite do dia seguinte (para query <).
  const fimDia = new Date(fim.getTime() + 24 * 60 * 60 * 1000);

  const filtroBase = { utilizador_id: utilizadorId, data: { $gte: inicio, $lt: fimDia } };

  // Só 'atribuida' é desatribuída (decisão do gestor: 'em_curso' mantém-se).
  const tarefas = await Tarefa.find({
    ...filtroBase,
    estado: incluirEmCurso ? { $in: ['atribuida', 'em_curso'] } : 'atribuida',
  });

  // Tarefas em curso que ficam com a pessoa (só leitura).
  const em_curso = incluirEmCurso ? [] : await listarEmCurso(utilizadorId, inicio, fimDia);

  let desatribuidas = 0;
  for (const tarefa of tarefas) {
    tarefa.utilizador_id = null;
    tarefa.equipa_atribuida = [];
    tarefa.estado = 'por_atribuir';
    await tarefa.save();
    desatribuidas++;
  }

  console.log(
    `📤 [desatribuirTarefasPeriodo] ${desatribuidas} tarefa(s) desatribuída(s), ` +
      `${em_curso.length} em curso mantida(s) ` +
      `(utilizador=${utilizadorId}, período=${inicio.toISOString().slice(0, 10)} ` +
      `a ${fim.toISOString().slice(0, 10)}).`
  );

  return { total: tarefas.length, desatribuidas, em_curso_mantidas: em_curso.length, em_curso };
}

/**
 * Frase para o gestor sobre limpezas em curso mantidas (ou '' se não houver).
 */
function textoEmCurso(resultado, nomeStaff) {
  const n = resultado?.em_curso_mantidas || 0;
  if (n === 0) return '';
  const quem = nomeStaff || 'o funcionário';
  const props = (resultado.em_curso || []).map((t) => t.propriedade).filter(Boolean);
  const onde = props.length ? ` (${props.join(', ')})` : '';
  return n === 1
    ? `1 limpeza em curso${onde} continua com ${quem}: confirma se termina ou trata dela.`
    : `${n} limpezas em curso${onde} continuam com ${quem}: confirma se terminam ou trata delas.`;
}

/**
 * Avisa os gestores/admins da empresa (push + sino in-app) das limpezas em
 * curso que ficaram com a pessoa ausente. Assim o aviso não depende de quem
 * fez a ação estar a ver o ecrã. Best-effort: nunca lança.
 */
async function avisarGestoresEmCurso(empresaId, nomeStaff, resultado) {
  const texto = textoEmCurso(resultado, nomeStaff);
  if (!texto) return;
  await avisarGestores(empresaId, '⚠️ Limpeza em curso', texto);
}

/**
 * Push + sino in-app a todos os gestores/admins ativos da empresa.
 * Best-effort: nunca lança.
 */
async function avisarGestores(empresaId, titulo, texto, url = '/gestor/calendario') {
  try {
    const { notificarUtilizador } = require('../utils/notificar');
    const gestores = await Utilizador.find({
      empresa_id: empresaId,
      role: { $in: ['gestor', 'admin'] },
      ativo: true,
      eliminado_em: null,
    })
      .select('_id')
      .lean();
    for (const g of gestores) {
      await notificarUtilizador(String(g._id), titulo, texto, url, {
        criarInApp: true,
        tipo: 'aviso',
      });
    }
  } catch (e) {
    console.error('⚠️  avisarGestores:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* FIX (auto-reatribuição) — Reatribuição automática inteligente      */
/* ------------------------------------------------------------------ */

/**
 * Reatribui automaticamente as tarefas de um utilizador num período, usando
 * o load balancer para encontrar staff ATIVO, DISPONÍVEL (sem folga/férias)
 * e com menor carga horária.
 *
 * Usado (via reatribuirAutomaticamente) por: aprovarRejeitarAusencia,
 * reaplicarAusencia, registarAusencia, reportarFaltaSubita,
 * registarBaixaProlongada e faltaHoje, sempre depois de desatribuir.
 *
 * Para cada tarefa desatribuída:
 *   1. Calcula o range do dia da tarefa.
 *   2. Chama determinarUtilizadorAtribuido (load balancer).
 *   3. Se encontrar staff elegível → reatribui (utilizador_id + estado 'atribuida'
 *      + recalcula hora via scheduler).
 *   4. Se não houver ninguém disponível → mantém 'por_atribuir'.
 *
 * NUNCA mexe em 'concluida' nem 'cancelada' (histórico preservado).
 *
 * @param {string} empresaId
 * @param {ObjectId} utilizadorId — utilizador que ficou ausente (excluído do pool).
 * @param {Date} inicio
 * @param {Date} fim
 * @returns {Promise<{ total, reatribuidas, orfas }>}
 */
async function reatribuirTarefasPeriodo(empresaId, utilizadorId, inicio, fim) {
  const fimDia = new Date(fim.getTime() + 24 * 60 * 60 * 1000);

  // Lazy imports para evitar dependência circulares no carregamento do módulo.
  const { determinarUtilizadorAtribuido } = require('../utils/loadBalancer');
  const { calcularInicioTarefaUtilizador } = require('../utils/scheduler');

  // Procura as tarefas que estão 'por_atribuir' no período (acabaram de ser
  // desatribuídas por desatribuirTarefasPeriodo, ou já estavam por atribuir).
  const tarefas = await Tarefa.find({
    empresa_id: empresaId,
    data: { $gte: inicio, $lt: fimDia },
    estado: { $in: ['por_atribuir', 'nao_atribuida'] },
  })
    .populate({ path: 'propriedade_id', select: 'nome coordenadas' })
    .lean();

  if (tarefas.length === 0) {
    console.log(
      `ℹ️ [reatribuirTarefasPeriodo] 0 tarefas para reatribuir ` +
        `(empresa=${empresaId}, período=${inicio.toISOString().slice(0, 10)} ` +
        `a ${fim.toISOString().slice(0, 10)}).`
    );
    return { total: 0, reatribuidas: 0, orfas: 0 };
  }

  let reatribuidas = 0;
  let orfas = 0;
  // Quantas tarefas recebeu cada pessoa (para uma só notificação por pessoa).
  const recebidas = new Map();

  for (const tarefa of tarefas) {
    try {
      const d = new Date(tarefa.data);
      const start = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      );
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const range = { start, end };

      const coordenadas = tarefa.propriedade_id?.coordenadas ?? null;
      const tempoNovaTarefa = tarefa.tempo_limpeza_minutos || 45;
      const propriedadeId = tarefa.propriedade_id?._id ?? null;

      // Invoca o load balancer. Ele filtra automaticamente:
      //   - staff ativo (ativo: true, eliminado_em: null)
      //   - sem folga fixa nesse dia (dias_folga)
      //   - sem ausência aprovada/pendente_emergencia (query Ausencia)
      //   - exclui o utilizadorId passado via excluirStaffIds (o ausente)
      const staffExcluidos = new Set([String(utilizadorId)]);
      const resultadoLB = await determinarUtilizadorAtribuido(
        empresaId,
        range,
        coordenadas,
        tempoNovaTarefa,
        propriedadeId,
        staffExcluidos
      );

      const utilizadorAtribuido = resultadoLB?.utilizadorId ?? null;

      if (utilizadorAtribuido) {
        // Recalcula hora de início via scheduler sequencial.
        let novaData = tarefa.data;
        let tempoViagemScheduler = 0;
        try {
          const resultadoScheduler = await calcularInicioTarefaUtilizador(
            utilizadorAtribuido,
            start,
            coordenadas,
            tempoNovaTarefa
          );
          novaData = resultadoScheduler.data;
          tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
        } catch (errScheduler) {
          console.warn(
            `⚠️ [reatribuirTarefasPeriodo] scheduler falhou para tarefa ${tarefa._id}:`,
            errScheduler.message
          );
        }

        await Tarefa.updateOne(
          { _id: tarefa._id },
          {
            $set: {
              utilizador_id: utilizadorAtribuido,
              estado: 'atribuida',
              data: novaData,
              tempo_viagem_minutos: tempoViagemScheduler,
              motivo_nao_atribuicao: null,
            },
          }
        );

        reatribuidas++;
        const nomeProp = tarefa.propriedade_id?.nome ?? 'Propriedade';
        const idStr = String(utilizadorAtribuido);
        const ant = recebidas.get(idStr) || [];
        ant.push(nomeProp);
        recebidas.set(idStr, ant);
        console.log(
          `✅ [reatribuirTarefasPeriodo] Tarefa ${tarefa._id} reatribuída a staff ${utilizadorAtribuido}.`
        );
      } else {
        // Ninguém disponível — mantém 'por_atribuir'.
        orfas++;
        console.log(
          `⚠️ [reatribuirTarefasPeriodo] Tarefa ${tarefa._id} sem staff disponível (permanece por_atribuir).`
        );
      }
    } catch (errTarefa) {
      orfas++;
      console.error(
        `❌ [reatribuirTarefasPeriodo] Erro na tarefa ${tarefa._id}:`,
        errTarefa.message
      );
    }
  }

  // Quem recebeu tarefas é avisado (push + sino), como nos outros caminhos de
  // atribuição. Uma notificação por pessoa, não uma por tarefa.
  try {
    const { notificarUtilizador } = require('../utils/notificar');
    for (const [idStr, props] of recebidas) {
      await notificarUtilizador(
        idStr,
        '🔄 Tarefas reatribuídas',
        props.length === 1
          ? `Foste escalado para limpar a ${props[0]}.`
          : `Foste escalado para ${props.length} limpezas: ${[...new Set(props)].join(', ')}.`,
        '/staff',
        { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId), criarInApp: true }
      );
    }
  } catch (errNotif) {
    console.error('⚠️ [reatribuirTarefasPeriodo] notificar:', errNotif.message);
  }

  console.log(
    `🤖 [reatribuirTarefasPeriodo] ${tarefas.length} processada(s), ` +
      `${reatribuidas} reatribuída(s), ${orfas} órfã(s) ` +
      `(empresa=${empresaId}, período=${inicio.toISOString().slice(0, 10)} a ${fim.toISOString().slice(0, 10)}).`
  );

  return { total: tarefas.length, reatribuidas, orfas };
}

/**
 * Reatribuição automática depois de uma ausência (aprovada, registada pelo
 * gestor, falta súbita, baixa ou falta de emergência).
 *
 * Best-effort: NUNCA lança. Se falhar, a operação principal já sucedeu, as
 * tarefas ficam por atribuir e o resultado traz `erro` (e os gestores são
 * avisados). Se sobrarem tarefas sem ninguém disponível, os gestores recebem
 * um aviso (push + sino).
 *
 * A pessoa ausente nunca recebe tarefas (é excluída do pool e o load balancer
 * filtra ausências aprovadas/de emergência). 'em_curso' não é tocada.
 *
 * Nota: processa TODAS as tarefas por atribuir da empresa no período, não só
 * as da pessoa ausente; por isso `reatribuidas + orfas` pode ser maior que
 * `desatribuidas`.
 *
 * @returns {Promise<{ total, reatribuidas, orfas, erro?: string }>}
 */
async function reatribuirAutomaticamente(empresaId, utilizadorId, inicio, fim) {
  let resultado;
  try {
    resultado = await reatribuirTarefasPeriodo(empresaId, utilizadorId, inicio, fim);
  } catch (err) {
    console.error('⚠️ [reatribuirAutomaticamente] falhou (best-effort):', err.message);
    resultado = { total: 0, reatribuidas: 0, orfas: 0, erro: err.message };
    await avisarGestores(
      empresaId,
      '⚠️ Reatribuição automática falhou',
      'A ausência foi registada mas não foi possível reatribuir as tarefas. Ficam por atribuir: usa "Reatribuir automaticamente".',
      '/gestor/equipa'
    );
    return resultado;
  }
  if (resultado.orfas > 0) {
    const di = new Date(inicio).toISOString().slice(0, 10);
    const df = new Date(fim).toISOString().slice(0, 10);
    const periodo = di === df ? `em ${di}` : `entre ${di} e ${df}`;
    await avisarGestores(
      empresaId,
      '⚠️ Tarefas por atribuir',
      `${resultado.orfas} tarefa(s) ficaram por atribuir ${periodo}: ninguém está disponível. Atribui-as manualmente.`
    );
  }
  return resultado;
}

/** Frase curta (para mensagens do backend) sobre o resultado da reatribuição. */
function textoReatribuicao(re) {
  if (!re) return '';
  if (re.erro) return 'Não foi possível reatribuir automaticamente: ficam por atribuir.';
  const partes = [];
  if (re.reatribuidas > 0) partes.push(`${re.reatribuidas} tarefa(s) reatribuída(s) automaticamente`);
  if (re.orfas > 0) partes.push(`${re.orfas} por atribuir (ninguém disponível)`);
  return partes.length ? `${partes.join('; ')}.` : '';
}

/* ------------------------------------------------------------------ */
/* HF26 — Reaplicar ausência (forçar desatribuição)                    */
/* ------------------------------------------------------------------ */

/**
 * POST /api/gestor/ausencias/:id/reaplicar
 *
 * Re-executa desatribuirTarefasPeriodo para uma ausência JÁ aprovada.
 *
 * Caso de uso: o gestor aprovou a ausência, mas as tarefas continuam
 * atribuídas ao staff (ex.: webhook criou tarefas depois da aprovação
 * e o LB falhou em filtrar, ou a desatribuição inicial falhou). Este
 * endpoint permite "reaplicar" a ausência sem ter de a cancelar e recriar.
 *
 * Resposta 200: { mensagem, redistribuicao, ausencia }
 */
exports.reaplicarAusencia = async (req, res) => {
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

    if (ausencia.estado !== 'aprovada') {
      return res.status(400).json({
        erro: `Só se podem reaplicar ausências aprovadas (atual: ${ausencia.estado}).`,
      });
    }

    // Re-executa a desatribuição no período da ausência.
    const redistribuicao = await desatribuirTarefasPeriodo(
      ausencia.utilizador_id,
      ausencia.data_inicio,
      ausencia.data_fim
    );

    // Reatribui de imediato (best-effort; nunca lança).
    redistribuicao.reatribuicao = await reatribuirAutomaticamente(
      empresaId,
      ausencia.utilizador_id,
      ausencia.data_inicio,
      ausencia.data_fim
    );

    const utilizador = await Utilizador.findById(ausencia.utilizador_id).select('nome').lean();
    if (redistribuicao.em_curso_mantidas > 0) {
      await avisarGestoresEmCurso(empresaId, utilizador?.nome, redistribuicao);
      redistribuicao.aviso = textoEmCurso(redistribuicao, utilizador?.nome);
    }

    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'reaplicar_ausencia',
      recurso: 'ausencia',
      recurso_id: ausencia._id,
      descricao: `Ausência reaplicada para "${utilizador?.nome ?? '?'}": ${redistribuicao.desatribuidas} tarefa(s) desatribuída(s).`,
      detalhes: {
        utilizador_id: String(ausencia.utilizador_id),
        data_inicio: ausencia.data_inicio,
        data_fim: ausencia.data_fim,
        redistribuicao,
      },
    });

    return res.status(200).json({
      mensagem: (
        redistribuicao.desatribuidas > 0
          ? `Ausência reaplicada. ${redistribuicao.desatribuidas} tarefa(s) desatribuída(s)` +
            (redistribuicao.reatribuicao
              ? `; ${redistribuicao.reatribuicao.reatribuidas} reatribuída(s) automaticamente` +
                (redistribuicao.reatribuicao.orfas > 0
                  ? `; ${redistribuicao.reatribuicao.orfas} permanece(m) por atribuir.`
                  : '.')
              : '.')
          : 'Ausência reaplicada. Não havia tarefas atribuídas no período (já estavam corretas).' +
            (redistribuicao.reatribuicao && (redistribuicao.reatribuicao.reatribuidas > 0 || redistribuicao.reatribuicao.erro)
              ? ` ${textoReatribuicao(redistribuicao.reatribuicao)}`
              : '')) +
        (redistribuicao.aviso ? ` ${redistribuicao.aviso}` : ''),
      redistribuicao,
      ausencia,
    });
  } catch (err) {
    console.error('❌ reaplicarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* HF26 — Diagnóstico de ausências (auditoria de estado)               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/gestor/ausencias/diagnostico/:utilizadorId
 *
 * Auditoria completa do estado de ausências de um utilizador.
 *
 * Retorna:
 *   - dados do utilizador (incluindo empresa_id e eliminado_em)
 *   - empresa_id do gestor autenticado (para comparar)
 *   - todas as ausências do utilizador (SEM filtro de empresa — para
 *     detetar mismatch de empresa_id)
 *   - tarefas atribuídas ao utilizador no período de cada ausência
 *   - diagnóstico automático (causa provável se houver inconsistência)
 *
 * Caso de uso: o gestor vê staff com tarefas atribuídas durante férias
 * "aprovadas" que não aparecem no calendário. Este endpoint permite
 * identificar a causa raiz (empresa errada, utilizador recriado, datas
 * erradas, etc.).
 *
 * Resposta 200: { utilizador, empresaGestor, ausencias, diagnostico }
 */
exports.diagnosticoAusencia = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { utilizadorId } = req.params;
    if (!mongoose.isValidObjectId(utilizadorId)) {
      return res.status(400).json({ erro: 'utilizadorId inválido.' });
    }

    // Busca o utilizador SEM filtro de empresa (para detetar mismatch).
    const utilizador = await Utilizador.findById(utilizadorId)
      .select('nome email role empresa_id eliminado_em ativo')
      .lean();

    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (pode ter sido eliminado permanentemente).',
      });
    }

    // Busca TODAS as ausências do utilizador (sem filtro de empresa).
    const ausencias = await Ausencia.find({ utilizador_id: utilizadorId })
      .sort({ data_inicio: -1 })
      .select('empresa_id data_inicio data_fim tipo estado createdAt updatedAt')
      .lean();

    // Para cada ausência, conta as tarefas atribuídas no período.
    const ausenciasComTarefas = await Promise.all(
      ausencias.map(async (a) => {
        const fimDia = new Date(a.data_fim.getTime() + 24 * 60 * 60 * 1000);
        const tarefasAtribuidas = await Tarefa.countDocuments({
          utilizador_id: utilizadorId,
          data: { $gte: a.data_inicio, $lt: fimDia },
          estado: { $in: ['atribuida', 'em_curso'] },
        });
        return {
          ...a,
          data_inicio: a.data_inicio.toISOString().slice(0, 10),
          data_fim: a.data_fim.toISOString().slice(0, 10),
          tarefas_atribuidas_no_periodo: tarefasAtribuidas,
          empresa_match: String(a.empresa_id) === String(empresaId),
        };
      })
    );

    // Diagnóstico automático.
    const diagnostico = [];
    const empresaMatch = String(utilizador.empresa_id) === String(empresaId);
    if (!empresaMatch) {
      diagnostico.push({
        severidade: 'critica',
        mensagem: `MISMATCH DE EMPRESA: o utilizador pertence à empresa ${utilizador.empresa_id} mas o gestor autenticado está na empresa ${empresaId}. As ausências e tarefas só aparecem para a empresa correta.`,
      });
    }
    if (utilizador.eliminado_em) {
      diagnostico.push({
        severidade: 'critica',
        mensagem: `Utilizador ELIMINADO (soft delete em ${utilizador.eliminado_em.toISOString().slice(0, 10)}). Foi provavelmente recriado com outro _id — as ausências antigas não se aplicam ao novo utilizador.`,
      });
    }
    if (!utilizador.ativo) {
      diagnostico.push({
        severidade: 'aviso',
        mensagem: 'Utilizador inativo. Não deveria receber tarefas (o LB filtra por ativo=true).',
      });
    }

    const aprovadas = ausenciasComTarefas.filter((a) => a.estado === 'aprovada');
    if (aprovadas.length === 0) {
      diagnostico.push({
        severidade: 'aviso',
        mensagem: 'Nenhuma ausência APROVADA encontrada para este utilizador. Pendentes não bloqueiam o LB nem aparecem no calendário.',
      });
    } else {
      for (const a of aprovadas) {
        if (!a.empresa_match) {
          diagnostico.push({
            severidade: 'critica',
            mensagem: `Ausência aprovada (${a.data_inicio} a ${a.data_fim}) pertence a OUTRA empresa (${a.empresa_id}). Não aparecerá no calendário nem bloqueará o LB para a empresa atual.`,
          });
        }
        if (a.tarefas_atribuidas_no_periodo > 0) {
          diagnostico.push({
            severidade: 'critica',
            mensagem: `Ausência aprovada (${a.data_inicio} a ${a.data_fim}) com ${a.tarefas_atribuidas_no_periodo} tarefa(s) atribuída(s) no período. Inconsistência: o LB deveria ter bloqueado. Usa o botão "Reaplicar" para forçar a desatribuição.`,
          });
        }
      }
    }

    if (diagnostico.length === 0) {
      diagnostico.push({
        severidade: 'ok',
        mensagem: 'Tudo consistente. Ausências aprovadas sem tarefas atribuídas no período.',
      });
    }

    return res.status(200).json({
      utilizador: {
        _id: String(utilizador._id),
        nome: utilizador.nome,
        email: utilizador.email,
        role: utilizador.role,
        empresa_id: String(utilizador.empresa_id),
        eliminado_em: utilizador.eliminado_em
          ? utilizador.eliminado_em.toISOString().slice(0, 10)
          : null,
        ativo: utilizador.ativo,
      },
      empresaGestor: String(empresaId),
      empresaMatch,
      ausencias: ausenciasComTarefas,
      diagnostico,
    });
  } catch (err) {
    console.error('❌ diagnosticoAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

// Exporta o helper para reutilização (registarBaixaProlongada, falta súbita).
exports.desatribuirTarefasPeriodo = desatribuirTarefasPeriodo;
exports.textoEmCurso = textoEmCurso;
exports.listarEmCurso = listarEmCurso;
exports.avisarGestoresEmCurso = avisarGestoresEmCurso;
exports.reatribuirTarefasPeriodo = reatribuirTarefasPeriodo;
exports.reatribuirAutomaticamente = reatribuirAutomaticamente;
exports.textoReatribuicao = textoReatribuicao;
