/**
 * Load Balancer — All2gether
 *
 * Motor de atribuição de tarefas a utilizadores (Staff de Limpeza/Manutenção).
 *
 * HF12 — Otimização para paralelizar trabalho (anti-estrangulamento):
 *   A métrica PRINCIPAL passou a ser o EARLIEST START TIME — quem consegue
 *   começar a tarefa mais cedo é o vencedor. Isto evita que um funcionário
 *   receba tarefas em cascata até às 16h enquanto outros ficam livres desde
 *   o meio-dia. Tie-breakers: 1º menos tarefas no dia, 2º mais perto (Haversine).
 *
 * Lógica central:
 *   - Filtro de ausências aprovadas (bloqueiam atribuição)
 *   - Filtro de folgas fixas semanais (dias_folga)
 *   - Algoritmo VIP (funcionário preferencial da propriedade) — com SLA
 *   - Para cada disponível: calcula Earliest Start Time via scheduler
 *   - SLA de capacidade máxima (480 min = 8h/dia) — exclui quem excede
 *   - Vencedor: menor Earliest Start Time
 *   - Tie-breaker 1: menos tarefas atribuídas nesse dia
 *   - Tie-breaker 2: menor distância Haversine (tempo de viagem)
 *
 * Devolve { utilizadorId, tempoViagem } ou null se ninguém couber no SLA.
 *
 * Usado por:
 *   - smoobuController.js (criarTarefaPorReserva — fallback ao LB)
 *   - tarefaController.js (autoAtribuirTarefas, reatribuirTarefa)
 *   - jobs/caoGuarda.js (fail-safe noturno)
 */

const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularTempoViagem,
  obterRangeDia,
  calcularInicioTarefaUtilizador,
} = require('./scheduler');

/**
 * Soma o tempo_limpeza_minutos de todas as tarefas não-canceladas/não-concluídas
 * de um utilizador num dia (range).
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {{start: Date, end: Date}} range
 * @returns {Promise<number>}
 */
async function calcularCargaLimpezaDia(empresaId, utilizadorId, range) {
  const res = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: empresaId,
        utilizador_id: utilizadorId,
        data: { $gte: range.start, $lt: range.end },
        estado: { $nin: ['cancelada', 'concluida'] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$tempo_limpeza_minutos' },
      },
    },
  ]);
  return res.length > 0 ? res[0].total : 0;
}

/**
 * Conta o NÚMERO de tarefas (não carga) de um utilizador num dia.
 * Usado como tie-breaker: entre dois staff com o mesmo Earliest Start Time,
 * prefere quem tem MENOS tarefas atribuídas (distribui o trabalho).
 *
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {{start: Date, end: Date}} range
 * @returns {Promise<number>}
 */
async function contarTarefasDia(utilizadorId, range) {
  return Tarefa.countDocuments({
    utilizador_id: utilizadorId,
    data: { $gte: range.start, $lt: range.end },
    estado: { $nin: ['cancelada', 'concluida'] },
  });
}

/**
 * Determina o utilizador (Staff) a quem atribuir a tarefa, aplicando:
 *   - filtro de ausências aprovadas
 *   - filtro de folgas fixas semanais (dias_folga)
 *   - algoritmo VIP (funcionário preferencial) — com SLA
 *   - SLA de capacidade máxima (480 min = 8h/dia) — exclui quem excede
 *
 * HF12 — Métrica PRINCIPAL: Earliest Start Time.
 *   Para cada staff disponível, calcula a data/hora mais cedo a que consegue
 *   começar a tarefa (via calcularInicioTarefaUtilizador — considera a última
 *   tarefa do dia + tempo de viagem + proteção de almoço). Vence quem conseguir
 *   começar MAIS CEDO. Isto paraleliza o trabalho entre a equipa.
 *
 * Tie-breakers (se empate no Earliest Start Time):
 *   1º: menos tarefas atribuídas nesse dia (load balancing real)
 *   2º: menor tempo de viagem Haversine (mais perto geograficamente)
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {{start: Date, end: Date}} range - intervalo do dia
 * @param {{ lat: number, lng: number } | null} coordenadasNovaPropriedade
 * @param {number} tempoNovaTarefa - tempo_limpeza_minutos da nova tarefa
 * @param {import('mongoose').Types.ObjectId|null} [propriedadeId=null] - id da propriedade (para VIP)
 * @returns {Promise<{ utilizadorId: import('mongoose').Types.ObjectId, tempoViagem: number } | null>}
 */
