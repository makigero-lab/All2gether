/**
 * Staff Controller — Autocell
 *
 * Endpoints para o staff gerir as SUAS ausências (pedidos de férias/doença).
 *
 * Diferença para o ausenciaController (admin):
 *   - O staff só vê e cria as SUAS ausências (utilizador_id = req.user.id).
 *   - As ausências criadas pelo staff ficam SEMPRE 'pendente' (fluxo de aprovação).
 *   - O staff NÃO pode aprovar/rejeitar (só o admin).
 */

const mongoose = require('mongoose');
const Ausencia = require('../models/Ausencia');
const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const { notificarUtilizador } = require('../utils/notificar');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizarDia(valor) {
  const d = new Date(valor);
  if (isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

/* ------------------------------------------------------------------ */
/* GET /api/staff/ausencias — histórico do próprio utilizador         */
/* ------------------------------------------------------------------ */

/**
 * Devolve o histórico de ausências do utilizador autenticado
 * (todas, qualquer estado). Ordenadas por data_inicio desc.
 */
exports.minhasAusencias = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const ausencias = await Ausencia.find({ utilizador_id: utilizadorId })
      .sort({ data_inicio: -1 })
      .lean();

    return res.status(200).json({ ausencias });
  } catch (err) {
    console.error('❌ minhasAusencias:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/staff/ausencias — criar pedido (sempre 'pendente')       */
/* ------------------------------------------------------------------ */

/**
 * Cria um novo pedido de ausência para o próprio utilizador.
 *
 * Body: { data_inicio, data_fim, tipo, notas? }
 *   - tipo: 'ferias' | 'doenca' | 'outro' (default 'ferias')
 *
 * O estado fica SEMPRE 'pendente' — o staff não pode auto-aprovar.
 *
 * Validações:
 *   - data_inicio e data_fim obrigatórias, data_fim >= data_inicio.
 *   - tipo válido.
 *   - Não pode haver sobreposição com outra ausência do mesmo utilizador.
 *
 * Resposta 201: { ausencia }
 */
exports.criarAusencia = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!utilizadorId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { data_inicio, data_fim, tipo, notas } = req.body || {};

    if (!data_inicio || !data_fim) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: data_inicio e data_fim.',
      });
    }

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

    // Valida tipo.
    const tipoFinal = tipo || 'ferias';
    if (!['ferias', 'doenca', 'outro'].includes(tipoFinal)) {
      return res.status(400).json({
        erro: 'tipo inválido. Valores permitidos: ferias, doenca, outro.',
      });
    }

    // Valida sobreposição.
    // Prompt 130 — SÓ bloqueia se houver ausência com estado 'pendente' ou
    // 'aprovada'. 'rejeitada' e 'pendente_emergencia' NÃO bloqueiam.
    const sobreposta = await Ausencia.findOne({
      utilizador_id: utilizadorId,
      data_inicio: { $lte: fim },
      data_fim: { $gte: inicio },
      estado: { $in: ['pendente', 'aprovada'] },
    });
    if (sobreposta) {
      console.log(`[criarAusencia] BLOQUEIO (sobreposição): ausência ${sobreposta._id} estado=${sobreposta.estado} início=${sobreposta.data_inicio} fim=${sobreposta.data_fim} | pedido: inicio=${inicio} fim=${fim}`);
      return res.status(409).json({
        erro: 'Já existe uma ausência registada que se sobrepõe a este período.',
      });
    }

    // Debug: lista TODAS as ausências deste utilizador que se sobrepõem
    // (qualquer estado) para entender o que está na BD.
    const todasSobrepostas = await Ausencia.find({
      utilizador_id: utilizadorId,
      data_inicio: { $lte: fim },
      data_fim: { $gte: inicio },
    }).select('estado data_inicio data_fim').lean();
    console.log(`[criarAusencia] DEBUG: ${todasSobrepostas.length} ausência(s) sobreposta(s) na BD (qualquer estado):`, JSON.stringify(todasSobrepostas));

    // Prompt 131 — Remove o índice único antigo antes de tentar criar.
    try {
      const indexes = await Ausencia.collection.listIndexes().toArray();
      for (const idx of indexes) {
        if (idx.unique && idx.key && idx.key.utilizador_id) {
          console.log(`[criarAusencia] A remover índice único antigo: ${idx.name}`);
          await Ausencia.collection.dropIndex(idx.name);
        }
      }
    } catch (idxErr) {
      // Não bloqueia se falhar.
    }

    const nova = await Ausencia.create({
      utilizador_id: utilizadorId,
      empresa_id: empresaId,
      data_inicio: inicio,
      data_fim: fim,
      tipo: tipoFinal,
      estado: 'pendente', // sempre pendente — o admin aprova
      notas: notas ? String(notas).trim() : '',
    });

    return res.status(201).json({ ausencia: nova });
  } catch (err) {
    console.error('❌ criarAusencia:', err.message);

    // Prompt 131 — Erro de duplicate key (índice único antigo na BD).
    if (err.code === 11000) {
      console.error('[criarAusencia] BLOQUEIO (11000 duplicate key). Índice único ainda existe. err:', JSON.stringify(err.keyValue || err.message));
      return res.status(409).json({
        erro: 'Já existe uma ausência com esta data de início (erro de índice único).',
      });
    }

    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* DELETE /api/staff/ausencias/:id — cancelar (hard delete, legacy)    */
/* PATCH  /api/staff/ausencias/:id/cancelar — cancelar (soft, Prompt 132) */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/staff/ausencias/:id/cancelar
 *
 * Soft cancel — marca estado='cancelada' (mantém histórico).
 * O staff só pode cancelar as SUAS ausências, e só se estiverem
 * 'pendente', 'pendente_emergencia' ou 'aprovada'.
 *
 * Se a ausência estava 'aprovada', as tarefas desatribuídas no período
 * ficam disponíveis para reatribuição (o gestor pode usar "Auto-Atribuir").
 *
 * Resposta 200: { mensagem, ausencia }
 */
exports.cancelarAusenciaSoft = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de ausência inválido.' });
    }

    const ausencia = await Ausencia.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });

    if (!ausencia) {
      return res.status(404).json({
        erro: 'Ausência não encontrada (ou não te pertence).',
      });
    }

    const estadosCancelaveis = ['pendente', 'pendente_emergencia', 'aprovada'];
    if (!estadosCancelaveis.includes(ausencia.estado)) {
      return res.status(400).json({
        erro: `Não é possível cancelar uma ausência já ${ausencia.estado}.`,
      });
    }

    const estadoAnterior = ausencia.estado;
    ausencia.estado = 'cancelada';
    await ausencia.save();

    console.log(
      `[cancelarAusenciaSoft] Ausência ${ausencia._id} cancelada por staff ${utilizadorId} ` +
      `(estado anterior: ${estadoAnterior}).`
    );

    return res.status(200).json({
      mensagem: 'Ausência cancelada com sucesso.',
      ausencia,
    });
  } catch (err) {
    console.error('❌ cancelarAusenciaSoft:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * DELETE /api/staff/ausencias/:id — hard delete (legacy, mantido para compat).
 *
 * O frontend foi atualizado para usar PATCH /cancelar (soft).
 * Este DELETE é mantido para retrocompatibilidade.
 */
exports.cancelarAusencia = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de ausência inválido.' });
    }

    const ausencia = await Ausencia.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });

    if (!ausencia) {
      return res.status(404).json({
        erro: 'Ausência não encontrada (ou não te pertence).',
      });
    }

    if (!['pendente', 'pendente_emergencia'].includes(ausencia.estado)) {
      return res.status(403).json({
        erro: `Não podes cancelar um pedido já ${ausencia.estado}.`,
      });
    }

    await Ausencia.deleteOne({ _id: id });

    return res.status(200).json({
      mensagem: 'Pedido cancelado com sucesso.',
      ausencia_id: id,
    });
  } catch (err) {
    console.error('❌ cancelarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/staff/falta-hoje
 *
 * Cria um pedido de falta de emergência para o dia atual (doença súbita).
 * O pedido fica com estado 'pendente_emergencia' — o admin é notificado e,
 * ao aprovar, dispara a redistribuição imediata das tarefas do dia.
 *
 * Body: { justificacao?: string }
 *
 * Resposta 201: { ausencia }
 */
exports.faltaHoje = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!utilizadorId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { justificacao } = req.body || {};

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    // Valida sobreposição: não pode haver outra ausência que cubra hoje.
    // Prompt 130 — SÓ bloqueia se houver ausência com estado 'pendente' ou
    // 'aprovada' (ou 'pendente_emergencia' para faltas súbitas). 'rejeitada' NÃO.
    const sobreposta = await Ausencia.findOne({
      utilizador_id: utilizadorId,
      data_inicio: { $lte: hoje },
      data_fim: { $gte: hoje },
      estado: { $ne: 'rejeitada' },
    });
    if (sobreposta) {
      console.log(`[faltaHoje] Conflito detetado: ausência ${sobreposta._id} estado=${sobreposta.estado}`);
      return res.status(409).json({
        erro: `Já tens uma ausência registada para hoje (estado: ${sobreposta.estado}).`,
      });
    }

    // Prompt 131 — Remove o índice único antigo antes de tentar criar.
    // Garante que o erro 11000 não ocorre mesmo se o arranque do servidor
    // ainda não tiver removido o índice.
    try {
      const indexes = await Ausencia.collection.listIndexes().toArray();
      for (const idx of indexes) {
        if (idx.unique && idx.key && idx.key.utilizador_id) {
          console.log(`[faltaHoje] A remover índice único antigo: ${idx.name}`);
          await Ausencia.collection.dropIndex(idx.name);
        }
      }
    } catch (idxErr) {
      // Não bloqueia se falhar.
    }

    const nova = await Ausencia.create({
      utilizador_id: utilizadorId,
      empresa_id: empresaId,
      data_inicio: hoje,
      data_fim: hoje,
      tipo: 'doenca',
      estado: 'pendente_emergencia',
      justificacao: justificacao ? String(justificacao).trim() : '',
    });

    // Notifica todos os gestores da empresa via push (fire-and-forget).
    // Inclui o admin (role 'admin') como gestor de topo.
    try {
      const staffNome = await Utilizador.findById(utilizadorId)
        .select('nome')
        .lean();
      const nomeStaff = staffNome?.nome ?? 'Funcionário';

      const gestores = await Utilizador.find({
        empresa_id: empresaId,
        role: { $in: ['gestor', 'admin'] },
        ativo: true,
        eliminado_em: null,
        pushSubscription: { $ne: null },
      })
        .select('_id')
        .lean();

      for (const g of gestores) {
        notificarUtilizador(
          String(g._id),
          '🚨 Falta de emergência',
          `${nomeStaff} reportou falta para hoje.`,
          '/gestor/aprovacoes',
          // Prompt 115 — Falta de emergência é "principal" → cria in-app.
          { criarInApp: true, tipo: 'aviso' }
        );
      }
    } catch (e) {
      // Fire-and-forget: não bloqueia a resposta.
      console.error('⚠️  notificar gestores (faltaHoje):', e.message);
    }

    return res.status(201).json({ ausencia: nova });
  } catch (err) {
    console.error('❌ faltaHoje:', err.message);
    // Prompt 131 — Tratamento do erro 11000 (índice único antigo).
    if (err.code === 11000) {
      console.error('[faltaHoje] Erro 11000 (duplicate key). Índice único antigo ainda existe.');
      // Tenta remover o índice e recriar.
      try {
        const indexes = await Ausencia.collection.listIndexes().toArray();
        for (const idx of indexes) {
          if (idx.unique && idx.key && idx.key.utilizador_id) {
            await Ausencia.collection.dropIndex(idx.name);
            console.log(`[faltaHoje] Índice ${idx.name} removido. A tentar novamente...`);
          }
        }
        // Re-tenta criar.
        const nova = await Ausencia.create({
          utilizador_id: req.user.id,
          empresa_id: req.user.empresa_id,
          data_inicio: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())),
          data_fim: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())),
          tipo: 'doenca',
          estado: 'pendente_emergencia',
          justificacao: (req.body && req.body.justificacao) ? String(req.body.justificacao).trim() : '',
        });
        return res.status(201).json({ ausencia: nova });
      } catch (err2) {
        return res.status(409).json({
          erro: 'Já existe uma ausência para hoje. O índice único será removido no próximo arranque.',
        });
      }
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* PATCH /api/staff/tarefas/:id/concluir — concluir tarefa (v1.34.0)  */
/* ------------------------------------------------------------------ */

