/**
 * Load Balancer — All2gether (Fase 2 / HF16)
 *
 * Motor de atribuição de tarefas a utilizadores (Staff de Limpeza/Manutenção).
 *
 * HF16 — Reescrita total com 4 fatores de scoring (ordem de prioridade):
 *
 *   1. AGRUPAMENTO DIÁRIO (Same-Day Clustering) — peso MÁXIMO
 *      Se o staff já tem uma tarefa na MESMA propriedade nesse dia,
 *      ganha prioridade absoluta (minimiza deslocações inúteis entre
 *      quartos do mesmo edifício). Bónus de 2h (120 min) no score.
 *
 *   2. INÍCIO MAIS CEDO (Earliest Start Time) — métrica temporal
 *      Quem consegue começar mais cedo é favorecido (paralelização).
 *      Calculado via calcularInicioTarefaUtilizador (scheduler sequencial
 *      + proteção de almoço). Diferença de minutos usada diretamente no
 *      score — cada minuto de atraso penaliza o score.
 *
 *   3. ROTATIVIDADE / EQUIDADE SEMANAL — balanceamento de médio prazo
 *      - Equidade: soma das horas já atribuídas ao staff NESSA SEMANA
 *        (segunda a domingo). Quem tem menos horas na semana ganha
 *        prioridade (fator de 10 min de penalização por hora semanal).
 *      - Rotatividade: se o staff limpou a MESMA propriedade ONTEM,
 *        recebe uma penalização de 30 min no score (força rotação —
 *        Equipa A faz o prédio hoje, Equipa B amanhã).
 *
 *   4. DISTÂNCIA / TEMPO DE VIAGEM — fator geográfico
 *      Tempo real de condução via Google Maps Distance Matrix API
 *      (com fallback Haversine se a API key não estiver configurada).
 *      Usado como fator de desempate final.
 *
 * Score FINAL = bónus de clustering - minutos de atraso - penalização
 *   semanal - penalização de rotação + tempo de viagem (menor = melhor).
 *
 * Lógica preservada de HF12:
 *   - Filtro de ausências aprovadas (bloqueiam atribuição)
 *   - Filtro de folgas fixas semanais (dias_folga) e rotativas
 *   - Algoritmo VIP (funcionário preferencial) — com SLA
 *   - SLA de capacidade máxima (480 min = 8h/dia) — exclui quem excede
 *
 * Devolve { utilizadorId, tempoViagem } ou null se ninguém couber no SLA.
 */

const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const {
  CAPACIDADE_MAXIMA_MINUTOS,
  obterRangeDia,
  calcularInicioTarefaUtilizador,
} = require('./scheduler');
const { calcularTempoViagemReal } = require('./distancia');

// Pesos do score (em minutos — quanto menor o score, melhor).
const PESO_CLUSTERING = 120;    // 2h de bónus se já está na mesma propriedade
const PESO_ROTATIVIDADE = 30;   // 30 min de penalização se limpou ontem
const PESO_EQUIDADE_HORA = 10;  // 10 min de penalização por hora semanal acumulada

/**
 * Soma o tempo_limpeza_minutos de todas as tarefas não-canceladas/não-concluídas
 * de um utilizador num dia (range).
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
    { $group: { _id: null, total: { $sum: '$tempo_limpeza_minutos' } } },
  ]);
  return res.length > 0 ? res[0].total : 0;
}

/**
 * HF16 — Verifica se o staff já tem uma tarefa na MESMA propriedade nesse dia.
 * Usado para o fator de Agrupamento Diário (Same-Day Clustering).
 *
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {import('mongoose').Types.ObjectId} propriedadeId
 * @param {{start: Date, end: Date}} range
 * @returns {Promise<boolean>} true se já tem tarefa na mesma propriedade.
 */