async function determinarUtilizadorAtribuido(empresaId, range, coordenadasNovaPropriedade, tempoNovaTarefa, propriedadeId = null) {
  // Procurar todos os Staff ativos da empresa.
  const staff = await Utilizador.find({
    empresa_id: empresaId,
    role: 'staff',
    ativo: true,
    eliminado_em: null,
  }).lean();

  if (staff.length === 0) return null;

  // Filtro de Ausências: excluir quem tem ausência APROVADA que cobre este dia.
  const ausentes = await Ausencia.find({
    utilizador_id: { $in: staff.map((s) => s._id) },
    estado: 'aprovada',
    data_inicio: { $lte: range.start },
    data_fim: { $gte: range.start },
  }).distinct('utilizador_id');

  const setAusentes = new Set(ausentes.map(String));

  // Filtro de Folgas Fixas Semanais.
  const diaSemana = range.start.getDay();

  const disponiveis = staff.filter((s) => {
    if (setAusentes.has(String(s._id))) return false;
    if (s.dias_folga && Array.isArray(s.dias_folga) && s.dias_folga.includes(diaSemana)) {
      return false;
    }
    return true;
  });

  if (disponiveis.length === 0) return null;

  // ----------------------------------------------------------------
  // Algoritmo VIP (funcionário preferencial).
  // NOTA: O VIP é tratado ANTES do Earliest Start Time para preservar a
  // preferência do gestor. O fallback "VIP só começa depois das 14h → LB"
  // é tratado no smoobuController.js (criarTarefaPorReserva), não aqui —
  // o LB respeita o VIP se for passado propriedadeId.
  // ----------------------------------------------------------------
  if (propriedadeId) {
    const propVIP = await Propriedade.findById(propriedadeId)
      .select('funcionario_preferencial_id')
      .lean();
    const vipId = propVIP?.funcionario_preferencial_id;
    if (vipId) {
      const vipIdStr = String(vipId);
      const vip = disponiveis.find((s) => String(s._id) === vipIdStr);
      if (vip) {
        const cargaLimpezaVIP = Number(await calcularCargaLimpezaDia(empresaId, vip._id, range)) || 0;
        const cargaTotalVIP = cargaLimpezaVIP + Number(tempoNovaTarefa);
        if (cargaTotalVIP <= CAPACIDADE_MAXIMA_MINUTOS) {
          console.log(
            `⭐ Algoritmo VIP: tarefa atribuída ao funcionário preferencial ${vipIdStr} ` +
              `(carga ${cargaTotalVIP}min ≤ ${CAPACIDADE_MAXIMA_MINUTOS}min).`
          );
          return { utilizadorId: vip._id, tempoViagem: 0 };
        }
        console.log(
          `⭐ Algoritmo VIP: preferencial ${vipIdStr} excede SLA ` +
            `(${cargaTotalVIP}min > ${CAPACIDADE_MAXIMA_MINUTOS}min) — fallback para load balancer geral.`
        );
      } else {
        console.log(
          `⭐ Algoritmo VIP: preferencial ${vipIdStr} indisponível (folga/ausência/inativo) — fallback para load balancer geral.`
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // HF12 — Load Balancer geral: Earliest Start Time + tie-breakers.
  // ----------------------------------------------------------------
  // Para cada staff disponível, calcula:
  //   1. Earliest Start Time (via calcularInicioTarefaUtilizador)
  //   2. Nº de tarefas no dia (tie-breaker 1)
  //   3. Tempo de viagem Haversine (tie-breaker 2)
  //   4. Carga total (para validação de SLA — exclui quem excede 480min)
  //
  // Vencedor: menor Earliest Start Time.
  // Empate: menos tarefas no dia.
  // Empate: menor tempo de viagem.

  // Pré-busca agregada de cargas + contagens de tarefas (1 query em vez de N).
  const disponiveisIds = disponiveis.map((s) => s._id);

  const [cargasLimpeza, contagensTarefas] = await Promise.all([
    Tarefa.aggregate([
      {
        $match: {
          empresa_id: empresaId,
          utilizador_id: { $in: disponiveisIds },
          data: { $gte: range.start, $lt: range.end },
          estado: { $nin: ['cancelada', 'concluida'] },
        },
      },
      {
        $group: {
          _id: '$utilizador_id',
          total: { $sum: '$tempo_limpeza_minutos' },
        },
      },
    ]),
    Tarefa.aggregate([
      {
        $match: {
          empresa_id: empresaId,
          utilizador_id: { $in: disponiveisIds },
          data: { $gte: range.start, $lt: range.end },
          estado: { $nin: ['cancelada', 'concluida'] },
        },
      },
      {
        $group: {
          _id: '$utilizador_id',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const cargaLimpezaMap = new Map();
  for (const c of cargasLimpeza) {
    cargaLimpezaMap.set(String(c._id), c.total);
  }
  const contagemTarefasMap = new Map();
  for (const c of contagensTarefas) {
    contagemTarefasMap.set(String(c._id), c.count);
  }

  let melhorUtilizador = null;
  let melhorScore = null; // { earliestStart, numTarefas, tempoViagem }
  let melhorTempoViagem = 0;

  for (const u of disponiveis) {
    const cargaLimpeza = cargaLimpezaMap.get(String(u._id)) ?? 0;
    const numTarefas = contagemTarefasMap.get(String(u._id)) ?? 0;

    // Validação de SLA: exclui quem excede 480min com a nova tarefa.
    // Nota: o tempo de viagem não entra no SLA aqui (só carga de limpeza),
    // para alinhar com a validação original. O scheduler depois agenda a hora.
    const cargaComNova = Number(cargaLimpeza) + Number(tempoNovaTarefa);
    if (!Number.isFinite(cargaComNova)) {
      console.warn(
        `⚠️  determinarUtilizadorAtribuido: cargaComNova=NaN para staff ${u._id} ` +
          `(cargaLimpeza=${cargaLimpeza}, tempoNovaTarefa=${tempoNovaTarefa})`
      );
      continue;
    }
    if (cargaComNova > CAPACIDADE_MAXIMA_MINUTOS) {
      console.log(
        `⚠️  SLA: staff ${u._id} excede ${CAPACIDADE_MAXIMA_MINUTOS}min ` +
          `(carga=${cargaLimpeza}min + nova=${tempoNovaTarefa}min = ${cargaComNova}min) — excluído.`
      );
      continue;
    }

    // HF12 — Calcula o Earliest Start Time para este staff.
    // O scheduler considera a última tarefa do dia + tempo de viagem +
    // proteção de almoço. Se não tiver tarefas, começa às 11:00 local (10:00 UTC).
    let earliestStart;
    let tempoViagem = 0;
    try {
      const resultadoScheduler = await calcularInicioTarefaUtilizador(
        u._id,
        range.start,
        coordenadasNovaPropriedade,
        Number(tempoNovaTarefa) || 45
      );
      earliestStart = resultadoScheduler.data;
      tempoViagem = Number(resultadoScheduler.tempoViagem) || 0;
    } catch (err) {
      // Se o scheduler falhar, usa 10:00 UTC como fallback (não bloqueia).
      console.warn(
        `⚠️  scheduler falhou para staff ${u._id}: ${err.message} — usa 10:00 UTC.`
      );
      earliestStart = new Date(range.start);
      earliestStart.setUTCHours(10, 0, 0, 0);
    }

    // Compara com o melhor atual.
    // Critérios por ordem: earliestStart → numTarefas → tempoViagem.
    const candidatoScore = { earliestStart, numTarefas, tempoViagem };
    if (melhorScore === null || ehMelhorCandidato(candidatoScore, melhorScore)) {
      melhorScore = candidatoScore;
      melhorUtilizador = u;
      melhorTempoViagem = tempoViagem;
    }
  }

  if (!melhorUtilizador) {
    console.log(
      `⚠️  determinarUtilizadorAtribuido: nenhum staff disponível coube no SLA de ${CAPACIDADE_MAXIMA_MINUTOS}min — tarefa será 'nao_atribuida'.`
    );
  } else {
    console.log(
      `✅ [HF12] Load Balancer: staff ${melhorUtilizador._id} eleito ` +
        `(início=${melhorScore.earliestStart.toISOString()}, ` +
        `tarefas no dia=${melhorScore.numTarefas}, viagem=${melhorScore.tempoViagem}min).`
    );
  }

  return melhorUtilizador
    ? { utilizadorId: melhorUtilizador._id, tempoViagem: melhorTempoViagem }
    : null;
}

/**
 * Compara um candidato com o melhor atual segundo os critérios HF12:
 *   1º Earliest Start Time (mais cedo vence)
 *   2º Menos tarefas no dia (menor vence)
 *   3º Menor tempo de viagem (menor vence)
 *
 * @param {{earliestStart: Date, numTarefas: number, tempoViagem: number}} candidato
 * @param {{earliestStart: Date, numTarefas: number, tempoViagem: number}} atual
 * @returns {boolean} true se o candidato é estritamente melhor que o atual.
 */
function ehMelhorCandidato(candidato, atual) {
  // 1º Earliest Start Time (timestamp menor = mais cedo).
  const tCand = candidato.earliestStart.getTime();
  const tAtual = atual.earliestStart.getTime();
  if (tCand !== tAtual) {
    return tCand < tAtual;
  }
  // 2º Menos tarefas no dia.
  if (candidato.numTarefas !== atual.numTarefas) {
    return candidato.numTarefas < atual.numTarefas;
  }
  // 3º Menor tempo de viagem.
  return candidato.tempoViagem < atual.tempoViagem;
}

module.exports = {
  calcularCargaLimpezaDia,
  determinarUtilizadorAtribuido,
};
