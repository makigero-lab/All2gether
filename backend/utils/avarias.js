/**
 * Avarias — ciclo fechado (All2gether)
 *
 * Uma avaria é um item de `tarefa.avarias` (limpeza onde foi reportada). Ao reportá-la cria-se
 * uma tarefa de manutenção com `avaria_origem_id` (limpeza) e `avaria_origem_item_id` (item).
 * Quando a manutenção é concluída, a avaria fica resolvida; o gestor também a pode resolver à mão.
 */
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');

/** Resolve a avaria ligada a uma manutenção concluída. Idempotente. */
async function resolverAvariaDaManutencao(tarefa) {
  try {
    if (!tarefa || tarefa.tipo !== 'manutencao' || !tarefa.avaria_origem_id || !tarefa.avaria_origem_item_id) return false;
    const r = await Tarefa.updateOne(
      { _id: tarefa.avaria_origem_id, avarias: { $elemMatch: { _id: tarefa.avaria_origem_item_id, resolvido: false } } },
      { $set: { 'avarias.$[a].resolvido': true, 'avarias.$[a].data_resolucao': new Date() } },
      { arrayFilters: [{ 'a._id': tarefa.avaria_origem_item_id }] }
    );
    return r.modifiedCount > 0;
  } catch (e) {
    console.error('⚠️  resolverAvariaDaManutencao:', e.message);
    return false;
  }
}

/** Número de avarias por resolver da empresa (itens, não tarefas). */
async function contarAvariasAbertas(empresaId) {
  const r = await Tarefa.aggregate([
    { $match: { empresa_id: new mongoose.Types.ObjectId(String(empresaId)), 'avarias.resolvido': false, estado: { $ne: 'cancelada' } } },
    { $unwind: '$avarias' },
    { $match: { 'avarias.resolvido': false } },
    { $count: 'n' },
  ]);
  return r[0] ? r[0].n : 0;
}

/** Avarias por resolver numa casa (de outras limpezas), mais recentes primeiro. */
async function avariasAbertasDaCasa(propriedadeId, excluirTarefaId = null) {
  const filtro = { propriedade_id: propriedadeId, 'avarias.resolvido': false, estado: { $ne: 'cancelada' } };
  if (excluirTarefaId) filtro._id = { $ne: excluirTarefaId };
  const tarefas = await Tarefa.find(filtro).select('avarias data').sort({ data: -1 }).limit(20).lean();
  const out = [];
  for (const t of tarefas) {
    for (const a of t.avarias || []) {
      if (a && a.resolvido === false) out.push({ descricao: a.descricao, data_registo: a.data_registo || t.data });
    }
  }
  return out.slice(0, 10);
}

module.exports = { resolverAvariaDaManutencao, contarAvariasAbertas, avariasAbertasDaCasa };
