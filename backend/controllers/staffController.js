/**
 * Staff Controller — All2gether
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
const { notificarUtilizador, avisarGestores } = require('../utils/notificar');
const { preencherVagaTarefa, preencherVagasAposAusencia } = require('../utils/atribuicaoAutomatica');
const { comMembro, retirarMembroDoc } = require('../utils/equipaTarefa');
const { aoConcluirTarefa } = require('../utils/cicloTarefa');

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
    if (!['ferias', 'doenca', 'falta', 'outro'].includes(tipoFinal)) {
      return res.status(400).json({
        erro: 'tipo inválido. Valores permitidos: ferias, doenca, falta, outro.',
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

    // Se bloqueava a pessoa, preenche já as vagas do período (best-effort).
    let preenchimento = null;
    if (['aprovada', 'pendente_emergencia'].includes(estadoAnterior)) {
      preenchimento = await preencherVagasAposAusencia(ausencia);
    }

    return res.status(200).json({
      mensagem: 'Ausência cancelada com sucesso.',
      ausencia,
      preenchimento,
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

    // 'pendente_emergencia' bloqueava a pessoa: preenche já as vagas (best-effort, depois de apagar).
    let preenchimento = null;
    if (ausencia.estado === 'pendente_emergencia') {
      preenchimento = await preencherVagasAposAusencia(ausencia);
    }

    return res.status(200).json({
      mensagem: 'Pedido cancelado com sucesso.',
      ausencia_id: id,
      preenchimento,
    });
  } catch (err) {
    console.error('❌ cancelarAusencia:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/staff/falta-hoje
 *
 * Cria um pedido de falta de emergência para o dia atual (tipo 'falta', sem presumir o motivo).
 * O pedido fica com estado 'pendente_emergencia' — o admin é notificado. As
 * tarefas de hoje da pessoa são desatribuídas e reatribuídas logo (sem esperar
 * pela aprovação); sem ninguém disponível ficam por atribuir e os gestores
 * são avisados.
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
      estado: { $in: ['pendente', 'pendente_emergencia', 'aprovada'] },
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
      tipo: 'falta', // uma falta não é uma doença: não se infere saúde (RGPD)
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

    // O faltoso fica logo indisponível: desatribui as tarefas de hoje e
    // reatribui-as de imediato a quem estiver disponível (sem clique do
    // gestor). A ausência 'pendente_emergencia' já conta como indisponível no
    // load balancer, e a pessoa é excluída do pool explicitamente.
    // Limpezas 'em_curso' ficam com a pessoa e os gestores são avisados.
    let redistribuicao = null;
    try {
      const { desatribuirTarefasPeriodo, textoEmCurso, avisarGestoresEmCurso, reatribuirAutomaticamente } = require('./ausenciaController');
      redistribuicao = await desatribuirTarefasPeriodo(utilizadorId, hoje, hoje);
      if (redistribuicao.em_curso_mantidas > 0) {
        const alvo = await Utilizador.findById(utilizadorId).select('nome').lean();
        await avisarGestoresEmCurso(empresaId, alvo?.nome, redistribuicao);
        redistribuicao.aviso = textoEmCurso(redistribuicao, alvo?.nome);
      }
      // Best-effort: nunca lança; se falhar, `reatribuicao.erro` vem preenchido.
      redistribuicao.reatribuicao = await reatribuirAutomaticamente(empresaId, utilizadorId, hoje, hoje);
    } catch (e) {
      console.error('⚠️  redistribuir tarefas (faltaHoje):', e.message);
    }

    return res.status(201).json({ ausencia: nova, redistribuicao });
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
          tipo: 'falta',
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
    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));

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

    // HF19 — Fotos obrigatórias na conclusão.
    // O staff tem de enviar pelo menos 1 foto (máx. 5) no req.body.fotos_conclusao.
    const fotosConclusao = req.body?.fotos_conclusao;
    if (!Array.isArray(fotosConclusao) || fotosConclusao.length === 0) {
      return res.status(400).json({
        erro: 'É obrigatório anexar pelo menos 1 foto para concluir a tarefa.',
      });
    }
    // Limita a 5 fotos.
    const fotosNormalizadas = fotosConclusao
      .filter((f) => typeof f === 'string' && f.trim())
      .slice(0, 5);

    if (fotosNormalizadas.length === 0) {
      return res.status(400).json({
        erro: 'É obrigatório anexar pelo menos 1 foto válida para concluir a tarefa.',
      });
    }

    // Atualiza estado + timestamps + observações do staff + fotos.
    // Atómico: com dois membros a concluir ao mesmo tempo só o primeiro grava;
    // o segundo recebe 400 "já concluída" (e não 500 por VersionError).
    const agora = new Date();
    const set = {
      estado: 'concluida',
      concluida_em: agora,
      hora_conclusao: agora,
      data_conclusao: agora, // HF19 — para o cron job de limpeza
      fotos_conclusao: fotosNormalizadas, // HF19 — fotos da conclusão
    };

    if (req.body?.observacoes_staff !== undefined) {
      set.observacoes_staff = String(req.body.observacoes_staff || '');
    }
    // Retrocompatibilidade: também aceita "observacoes" (campo legacy).
    if (req.body?.observacoes !== undefined) {
      set.observacoes = String(req.body.observacoes || '');
    }
    // FIX (portal lavandaria) — Sacos de roupa suja recolhidos pelo staff.
    if (req.body?.sacos_roupa_suja !== undefined) {
      const n = Number(req.body.sacos_roupa_suja);
      set.sacos_roupa_suja = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }

    const atualizada = await Tarefa.findOneAndUpdate(
      comMembro({ _id: id, estado: { $nin: ['concluida', 'cancelada'] } }, utilizadorId),
      { $set: set },
      { new: true }
    );
    if (!atualizada) {
      return res.status(400).json({ erro: 'Tarefa já concluída (ou entretanto cancelada).' });
    }

    // Avaria resolvida (manutenção) e aviso ao parceiro; best-effort, nunca falha a conclusão.
    await aoConcluirTarefa(atualizada);

    return res.status(200).json({ tarefa: atualizada });
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

    const { descricao, fotos } = req.body || {};
    if (!descricao || !String(descricao).trim()) {
      return res.status(400).json({ erro: 'Descrição da avaria é obrigatória.' });
    }

    // HF13 — fotos é opcional (array de strings: URLs ou base64).
    // Limita a 5 fotos por avaria para evitar payloads excessivos.
    let fotosNormalizadas = [];
    if (fotos !== undefined && fotos !== null) {
      if (!Array.isArray(fotos)) {
        return res.status(400).json({ erro: 'fotos deve ser um array de strings (URLs ou base64).' });
      }
      fotosNormalizadas = fotos
        .filter((f) => typeof f === 'string' && f.trim())
        .slice(0, 5)
        .map((f) => f.trim());
    }

    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));

    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não te está atribuída).',
      });
    }

    if (tarefa.estado === 'cancelada') {
      return res.status(400).json({ erro: 'Não podes reportar avaria numa tarefa cancelada.' });
    }

    // HF13 — Guarda a avaria no array da tarefa original (auditoria).
    // Schema enriquecido: { descricao, fotos, resolvido, data_registo }.
    if (!Array.isArray(tarefa.avarias)) {
      tarefa.avarias = [];
    }
    tarefa.avarias.push({
      descricao: String(descricao).trim(),
      fotos: fotosNormalizadas,
      resolvido: false,
      data_registo: new Date(),
    });
    await tarefa.save();
    // Item acabado de registar (liga a manutenção a esta avaria).
    const itemAvaria = tarefa.avarias[tarefa.avarias.length - 1];

    // Cria uma NOVA tarefa de manutenção para a mesma propriedade,
    // para o gestor atribuir a alguém (ex: reparador).
    // Prompt 125 — usa meia-noite LOCAL (00:00 no fuso do servidor) e não
    // UTC midnight, que em Lisboa (UTC+1) apareceria como 01:00.
    const hoje = new Date();
    // 10:00 UTC do dia (antes 00:00 local: placeholder que contaminava o scheduler).
    const hojeMeiaNoite = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 10));

    const novaTarefaManutencao = await Tarefa.create({
      empresa_id: tarefa.empresa_id,
      propriedade_id: tarefa.propriedade_id,
      utilizador_id: null, // por atribuir — o gestor decide
      data: hojeMeiaNoite,
      tempo_limpeza_minutos: 60, // estimativa padrão para manutenção
      tipo: 'manutencao',
      estado: 'por_atribuir',
      observacoes: `Avaria reportada por staff: ${String(descricao).trim()}`,
      // Ciclo fechado: ao concluir esta manutenção, a avaria fica resolvida.
      avaria_origem_id: tarefa._id,
      avaria_origem_item_id: itemAvaria && itemAvaria._id ? itemAvaria._id : null,
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
    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));
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

    const tarefasDoDia = await Tarefa.find(comMembro({
      data: { $gte: inicioDia, $lt: fimDia },
      estado: { $nin: ['cancelada', 'concluida'] },
    }, utilizadorId)).lean();

    const cargaTotal = tarefasDoDia.reduce(
      (acc, t) => acc + t.tempo_limpeza_minutos,
      0
    );

    // Se exceder a capacidade, desatribui a última tarefa do dia.
    let cascataDesatribuida = false;
    let tarefaDesatribuidaId = null;

    if (cargaTotal > CAPACIDADE_ATRASO_MINUTOS) {
      // Só 'atribuida' (nunca 'em_curso') e só sai quem atrasou: os restantes
      // membros da equipa ficam na tarefa.
      const ultimaTarefa = await Tarefa.findOne(comMembro({
        data: { $gte: inicioDia, $lt: fimDia },
        estado: 'atribuida',
        _id: { $ne: tarefa._id },
      }, utilizadorId)).sort({ createdAt: -1 });

      if (ultimaTarefa) {
        const ficouSemEquipa = retirarMembroDoc(ultimaTarefa, utilizadorId);
        await ultimaTarefa.save();
        cascataDesatribuida = true;
        tarefaDesatribuidaId = String(ultimaTarefa._id);

        // Avisa o gestor e (se a equipa não ficou vazia) procura substituto só para a vaga.
        try {
          const prop = await Propriedade.findById(ultimaTarefa.propriedade_id)
            .select('nome coordenadas staff_necessario')
            .lean();
          const nomeProp = prop?.nome ?? 'uma propriedade';
          let texto;
          if (ficouSemEquipa) {
            texto = `${req.user.nome || 'Um membro da equipa'} reportou atraso e saiu da limpeza de ${nomeProp}, que ficou por atribuir.`;
          } else {
            const v = prop
              ? await preencherVagaTarefa({ empresaId, tarefa: ultimaTarefa.toObject(), propriedade: prop, excluirExtra: [String(utilizadorId)] })
              : { novos: [], faltam: 1 };
            for (const id of v.novos) {
              notificarUtilizador(String(id), '🧹 Nova Limpeza Atribuída', `Foste escalado para ${nomeProp}.`, '/staff');
            }
            texto = v.novos.length > 0 && v.faltam === 0
              ? `Um membro reportou atraso e saiu da limpeza de ${nomeProp}; já foi substituído automaticamente.`
              : `Um membro reportou atraso e saiu da limpeza de ${nomeProp}; sem substituto disponível, falta ${v.faltam} ${v.faltam === 1 ? 'pessoa' : 'pessoas'}.`;
          }
          await avisarGestores(empresaId, '⚠️ Equipa incompleta por atraso', texto, '/gestor/tarefas');
        } catch (errAviso) {
          console.error('⚠️  reportarAtraso: aviso/substituto:', errAviso.message);
        }
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
    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));

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
    // Primeiro item marcado: prova de que o trabalho começou (relatório de tempo real).
    if (novoValor && !tarefa.primeiro_item_checklist_em) tarefa.primeiro_item_checklist_em = new Date();
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
