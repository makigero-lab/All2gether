/**
 * Arquivista — Cron Job (All2gether)
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

const MESES_PADRAO = 3;
const MESES_MIN = 1;
const MESES_MAX = 120;
const LOTE = 500;

/** Valida os meses de antiguidade: inteiro entre 1 e 120 (por omissão 3). Lança erro se inválido. */
function validarMeses(meses) {
  if (meses === undefined || meses === null) return MESES_PADRAO;
  const n = typeof meses === 'string' && meses.trim() !== '' ? Number(meses) : meses;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MESES_MIN || n > MESES_MAX) {
    throw new RangeError(`meses inválido (inteiro entre ${MESES_MIN} e ${MESES_MAX}).`);
  }
  return n;
}

/**
 * Arquiva tarefas concluídas/canceladas com mais de `meses` meses (por omissão 3).
 * Validação: `meses` tem de ser um inteiro razoável; cada tarefa é validada contra o schema do
 * arquivo antes de ser copiada e só se apaga da coleção principal o que ficou mesmo no arquivo
 * (uma tarefa inválida fica onde está e é registada no log, em vez de fazer falhar o lote todo).
 */
async function executarArquivista({ meses } = {}) {
  console.log('📦 [Arquivista] A iniciar às', new Date().toISOString());

  try {
    const mesesValidos = validarMeses(meses);
    // 1) Data limite.
    const limite = new Date();
    limite.setMonth(limite.getMonth() - mesesValidos);

    let arquivadas = 0;
    let invalidas = 0;
    let ultimoId = null;

    // 2) Em lotes (não carrega tudo para memória), percorridos por _id.
    for (;;) {
      const filtro = {
        estado: { $in: ['concluida', 'cancelada'] },
        data: { $lt: limite },
        ...(ultimoId ? { _id: { $gt: ultimoId } } : {}),
      };
      const tarefas = await Tarefa.find(filtro).sort({ _id: 1 }).limit(LOTE).lean();
      if (tarefas.length === 0) break;
      ultimoId = tarefas[tarefas.length - 1]._id;

      const ja = new Set(
        (await TarefaArquivo.find({ tarefa_original_id: { $in: tarefas.map((t) => t._id) } }).select('tarefa_original_id').lean())
          .map((d) => String(d.tarefa_original_id))
      );
      const agora = new Date();
      const paraInserir = [];
      const idsApagar = [];
      for (const t of tarefas) {
        if (ja.has(String(t._id))) { idsApagar.push(t._id); continue; } // copiada antes de uma falha: só falta apagar
        const doc = { ...t, arquivado_em: agora, tarefa_original_id: t._id };
        delete doc._id;
        const erro = new TarefaArquivo(doc).validateSync();
        if (erro) {
          invalidas++;
          console.warn(`⚠️  [Arquivista] tarefa ${t._id} não arquivada (inválida): ${erro.message}`);
          continue;
        }
        paraInserir.push(doc);
        idsApagar.push(t._id);
      }

      // 3) Copia e só depois apaga (se a cópia falhar, nada é apagado).
      if (paraInserir.length > 0) await TarefaArquivo.insertMany(paraInserir);
      if (idsApagar.length > 0) {
        const r = await Tarefa.deleteMany({ _id: { $in: idsApagar } });
        arquivadas += r.deletedCount || 0;
      }
    }

    if (arquivadas === 0 && invalidas === 0) {
      console.log('ℹ️  [Arquivista] Sem tarefas para arquivar.');
      return { arquivadas: 0 };
    }
    console.log(`✅ [Arquivista] ${arquivadas} tarefa(s) arquivada(s) (anteriores a ${limite.toISOString().slice(0, 10)}), ${invalidas} inválida(s) ignorada(s).`);
    return { arquivadas, invalidas };
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

module.exports = { iniciarArquivista, executarArquivista, validarMeses };
