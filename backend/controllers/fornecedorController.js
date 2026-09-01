/**
 * Fornecedor Controller — Portal da Lavandaria (FIX: portal lavandaria).
 *
 * O fornecedor (lavandaria) vê as tarefas dos próximos 7 dias de TODAS as
 * propriedades da sua empresa, e marca `roupa_entregue = true` quando entrega
 * roupa limpa numa propriedade.
 *
 * Segurança: o filtro é estritamente por `empresa_id = req.user.empresa_id`.
 * O fornecedor não vê tarefas de outras empresas (multi-tenant isolation).
 */

const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');

/* ------------------------------------------------------------------ */
/* GET /api/fornecedor/tarefas — Lista tarefas dos próximos 7 dias     */
/* ------------------------------------------------------------------ */
exports.listarTarefas = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    // FIX (portal lavandaria) — Tarefas dos próximos 7 dias (hoje + 7).
    // Inclui tarefas não canceladas (por_atribuir, atribuida, em_curso, concluida).
    const inicio = new Date();
    inicio.setUTCHours(0, 0, 0, 0); // meia-noite UTC de hoje
    const fim = new Date(inicio);
    fim.setUTCDate(fim.getUTCDate() + 7);

    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      data: { $gte: inicio, $lt: fim },
      estado: { $ne: 'cancelada' },
    })
      .populate({
        path: 'propriedade_id',
        select: 'nome morada capacidade_hospedes',
      })
      .select(
        'data estado tipo hospedes roupa_entregue sacos_roupa_suja propriedade_id tempo_limpeza_minutos'
      )
      .sort({ data: 1 })
      .lean();

    return res.status(200).json({ tarefas });
  } catch (err) {
    console.error('❌ fornecedor.listarTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* PATCH /api/fornecedor/tarefas/:id/roupa — Marca roupa_entregue     */
/* ------------------------------------------------------------------ */
exports.marcarRoupaEntregue = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    // FIX (segurança multi-tenant) — Filtra estritamente por empresa_id.
    const tarefa = await Tarefa.findOne({
      _id: id,
      empresa_id: empresaId,
    });

    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não pertence à tua empresa).',
      });
    }

    // Toggle: se vier `roupa_entregue` no body, usa-o; senão faz toggle.
    const valor =
      typeof req.body?.roupa_entregue === 'boolean'
        ? req.body.roupa_entregue
        : !tarefa.roupa_entregue;

    tarefa.roupa_entregue = valor;
    await tarefa.save();

    return res.status(200).json({
      mensagem: valor
        ? 'Roupa marcada como entregue.'
        : 'Roupa marcada como pendente.',
      tarefa: {
        _id: tarefa._id,
        roupa_entregue: tarefa.roupa_entregue,
      },
    });
  } catch (err) {
    console.error('❌ fornecedor.marcarRoupaEntregue:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
