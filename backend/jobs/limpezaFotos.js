/**
 * Limpeza de Fotos — Cron Job (All2gether) — HF19
 *
 * Corre todos os dias às 03:00 e esvazia as fotos em base64 (pesadas no MongoDB Atlas):
 *  - `fotos_conclusao` das limpezas concluídas há mais de RETENCAO_FOTOS_DIAS (30);
 *  - `avarias[*].fotos` ao fim de RETENCAO_FOTOS_AVARIAS_DIAS (90) após a resolução da avaria
 *    (`data_resolucao`; nas antigas sem data, o registo) E só se a avaria estiver resolvida (avaria aberta mantém as fotos, por muito antiga que seja).
 * Os dois prazos podem ser alterados por variável de ambiente, com mínimo de 7 dias (valor inválido
 * volta ao por defeito; abaixo de 7 sobe para 7). Aplica-se a `Tarefa` e a `TarefaArquivo`
 * (o arquivista copia tudo, `strict: false`). Descrições e restantes dados mantêm-se.
 *
 * Proteção de espaço (Atlas gratuito, 512 MB): no fim lê `db.stats()`. Acima de 80% de ATLAS_LIMITE_MB
 * avisa os admins (sino, no máximo 1x por dia) e regista no log; acima de 90% aplica nesse dia o
 * prazo mínimo seguro (7 dias) às fotos de conclusão e diz isso no aviso. Regista sempre o tamanho
 * da BD e a estimativa do que ocupam as fotos.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const { notificarSino } = require('../utils/notificar');

const DIA_MS = 24 * 60 * 60 * 1000;
const MINIMO_DIAS = 7;
const LOTE = 100;
const AMOSTRA_MAX = 2000;
const MB = 1024 * 1024;

/** Prazo em dias lido da env (no momento da chamada). Inválido -> defeito; abaixo do mínimo -> mínimo. */
function lerDias(nome, defeito) {
  const n = Number(process.env[nome]);
  // Valor inválido ou abaixo do mínimo volta ao defeito (como em retencao.js): uma
  // configuração errada nunca encurta o prazo.
  if (!process.env[nome] || !Number.isFinite(n) || n < MINIMO_DIAS) return defeito;
  return Math.floor(n);
}
const diasConclusao = () => lerDias('RETENCAO_FOTOS_DIAS', 30);
const diasAvarias = () => lerDias('RETENCAO_FOTOS_AVARIAS_DIAS', 90);
function limiteAtlasMb() {
  const n = Number(process.env.ATLAS_LIMITE_MB);
  // Abaixo de 50 MB é quase de certeza um erro de configuração: usa o limite do plano gratuito.
  return Number.isFinite(n) && n >= 50 ? n : 512;
}

/**
 * Esvazia fotos numa coleção (nativa), em lotes por _id. Idempotente.
 * `campoData`: data da tarefa (Tarefa: data_conclusao; Arquivo: data). `soConcluidas`: exige estado concluida.
 * Devolve { tarefas, fotos } (tarefas realmente alteradas e fotos removidas).
 */
