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
    const sobreposta = await Ausencia.findOne({
      utilizador_id: utilizadorId,
      data_inicio: { $lte: fim },
      data_fim: { $gte: inicio },
    });
    if (sobreposta) {
      return res.status(409).json({
        erro: 'Já existe uma ausência registada que se sobrepõe a este período.',
      });
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
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Já existe uma ausência com este data_inicio para este utilizador.',
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* DELETE /api/staff/ausencias/:id — cancelar pedido pendente         */
/* ------------------------------------------------------------------ */

/**
 * Cancela (elimina) um pedido de ausência do próprio utilizador.
 *
 * Regras:
 *   - Só pode cancelar PEDIDOS PENDENTES (aprovações/rejeições são finais).
 *   - Só pode cancelar as SUAS ausências (valida utilizador_id).
 *
 * Resposta 200: { mensagem, ausencia_id }
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
    const sobreposta = await Ausencia.findOne({
      utilizador_id: utilizadorId,
      data_inicio: { $lte: hoje },
      data_fim: { $gte: hoje },
    });
    if (sobreposta) {
      return res.status(409).json({
        erro: `Já tens uma ausência registada para hoje (estado: ${sobreposta.estado}).`,
      });
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

    return res.status(201).json({ ausencia: nova });
  } catch (err) {
    console.error('❌ faltaHoje:', err.message);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