async function temTarefaNaMesmaPropriedade(utilizadorId, propriedadeId, range) {
  if (!propriedadeId) return false;
  const count = await Tarefa.countDocuments({
    utilizador_id: utilizadorId,
    propriedade_id: propriedadeId,
    data: { $gte: range.start, $lt: range.end },
    estado: { $nin: ['cancelada'] },
  });
  return count > 0;
}

/**
 * HF16 — Calcula a carga horária SEMANAL acumulada do staff (seg a dom).
 * Inclui tarefas não-canceladas/não-concluídas. Usado para equidade semanal.
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {Date} dataReferencia - qualquer data dentro da semana a avaliar
 * @returns {Promise<number>} total de minutos na semana
 */
async function calcularCargaSemanal(empresaId, utilizadorId, dataReferencia) {
  // Calcula o início da semana (segunda-feira).
  // getDay(): 0=Dom, 1=Seg, ..., 6=Sáb. Para começar em segunda:
  //   se Dom (0) → retrocede 6 dias; se Seg (1) → 0; etc.
  const dia = dataReferencia.getDay();
  const diasParaSegunda = dia === 0 ? 6 : dia - 1;
  const inicioSemana = new Date(dataReferencia);
  inicioSemana.setDate(dataReferencia.getDate() - diasParaSegunda);
  inicioSemana.setHours(0, 0, 0, 0);

  const fimSemana = new Date(inicioSemana);
  fimSemana.setDate(inicioSemana.getDate() + 7); // próxima segunda

  const res = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: empresaId,
        utilizador_id: utilizadorId,
        data: { $gte: inicioSemana, $lt: fimSemana },
        estado: { $nin: ['cancelada'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$tempo_limpeza_minutos' } } },
  ]);
  return res.length > 0 ? res[0].total : 0;
}

/**
 * HF16 — Verifica se o staff limpou a MESMA propriedade no dia ANTERIOR.
 * Usado para o fator de Rotatividade (forçar rotação de equipas).
 *
 * @param {import('mongoose').Types.ObjectId} utilizadorId
 * @param {import('mongoose').Types.ObjectId} propriedadeId
 * @param {Date} dataReferencia - data da tarefa atual
 * @returns {Promise<boolean>} true se limpou ontem essa propriedade.
 */
async function limpouPropriedadeOntem(utilizadorId, propriedadeId, dataReferencia) {
  if (!propriedadeId) return false;
  const ontem = new Date(dataReferencia);
  ontem.setDate(dataReferencia.getDate() - 1);
  const rangeOntem = obterRangeDia(ontem);
  if (!rangeOntem) return false;

  const count = await Tarefa.countDocuments({
    utilizador_id: utilizadorId,
    propriedade_id: propriedadeId,
    data: { $gte: rangeOntem.start, $lt: rangeOntem.end },
    estado: { $nin: ['cancelada'] },
  });
  return count > 0;
}

/**
 * Determina o utilizador (Staff) a quem atribuir a tarefa.
 *
 * HF16 — Score com 4 fatores (ordem de prioridade):
 *   1. Agrupamento Diário (bónus de 120 min se já está na propriedade)
 *   2. Início Mais Cedo (minutos de atraso vs. mais cedo possível)
 *   3. Rotatividade/Equidade (penaliza quem tem + horas semanais / limpou ontem)
 *   4. Distância/Tempo de Viagem (Google Maps ou Haversine)
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {{start: Date, end: Date}} range - intervalo do dia
 * @param {{ lat: number, lng: number } | null} coordenadasNovaPropriedade
 * @param {number} tempoNovaTarefa - tempo_limpeza_minutos da nova tarefa
 * @param {import('mongoose').Types.ObjectId|null} [propriedadeId=null]
 * @returns {Promise<{ utilizadorId, tempoViagem } | null>}
 */
