/**
 * Limpeza de Fotos — Cron Job (All2gether) — HF19
 *
 * Corre todos os dias às 03:00 (madrugada) e procura tarefas concluídas
 * cuja data_conclusao seja mais antiga do que 7 dias. Para essas tarefas,
 * esvazia os arrays de fotos (fotos_conclusao e avarias[*].fotos) para
 * otimizar o armazenamento (as fotos em base64 são volumosas).
 *
 * As descrições das avarias e outros dados são mantidos — só as fotos
 * (strings base64/URLs) são removidas.
 *
 * Log: informa quantas tarefas foram limpas e quantas fotos removidas.
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');

const DIAS_RETENCAO = 7;

/**
 * Executa a limpeza de fotos de tarefas concluídas há mais de 7 dias.
 *
 * @returns {Promise<{ tarefasLimpas: number, fotosRemovidas: number }>}
 */
async function executarLimpezaFotos() {
  const agora = new Date();
  const dataLimite = new Date(agora.getTime() - DIAS_RETENCAO * 24 * 60 * 60 * 1000);

  console.log(
    `🧹 [LimpezaFotos] a procurar tarefas concluídas antes de ${dataLimite.toISOString()}...`
  );

  // Procura tarefas concluídas com data_conclusao anterior ao limite E que
  // ainda têm fotos (fotos_conclusao não vazio OU avarias com fotos).
  const tarefas = await Tarefa.find({
    estado: 'concluida',
    data_conclusao: { $lt: dataLimite },
    $or: [
      { 'fotos_conclusao.0': { $exists: true } },
      { 'avarias.fotos.0': { $exists: true } },
    ],
  }).lean();

  if (tarefas.length === 0) {
    console.log('ℹ️  [LimpezaFotos] nenhuma tarefa com fotos antigas para limpar.');
    return { tarefasLimpas: 0, fotosRemovidas: 0 };
  }

  let fotosRemovidas = 0;
  const idsParaAtualizar = [];

  for (const tarefa of tarefas) {
    // Conta fotos_conclusao.
    const fotosConclusaoCount = Array.isArray(tarefa.fotos_conclusao)
      ? tarefa.fotos_conclusao.length
      : 0;
    fotosRemovidas += fotosConclusaoCount;

    // Conta fotos das avarias.
    let fotosAvariasCount = 0;
    if (Array.isArray(tarefa.avarias)) {
      for (const avaria of tarefa.avarias) {
        if (Array.isArray(avaria.fotos)) {
          fotosAvariasCount += avaria.fotos.length;
        }
      }
    }
    fotosRemovidas += fotosAvariasCount;

    idsParaAtualizar.push(tarefa._id);
  }

  // Atualização em massa: esvazia fotos_conclusao e avarias[*].fotos.
  // Usa $set com array filters para limpar as fotos das avarias aninhadas.
  if (idsParaAtualizar.length > 0) {
    // 1. Esvazia fotos_conclusao.
    await Tarefa.updateMany(
      { _id: { $in: idsParaAtualizar } },
      { $set: { fotos_conclusao: [] } }
    );

    // 2. Esvazia avarias[*].fotos (itera sobre cada avaria).
    // Como o MongoDB não tem um operador direto para "esvaziar todos os
    // sub-arrays aninhados", iteramos por tarefa.
    for (const id of idsParaAtualizar) {
      const tarefa = await Tarefa.findById(id);
      if (tarefa && Array.isArray(tarefa.avarias)) {
        let modificou = false;
        for (const avaria of tarefa.avarias) {
          if (Array.isArray(avaria.fotos) && avaria.fotos.length > 0) {
            avaria.fotos = [];
            modificou = true;
          }
        }
        if (modificou) {
          await tarefa.save();
        }
      }
    }
  }

  console.log(
    `✅ [LimpezaFotos] ${idsParaAtualizar.length} tarefa(s) limpa(s), ` +
      `${fotosRemovidas} foto(s) removida(s).`
  );

  return { tarefasLimpas: idsParaAtualizar.length, fotosRemovidas };
}

/**
 * Agenda o cron job para correr todos os dias às 03:00 da manhã.
 */
function iniciarLimpezaFotos() {
  console.log('⏰ [LimpezaFotos] Cron agendado para 03:00 diariamente (0 3 * * *).');

  cron.schedule('0 3 * * *', async () => {
    try {
      await executarLimpezaFotos();
    } catch (err) {
      console.error('❌ [LimpezaFotos] erro não capturado no cron:', err.message);
    }
  });

  return { executarLimpezaFotos };
}

module.exports = { iniciarLimpezaFotos, executarLimpezaFotos };