/**
 * Marca uma tarefa como concluída pelo staff.
 *
 * Validações:
 *   - A tarefa tem de pertencer ao req.user.id (staff só conclui as suas).
 *   - Não pode concluir uma tarefa já concluída ou cancelada.
 *
 * Atualiza:
 *   - estado → 'concluida'
 *   - concluida_em → new Date() (para relatórios)
 *   - hora_conclusao → new Date() (timestamp exato, para auditoria)
 *   - observacoes_staff → texto do body (opcional)
 *
 * Body: { observacoes_staff?: string }
 *
 * Resposta 200: { tarefa: { ... } }
 *   400 — já concluída/cancelada
 *   404 — não encontrada (ou não pertence ao utilizador)
 */
exports.concluirTarefa = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    // Verifica se a tarefa pertence ao utilizador logado.
    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });

    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não te está atribuída).',
      });
    }

    if (tarefa.estado === 'concluida') {
      return res.status(400).json({ erro: 'Tarefa já concluída.' });
    }

    if (tarefa.estado === 'cancelada') {
      return res.status(400).json({ erro: 'Não podes concluir uma tarefa cancelada.' });
    }

    // Atualiza estado + timestamps + observações do staff.
    const agora = new Date();
    tarefa.estado = 'concluida';
    tarefa.concluida_em = agora;
    tarefa.hora_conclusao = agora;

    if (req.body?.observacoes_staff !== undefined) {
      tarefa.observacoes_staff = String(req.body.observacoes_staff || '');
    }
    // Retrocompatibilidade: também aceita "observacoes" (campo legacy).
    if (req.body?.observacoes !== undefined) {
      tarefa.observacoes = String(req.body.observacoes || '');
    }

    await tarefa.save();

    return res.status(200).json({ tarefa });
  } catch (err) {
    console.error('❌ concluirTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/staff/tarefas/:id/avaria — reportar avaria (v1.38.0)     */
/* ------------------------------------------------------------------ */

/**
 * Permite ao staff reportar uma avaria durante a limpeza.
 * Adiciona a descrição ao array `avarias` da tarefa.
 *
 * Body: { descricao: string }
 *
 * Validações:
 *   - A tarefa tem de pertencer ao req.user.id.
 *   - descricao obrigatória (não vazia).
 *   - Não pode reportar avaria em tarefa cancelada.
 *
 * Resposta 200: { tarefa, mensagem }
 */
exports.reportarAvaria = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!utilizadorId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const { descricao } = req.body || {};
    if (!descricao || !String(descricao).trim()) {
      return res.status(400).json({ erro: 'Descrição da avaria é obrigatória.' });
    }

    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });

    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não te está atribuída).',
      });
    }

    if (tarefa.estado === 'cancelada') {
      return res.status(400).json({ erro: 'Não podes reportar avaria numa tarefa cancelada.' });
    }

    // v1.39.0 — Guarda a avaria no array da tarefa original (auditoria).
    if (!Array.isArray(tarefa.avarias)) {
      tarefa.avarias = [];
    }
    tarefa.avarias.push(String(descricao).trim());
    await tarefa.save();

    // Cria uma NOVA tarefa de manutenção para a mesma propriedade,
    // para o gestor atribuir a alguém (ex: reparador).
    // Prompt 125 — usa meia-noite LOCAL (00:00 no fuso do servidor) e não
    // UTC midnight, que em Lisboa (UTC+1) apareceria como 01:00.
    const hoje = new Date();
    const hojeMeiaNoite = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());

    const novaTarefaManutencao = await Tarefa.create({
      empresa_id: tarefa.empresa_id,
      propriedade_id: tarefa.propriedade_id,
      utilizador_id: null, // por atribuir — o gestor decide
      data: hojeMeiaNoite,
      tempo_limpeza_minutos: 60, // estimativa padrão para manutenção
      tipo: 'manutencao',
      estado: 'por_atribuir',
      observacoes: `Avaria reportada por staff: ${String(descricao).trim()}`,
    });

    console.log(
      `🔧 Avaria reportada na tarefa ${tarefa._id} → nova tarefa de manutenção ${novaTarefaManutencao._id} criada.`
    );

    // v1.65.0 (Prompt 88) — Notifica os gestores da empresa sobre a nova avaria.
    // A tarefa de manutenção fica 'por_atribuir' — o gestor decide quem resolve.
    try {
      const [propInfo, gestores] = await Promise.all([
        Propriedade.findById(tarefa.propriedade_id).select('nome').lean(),
        Utilizador.find({
          empresa_id: tarefa.empresa_id,
          role: 'gestor',
          ativo: true,
          eliminado_em: null,
        })
          .select('_id nome')
          .lean(),
      ]);

      const propNome = propInfo?.nome ?? 'Propriedade';
      const descricaoCurta = String(descricao).trim().slice(0, 80);

      // Dispara notificação a cada gestor ativo da empresa (fire-and-forget).
      for (const g of gestores) {
        try {
          notificarUtilizador(
            String(g._id),
            '🛠️ Nova Avaria Reportada',
            `${propNome}: ${descricaoCurta}`,
            '/gestor/tarefas',
            // Prompt 115 — Avaria reportada é "principal" → cria in-app.
            { criarInApp: true, tipo: 'aviso' }
          );
        } catch (e) {
          // Fire-and-forget por gestor: não bloqueia os outros.
        }
      }
    } catch (e) {
      // Fire-and-forget: a avaria já foi registada, a notificação é best-effort.
      console.error('⚠️  notificar gestores (avaria):', e.message);
    }

    return res.status(200).json({
      tarefa,
      mensagem: 'Avaria reportada com sucesso. Foi criada uma tarefa de manutenção.',
      tarefa_manutencao: novaTarefaManutencao,
    });
  } catch (err) {
    console.error('❌ reportarAvaria:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/staff/tarefas/:id/atraso — reportar atraso (v1.55.0)     */
/* ------------------------------------------------------------------ */

/**
 * Reporta um atraso numa tarefa atribuída ao próprio staff.
 *
 * Validações (Prompt 77):
 *   - A tarefa tem de pertencer ao req.user.id (staff só nas suas).
 *   - minutos_atraso tem de ser número positivo.
 *   - Não pode reportar atraso em tarefa concluída/cancelada.
 *
 * Lógica (espelhada do tarefaController.reportarAtrasoTarefa, mas scoped
 * ao utilizador e sem necessidade de isGestor):
 *   - Soma minutos_atraso ao tempo_limpeza_minutos da tarefa.
 *   - Recalcula a carga total do dia (tarefas não concluídas/canceladas).
 *   - Se a carga exceder CAPACIDADE_ATRASO_MINUTOS (420 min = 7h), a
 *     ÚLTIMA tarefa do dia desse utilizador é desatribuída (null +
 *     por_atribuir) para não comprometer as limpezas seguintes.
 *
 * Body: { minutos_atraso: number }
 *
 * Resposta 200: { tarefa, carga_total, cascata_desatribuida, tarefa_desatribuida_id }
 */
const CAPACIDADE_ATRASO_MINUTOS = 420; // 7h — mais conservador que o SLA (480)

exports.reportarAtraso = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!utilizadorId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const { minutos_atraso } = req.body || {};
    const minutos = Number(minutos_atraso);
    if (!Number.isFinite(minutos) || minutos <= 0) {
      return res.status(400).json({
        erro: 'minutos_atraso deve ser um número positivo.',
      });
    }

    // --- Validação de pertença (Prompt 77, ponto 3) ---
    // A tarefa tem de pertencer ao req.user.id.findOne com utilizador_id
    // garante que staff só mexe nas suas tarefas (404 se não for dele).
    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });
    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não te está atribuída).',
      });
    }

    if (tarefa.estado === 'concluida' || tarefa.estado === 'cancelada') {
      return res.status(400).json({
        erro: `Não podes reportar atraso numa tarefa ${tarefa.estado}.`,
      });
    }

    // Soma o atraso ao tempo de limpeza.
    tarefa.tempo_limpeza_minutos += minutos;
    await tarefa.save();

    // Calcula a carga total do dia do utilizador.
    const d = new Date(tarefa.data);
    const inicioDia = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

    const tarefasDoDia = await Tarefa.find({
      utilizador_id: utilizadorId,
      data: { $gte: inicioDia, $lt: fimDia },
      estado: { $nin: ['cancelada', 'concluida'] },
    }).lean();

    const cargaTotal = tarefasDoDia.reduce(
      (acc, t) => acc + t.tempo_limpeza_minutos,
      0
    );

    // Se exceder a capacidade, desatribui a última tarefa do dia.
    let cascataDesatribuida = false;
    let tarefaDesatribuidaId = null;

    if (cargaTotal > CAPACIDADE_ATRASO_MINUTOS) {
      const ultimaTarefa = await Tarefa.findOne({
        utilizador_id: utilizadorId,
        data: { $gte: inicioDia, $lt: fimDia },
        estado: { $nin: ['cancelada', 'concluida'] },
        _id: { $ne: tarefa._id },
      }).sort({ createdAt: -1 });

      if (ultimaTarefa) {
        ultimaTarefa.utilizador_id = null;
        ultimaTarefa.estado = 'por_atribuir';
        await ultimaTarefa.save();
        cascataDesatribuida = true;
        tarefaDesatribuidaId = String(ultimaTarefa._id);
      }
    }

    const tarefaResp = tarefa.toObject();
    delete tarefaResp.__v;

    return res.status(200).json({
      tarefa: tarefaResp,
      carga_total: cargaTotal,
      cascata_desatribuida: cascataDesatribuida,
      tarefa_desatribuida_id: tarefaDesatribuidaId,
    });
  } catch (err) {
    console.error('❌ reportarAtraso (staff):', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* PATCH /api/staff/tarefas/:id/checklist/:seccaoIndex/item/:itemIndex */
/* Prompt 133 — Toggle item da checklist dinâmica                      */
/* ------------------------------------------------------------------ */

/**
 * Marca/desmarca um item específico da checklist_dinamica de uma tarefa.
 * O staff só pode alterar as SUAS tarefas. Se a tarefa estiver concluída,
 * não permite alterar (checklist bloqueada).
 *
 * Body: { concluido: boolean } (opcional — se não vier, alterna)
 *
 * Resposta 200: { tarefa, item }
 */
exports.toggleChecklistItem = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { id, seccaoIndex, itemIndex } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const secIdx = parseInt(seccaoIndex, 10);
    const itemIdx = parseInt(itemIndex, 10);

    if (Number.isNaN(secIdx) || Number.isNaN(itemIdx) || secIdx < 0 || itemIdx < 0) {
      return res.status(400).json({ erro: 'Índices inválidos.' });
    }

    // Busca a tarefa — só do próprio utilizador.
    const tarefa = await Tarefa.findOne({
      _id: id,
      utilizador_id: utilizadorId,
    });

    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    if (tarefa.estado === 'concluida') {
      return res.status(400).json({ erro: 'Não podes alterar a checklist de uma tarefa concluída.' });
    }

    // Valida índices.
    if (!tarefa.checklist_dinamica || !tarefa.checklist_dinamica[secIdx]) {
      return res.status(400).json({ erro: 'Secção não encontrada na checklist.' });
    }

    const sec = tarefa.checklist_dinamica[secIdx];
    if (!sec.items || !sec.items[itemIdx]) {
      return res.status(400).json({ erro: 'Item não encontrado na checklist.' });
    }

    // Toggle (ou usa o valor do body).
    const novoValor = typeof req.body?.concluido === 'boolean'
      ? req.body.concluido
      : !sec.items[itemIdx].concluido;

    // Atualiza diretamente no array (positional operator).
    tarefa.checklist_dinamica[secIdx].items[itemIdx].concluido = novoValor;
    await tarefa.save();

    console.log(
      `[toggleChecklistItem] Tarefa ${tarefa._id} secção ${secIdx} item ${itemIdx} → ${novoValor}`
    );

    return res.status(200).json({
      tarefa,
      item: {
        seccao: sec.nome,
        texto: sec.items[itemIdx].texto,
        concluido: novoValor,
      },
    });
  } catch (err) {
    console.error('❌ toggleChecklistItem:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