async function determinarUtilizadorAtribuido(
  empresaId,
  range,
  coordenadasNovaPropriedade,
  tempoNovaTarefa,
  propriedadeId = null
) {
  // Procurar todos os Staff ativos da empresa.
  const staff = await Utilizador.find({
    empresa_id: empresaId,
    role: 'staff',
    ativo: true,
    eliminado_em: null,
  }).lean();

  if (staff.length === 0) return null;

  // Filtro de Ausências aprovadas.
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
  // Algoritmo VIP (funcionário preferencial) — preservado.
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
            `⭐ VIP: tarefa atribuída ao preferencial ${vipIdStr} ` +
              `(carga ${cargaTotalVIP}min ≤ ${CAPACIDADE_MAXIMA_MINUTOS}min).`
          );
          return { utilizadorId: vip._id, tempoViagem: 0 };
        }
        console.log(
          `⭐ VIP: preferencial ${vipIdStr} excede SLA ` +
            `(${cargaTotalVIP}min > ${CAPACIDADE_MAXIMA_MINUTOS}min) — fallback para LB.`
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // HF16 — Load Balancer geral com 4 fatores de scoring.
  // ----------------------------------------------------------------
  const disponiveisIds = disponiveis.map((s) => s._id);

  // Pré-busca agregada (1 query para cargas + contagens do dia).
  const cargasLimpeza = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: empresaId,
        utilizador_id: { $in: disponiveisIds },
        data: { $gte: range.start, $lt: range.end },
        estado: { $nin: ['cancelada', 'concluida'] },
      },
    },
    { $group: { _id: '$utilizador_id', total: { $sum: '$tempo_limpeza_minutos' } } },
  ]);
  const cargaLimpezaMap = new Map();
  for (const c of cargasLimpeza) cargaLimpezaMap.set(String(c._id), c.total);

  // Para cada staff, calcula os 4 fatores e o score final.
  const candidatos = [];

  for (const u of disponiveis) {
    const cargaLimpeza = cargaLimpezaMap.get(String(u._id)) ?? 0;

    // SLA: exclui quem excede 480min com a nova tarefa.
    const cargaComNova = Number(cargaLimpeza) + Number(tempoNovaTarefa);
    if (!Number.isFinite(cargaComNova) || cargaComNova > CAPACIDADE_MAXIMA_MINUTOS) {
      console.log(
        `⚠️  SLA: staff ${u._id} excede ${CAPACIDADE_MAXIMA_MINUTOS}min ` +
          `(${cargaComNova}min) — excluído.`
      );
      continue;
    }

    // FATOR 1: Agrupamento Diário (Same-Day Clustering).
    const jaNaPropriedade = propriedadeId
      ? await temTarefaNaMesmaPropriedade(u._id, propriedadeId, range)
      : false;
    const bonusClustering = jaNaPropriedade ? PESO_CLUSTERING : 0;

    // FATOR 2: Earliest Start Time (via scheduler).
    let earliestStart;
    let tempoViagem = 0;
    let origemViagem = 'haversine';
    try {
      const resultadoScheduler = await calcularInicioTarefaUtilizador(
        u._id,
        range.start,
        coordenadasNovaPropriedade,
        Number(tempoNovaTarefa) || 45
      );
      earliestStart = resultadoScheduler.data;

      // HF16 — Usa Google Maps (com fallback Haversine) para o tempo de viagem.
      if (coordenadasNovaPropriedade) {
        // Busca a última tarefa para obter coordenadas da propriedade anterior.
        const ultimaTarefa = await Tarefa.findOne({
          utilizador_id: u._id,
          data: { $gte: range.start, $lt: range.end },
          estado: { $nin: ['cancelada'] },
        })
          .populate({ path: 'propriedade_id', select: 'coordenadas' })
          .sort({ data: -1 })
          .lean();

        if (ultimaTarefa?.propriedade_id?.coordenadas) {
          const resultadoViagem = await calcularTempoViagemReal(
            ultimaTarefa.propriedade_id.coordenadas,
            coordenadasNovaPropriedade
          );
          tempoViagem = resultadoViagem.minutos;
          origemViagem = resultadoViagem.origem;
        }
      }
    } catch (err) {
      console.warn(`⚠️  scheduler falhou para staff ${u._id}: ${err.message} — usa 10:00 UTC.`);
      earliestStart = new Date(range.start);
      earliestStart.setUTCHours(10, 0, 0, 0);
    }

    // FATOR 3a: Equidade Semanal (carga horária da semana).
    const cargaSemanalMin = await calcularCargaSemanal(empresaId, u._id, range.start);
    const horasSemana = cargaSemanalMin / 60;
    const penalizacaoEquidade = Math.round(horasSemana * PESO_EQUIDADE_HORA);

    // FATOR 3b: Rotatividade (limpou ontem?).
    const limpouOntem = propriedadeId
      ? await limpouPropriedadeOntem(u._id, propriedadeId, range.start)
      : false;
    const penalizacaoRotatividade = limpouOntem ? PESO_ROTATIVIDADE : 0;

    // FATOR 4: tempo de viagem (Google Maps ou Haversine).
    // Já calculado acima como `tempoViagem`.

    // SCORE FINAL: menor = melhor.
    // Começa pelo timestamp do earliest start (em minutos desde meia-noite UTC).
    const minutosDesdeMeiaNoite =
      earliestStart.getUTCHours() * 60 + earliestStart.getUTCMinutes();

    const score =
      minutosDesdeMeiaNoite   // F2: início mais cedo
      - bonusClustering       // F1: bónus de clustering (subtrai → melhora)
      + penalizacaoEquidade   // F3a: equidade semanal (soma → piora)
      + penalizacaoRotatividade // F3b: rotatividade (soma → piora)
      + tempoViagem;          // F4: tempo de viagem (soma → piora)

    candidatos.push({
      utilizador: u,
      score,
      earliestStart,
      tempoViagem,
      origemViagem,
      jaNaPropriedade,
      cargaSemanalMin,
      horasSemana: Math.round(horasSemana * 10) / 10,
      limpouOntem,
      cargaComNova,
    });

    console.log(
      `📊 [HF16] staff ${u._id}: score=${score} ` +
        `(início=${minutosDesdeMeiaNoite}min, cluster=${jaNaPropriedade ? '+' + PESO_CLUSTERING : '0'}, ` +
        `equidade=${penalizacaoEquidade} (${horasSemana.toFixed(1)}h sem), ` +
        `rotação=${limpouOntem ? '+' + PESO_ROTATIVIDADE : '0'}, ` +
        `viagem=${tempoViagem}min [${origemViagem}]).`
    );
  }

  if (candidatos.length === 0) {
    console.log(
      `⚠️  determinarUtilizadorAtribuido: nenhum staff coube no SLA de ${CAPACIDADE_MAXIMA_MINUTOS}min.`
    );
    return null;
  }

  // Ordena por score (menor = melhor).
  candidatos.sort((a, b) => a.score - b.score);
  const vencedor = candidatos[0];

  console.log(
    `✅ [HF16] Load Balancer: staff ${vencedor.utilizador._id} eleito ` +
      `(score=${vencedor.score}, início=${vencedor.earliestStart.toISOString()}, ` +
      `cluster=${vencedor.jaNaPropriedade}, ` +
      `semana=${vencedor.horasSemana}h, ` +
      `rotação=${vencedor.limpouOntem ? 'sim' : 'não'}, ` +
      `viagem=${vencedor.tempoViagem}min [${vencedor.origemViagem}]).`
  );

  return {
    utilizadorId: vencedor.utilizador._id,
    tempoViagem: vencedor.tempoViagem,
  };
}

module.exports = {
  calcularCargaLimpezaDia,
  determinarUtilizadorAtribuido,
  // Exportados para testes:
  temTarefaNaMesmaPropriedade,
  calcularCargaSemanal,
  limpouPropriedadeOntem,
};