async function limparColecao(col, { campoData, soConcluidas, limConclusao, limAvarias }) {
  const dataDoc = `$${campoData}`;
  const eData = (v) => ({ $eq: [{ $type: v }, 'date'] });
  const condConclusao = {
    $and: [eData(dataDoc), { $lt: [dataDoc, limConclusao] }, ...(soConcluidas ? [{ $eq: ['$estado', 'concluida'] }] : [])],
  };
  // Avaria: só resolvida e com a resolução antes do limite. Sem data_resolucao (avarias antigas) usa
  // data_registo e, sem esta, a data da tarefa.
  const condAvaria = (a) => ({
    $let: {
      vars: { d: { $ifNull: [`${a}.data_resolucao`, { $ifNull: [`${a}.data_registo`, dataDoc] }] } },
      in: { $and: [{ $eq: [{ $type: a }, 'object'] }, { $eq: [`${a}.resolvido`, true] }, eData('$$d'), { $lt: ['$$d', limAvarias] }] },
    },
  });
  const nFotos = (v) => ({ $cond: [{ $isArray: v }, { $size: v }, 0] });
  const filtro = {
    $or: [
      { 'fotos_conclusao.0': { $exists: true }, [campoData]: { $lt: limConclusao }, ...(soConcluidas ? { estado: 'concluida' } : {}) },
      { avarias: { $elemMatch: { resolvido: true, 'fotos.0': { $exists: true } } } },
    ],
  };
  const contar = [{
    $project: {
      n: {
        $add: [
          { $cond: [condConclusao, nFotos('$fotos_conclusao'), 0] },
          { $sum: { $map: { input: { $cond: [{ $isArray: '$avarias' }, '$avarias', []] }, as: 'a', in: { $cond: [condAvaria('$$a'), nFotos('$$a.fotos'), 0] } } } },
        ],
      },
    },
  }];
  const semFotos = [{
    $set: {
      fotos_conclusao: { $cond: [condConclusao, [], '$fotos_conclusao'] },
      avarias: {
        $cond: [{ $isArray: '$avarias' }, {
          $map: { input: '$avarias', as: 'a', in: { $cond: [condAvaria('$$a'), { $mergeObjects: ['$$a', { fotos: [] }] }, '$$a'] } },
        }, '$avarias'],
      },
    },
  }];
  let tarefas = 0;
  let fotos = 0;
  let ultimo = null;
  for (;;) {
    const f = ultimo ? { $and: [filtro, { _id: { $gt: ultimo } }] } : filtro;
    const ids = (await col.find(f, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(LOTE).toArray()).map((d) => d._id);
    if (ids.length === 0) break;
    ultimo = ids[ids.length - 1];
    const cont = await col.aggregate([{ $match: { _id: { $in: ids } } }, ...contar]).toArray();
    const comFotos = cont.filter((c) => c.n > 0);
    if (comFotos.length === 0) continue;
    await col.updateMany({ _id: { $in: comFotos.map((c) => c._id) } }, semFotos);
    tarefas += comFotos.length;
    fotos += comFotos.reduce((s, c) => s + c.n, 0);
  }
  return { tarefas, fotos };
}

async function limparTudo(diasConc, diasAv) {
  const agora = Date.now();
  const limConclusao = new Date(agora - diasConc * DIA_MS);
  const limAvarias = new Date(agora - diasAv * DIA_MS);
  const t = await limparColecao(Tarefa.collection, { campoData: 'data_conclusao', soConcluidas: true, limConclusao, limAvarias });
  let a = { tarefas: 0, fotos: 0 };
  try {
    a = await limparColecao(TarefaArquivo.collection, { campoData: 'data', soConcluidas: false, limConclusao, limAvarias });
  } catch (err) {
    console.error('❌ [LimpezaFotos] erro no arquivo:', err.message);
  }
  return { t, a };
}

/** Estimativa do espaço (bytes) das fotos: soma de $strLenBytes; amostragem se houver muitos documentos. */
async function estimarBytesFotos() {
  const bytesStr = { $cond: [{ $eq: [{ $type: '$$f' }, 'string'] }, { $strLenBytes: '$$f' }, 0] };
  const soma = (input) => ({ $sum: { $map: { input: { $cond: [{ $isArray: input }, input, []] }, as: 'f', in: bytesStr } } });
  const pipelineBytes = [
    {
      $project: {
        b: {
          $add: [
            soma('$fotos_conclusao'),
            { $sum: { $map: { input: { $cond: [{ $isArray: '$avarias' }, '$avarias', []] }, as: 'av', in: soma('$$av.fotos') } } },
          ],
        },
      },
    },
    { $group: { _id: null, bytes: { $sum: '$b' } } },
  ];
  const comFotos = { $or: [{ 'fotos_conclusao.0': { $exists: true } }, { 'avarias.fotos.0': { $exists: true } }] };
  let total = 0;
  let amostrado = false;
  for (const col of [Tarefa.collection, TarefaArquivo.collection]) {
    const n = await col.countDocuments(comFotos);
    if (n === 0) continue;
    const etapas = [{ $match: comFotos }];
    if (n > AMOSTRA_MAX) { etapas.push({ $sample: { size: AMOSTRA_MAX } }); amostrado = true; }
    const r = await col.aggregate([...etapas, ...pipelineBytes], { allowDiskUse: true }).toArray();
    const bytes = r[0] ? r[0].bytes : 0;
    total += n > AMOSTRA_MAX ? Math.round((bytes / AMOSTRA_MAX) * n) : bytes;
  }
  return { bytes: total, amostrado };
}

const fmtMb = (b) => (b / MB).toFixed(1);

/** Lê db.stats() e devolve o uso face ao limite (o maior de dataSize/storageSize). Nunca lança. */
async function lerUsoAtlas() {
  try {
    const st = await mongoose.connection.db.stats();
    const dataSize = Number(st.dataSize) || 0;
    const storageSize = Number(st.storageSize) || 0;
    const usadoMb = Math.max(dataSize, storageSize) / MB;
    const limiteMb = limiteAtlasMb();
    return { dataSize, storageSize, usadoMb, limiteMb, pct: (usadoMb / limiteMb) * 100 };
  } catch (err) {
    console.error('⚠️  [LimpezaFotos] db.stats() falhou:', err.message);
    return null;
  }
}

/** Aviso no sino a todos os admins (Super Admin); a chave limita a um por dia. Devolve quantos criou. */
async function avisarAdmins(mensagem) {
  try {
    const admins = await Utilizador.find({ role: 'admin', ativo: true, eliminado_em: null }).select('_id').lean();
    const chave = `atlas_espaco:${new Date().toISOString().slice(0, 10)}`;
    let n = 0;
    for (const a of admins) if (await notificarSino(a._id, mensagem, { tipo: 'aviso', url: '/admin', chave })) n++;
    return n;
  } catch (err) {
    console.error('⚠️  [LimpezaFotos] avisarAdmins:', err.message);
    return 0;
  }
}

/**
 * Executa a limpeza de fotos e a proteção de espaço.
 * @returns {Promise<{ tarefasLimpas: number, fotosRemovidas: number, arquivoLimpo: number, espaco: object|null }>}
 */
async function executarLimpezaFotos() {
  const dC = diasConclusao();
  const dA = diasAvarias();
  console.log(`🧹 [LimpezaFotos] prazos: conclusão ${dC} d, avarias resolvidas ${dA} d.`);

  const { t, a } = await limparTudo(dC, dA);
  let tarefasLimpas = t.tarefas;
  let fotosRemovidas = t.fotos + a.fotos;
  let arquivoLimpo = a.tarefas;
  console.log(`✅ [LimpezaFotos] ${t.tarefas} tarefa(s) e ${a.tarefas} arquivada(s) limpa(s), ${fotosRemovidas} foto(s) removida(s).`);

  // Proteção de espaço.
  let espaco = null;
  try {
    const uso = await lerUsoAtlas();
    if (uso) {
      const modo7dias = uso.pct >= 90;
      if (modo7dias && dC > MINIMO_DIAS) {
        const extra = await limparTudo(MINIMO_DIAS, dA);
        tarefasLimpas += extra.t.tarefas;
        arquivoLimpo += extra.a.tarefas;
        fotosRemovidas += extra.t.fotos + extra.a.fotos;
      }
      const est = await estimarBytesFotos().catch(() => ({ bytes: 0, amostrado: false }));
      console.log(
        `📊 [LimpezaFotos] BD: dados ${fmtMb(uso.dataSize)} MB, armazenamento ${fmtMb(uso.storageSize)} MB ` +
          `(${uso.pct.toFixed(1)}% de ${uso.limiteMb} MB); fotos restantes ~${fmtMb(est.bytes)} MB${est.amostrado ? ' (estimativa por amostragem)' : ''}.`
      );
      let avisados = 0;
      if (uso.pct >= 80) {
        const msg =
          `⚠️ Espaço da base de dados a ${uso.pct.toFixed(0)}% (${uso.usadoMb.toFixed(0)} de ${uso.limiteMb} MB). ` +
          `As fotos ocupam cerca de ${fmtMb(est.bytes)} MB.` +
          (modo7dias
            ? ` Acima de 90%: hoje as fotos de conclusão foram apagadas ao fim de ${MINIMO_DIAS} dias (prazo normal ${dC}).`
            : ' Considera libertar espaço ou subir de plano.');
        avisados = await avisarAdmins(msg);
        console.warn(`🚨 [LimpezaFotos] ${msg} (avisos novos: ${avisados})`);
      }
      espaco = { pct: uso.pct, usadoMb: uso.usadoMb, limiteMb: uso.limiteMb, fotosBytes: est.bytes, modo7dias, avisados };
    }
  } catch (err) {
    console.error('⚠️  [LimpezaFotos] proteção de espaço falhou:', err.message);
  }

  return { tarefasLimpas, fotosRemovidas, arquivoLimpo, espaco };
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
  }, { timezone: 'Europe/Lisbon' });

  return { executarLimpezaFotos };
}

module.exports = { iniciarLimpezaFotos, executarLimpezaFotos };
