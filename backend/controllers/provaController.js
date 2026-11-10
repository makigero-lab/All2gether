/**
 * Prova da limpeza e avarias (All2gether)
 *
 *   GET   /api/gestor/tarefas/:id/prova                        — fotos, hora, checklist, avarias
 *   PATCH /api/gestor/tarefas/:id/avarias/:avariaId/resolver   — «Resolvida» (à mão)
 *   GET   /api/parceiro/reservas/:id/limpeza                   — o que o parceiro pode ver
 *
 * As listas (calendário, tarefas) já NÃO trazem fotos: carregam-se aqui, só ao abrir.
 * A retenção de 30 dias (fotos de conclusão) mantém-se (jobs/limpezaFotos.js esvazia as fotos).
 * O parceiro NUNCA vê avarias, observações do staff nem a checklist.
 */
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');
const { obterEmpresaId } = require('./gestorController');

/** Itens feitos / total da checklist dinâmica. `total` 0 = a tarefa não tem checklist dinâmica. */
function contarChecklist(t) {
  let feitos = 0;
  let total = 0;
  for (const sec of t.checklist_dinamica || []) {
    for (const it of sec.items || []) {
      total++;
      if (it.concluido) feitos++;
    }
  }
  return { feitos, total };
}

const horaConclusaoDe = (t) => t.hora_conclusao || t.concluida_em || null;

exports.contarChecklist = contarChecklist;

exports.getProvaLimpeza = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID de tarefa inválido.' });

    const t = await Tarefa.findOne({ _id: id, empresa_id: empresaId })
      .select('estado tipo hora_conclusao concluida_em iniciada_em inicio_origem fotos_conclusao checklist_dinamica observacoes_staff avarias nao_consegui_comecar')
      .lean();
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada.' });

    const fotos = Array.isArray(t.fotos_conclusao) ? t.fotos_conclusao : [];
    return res.status(200).json({
      tarefa_id: String(t._id),
      estado: t.estado,
      hora_conclusao: horaConclusaoDe(t),
      iniciada_em: t.iniciada_em || null,
      inicio_origem: t.inicio_origem || null,
      fotos,
      // Concluída sem fotos = já passou a retenção das fotos.
      fotos_expiradas: t.estado === 'concluida' && fotos.length === 0,
      checklist: contarChecklist(t),
      observacoes_staff: t.observacoes_staff || '',
      nao_consegui_comecar: t.nao_consegui_comecar || null,
      avarias: (t.avarias || []).map((a) => ({
        _id: a._id ? String(a._id) : null,
        descricao: a.descricao,
        fotos: a.fotos || [],
        resolvido: !!a.resolvido,
        data_registo: a.data_registo || null,
        data_resolucao: a.data_resolucao || null,
      })),
    });
  } catch (err) {
    console.error('❌ getProvaLimpeza:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/** Body opcional: { resolvido: boolean } (por omissão true; false reabre). */
exports.resolverAvaria = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;
    const { id, avariaId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(avariaId)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const valor = req.body && typeof req.body.resolvido === 'boolean' ? req.body.resolvido : true;
    // Resolver grava a data (só se ainda estava aberta: repetir não a renova); reabrir limpa-a.
    const filtroItem = { 'a._id': new mongoose.Types.ObjectId(avariaId), ...(valor ? { 'a.resolvido': { $ne: true } } : {}) };
    const r = await Tarefa.findOneAndUpdate(
      { _id: id, empresa_id: empresaId, 'avarias._id': avariaId },
      { $set: { 'avarias.$[a].resolvido': valor, 'avarias.$[a].data_resolucao': valor ? new Date() : null } },
      { arrayFilters: [filtroItem], new: true }
    ).select('avarias').lean();
    if (!r) return res.status(404).json({ erro: 'Avaria não encontrada.' });
    return res.status(200).json({
      avarias: (r.avarias || []).map((a) => ({ _id: String(a._id), descricao: a.descricao, resolvido: !!a.resolvido, data_registo: a.data_registo || null, data_resolucao: a.data_resolucao || null })),
    });
  } catch (err) {
    console.error('❌ resolverAvaria:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/** Parceiro: só a hora de conclusão e as fotos (enquanto existirem). */
exports.getLimpezaDoParceiro = async (req, res) => {
  try {
    const parceiroId = req.user && req.user.id;
    if (!parceiroId) return res.status(401).json({ erro: 'Não autenticado.' });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID inválido.' });

    const reserva = await ReservaManual.findOne({ _id: id, parceiro_id: parceiroId })
      .populate('propriedade_id', 'nome')
      .select('propriedade_id tarefa_gerada_id check_out')
      .lean();
    if (!reserva) return res.status(404).json({ erro: 'Reserva não encontrada.' });
    if (!reserva.tarefa_gerada_id) return res.status(404).json({ erro: 'Esta reserva ainda não tem limpeza.' });

    const t = await Tarefa.findById(reserva.tarefa_gerada_id)
      .select('estado data hora_conclusao concluida_em fotos_conclusao tipo_limpeza')
      .lean();
    if (!t) return res.status(404).json({ erro: 'Limpeza não encontrada.' });

    const concluida = t.estado === 'concluida';
    const fotos = concluida && Array.isArray(t.fotos_conclusao) ? t.fotos_conclusao : [];
    return res.status(200).json({
      casa: reserva.propriedade_id ? reserva.propriedade_id.nome : null,
      data: t.data,
      tipo_limpeza: t.tipo_limpeza || 'normal',
      estado: t.estado,
      hora_conclusao: concluida ? horaConclusaoDe(t) : null,
      fotos,
      fotos_expiradas: concluida && fotos.length === 0,
    });
  } catch (err) {
    console.error('❌ getLimpezaDoParceiro:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
