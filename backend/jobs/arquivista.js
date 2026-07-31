/**
 * Arquivista — Cron Job (FisioCell)
 *
 * Prompt 109 — O Arquivista Automático.
 *
 * Corre no dia 1 de cada trimestre (cron: 0 0 1 1,4,7,10 *) à meia-noite.
 *
 * Ação:
 *   1. Procura todas as Tarefas com estado 'concluida' ou 'cancelada'
 *      cuja data seja anterior a 3 meses.
 *   2. Copia essas tarefas para a coleção TarefaArquivo (mantém todos
 *      os dados para auditoria futura).
 *   3. Apaga as tarefas da coleção principal Tarefa (para garantir a
 *      performance do calendário e das queries operacionais).
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');

async function executarArquivista() {
  console.log('📦 [Arquivista] A iniciar às', new Date().toISOString());

  try {
    // 1) Calcula a data limite (3 meses atrás).
    const agora = new Date();
    const limite = new Date(agora);
    limite.setMonth(limite.getMonth() - 3);

    // 2) Procura tarefas concluídas/canceladas com mais de 3 meses.
    const tarefas = await Tarefa.find({
      estado: { $in: ['concluida', 'cancelada'] },
      data: { $lt: limite },
    }).lean();

    if (tarefas.length === 0) {
      console.log('ℹ️  [Arquivista] Sem tarefas para arquivar.');
      return { arquivadas: 0 };
    }

    console.log(`📦 [Arquivista] ${tarefas.length} tarefa(s) para arquivar (anteriores a ${limite.toISOString().slice(0, 10)}).`);

    // 3) Copia para TarefaArquivo (adicionando arquivado_em).
    const docsArquivo = tarefas.map((t) => ({
      ...t,
      arquivado_em: new Date(),
      _id: undefined, // deixa o MongoDB gerar um novo _id no arquivo
      // Mantém o _id original como referência (campo extra).
      tarefa_original_id: t._id,
    }));

    await TarefaArquivo.insertMany(docsArquivo);

    // 4) Apaga da coleção principal.
    const ids = tarefas.map((t) => t._id);
    const resultado = await Tarefa.deleteMany({ _id: { $in: ids } });

    console.log(
      `✅ [Arquivista] ${resultado.deletedCount} tarefa(s) arquivada(s) e removida(s) da coleção principal.`
    );

    return { arquivadas: resultado.deletedCount };
  } catch (err) {
    console.error('❌ [Arquivista] Erro:', err.message);
    return { arquivadas: 0, erro: err.message };
  }
}

function iniciarArquivista() {
  console.log(
    '⏰ [Arquivista] Cron agendado para dia 1 de cada trimestre (0 0 1 */3 *).'
  );

  cron.schedule(
    '0 0 1 */3 *',
    async () => {
      await executarArquivista();
    },
    { timezone: 'Europe/Lisbon' }
  );

  return { executarArquivista };
}

module.exports = { iniciarArquivista, executarArquivista };
