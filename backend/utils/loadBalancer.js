/**
 * Load Balancer — All2gether
 *
 * Motor de atribuição de tarefas a utilizadores (Staff de Limpeza/Manutenção).
 *
 * Lógica central (extraída do antigo webhookController.js na F0):
 *   - Filtro de ausências aprovadas (bloqueiam atribuição)
 *   - Filtro de folgas fixas semanais (dias_folga)
 *   - Algoritmo VIP (funcionário preferencial da propriedade)
 *   - Cálculo de carga total (limpeza acumulada + viagem + nova tarefa)
 *   - SLA de capacidade máxima (480 min = 8h/dia)
 *   - Escolha do utilizador com menor carga_total
 *
 * Devolve { utilizadorId, tempoViagem } ou null se ninguém couber no SLA.
 *
 * Usado por:
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
 * Determina o utilizador (Staff) a quem atribuir a tarefa, aplicando:
 *   - filtro de ausências aprovadas
 *   - filtro de folgas fixas semanais (dias_folga)
 *   - algoritmo VIP (funcionário preferencial)
 *   - cálculo de carga + tempo de viagem (Haversine)
 *   - SLA de capacidade máxima (480 min = 8h/dia)
 *   - escolha do utilizador com menor carga_total
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
  // Cálculo de Carga + Tempo de Viagem (load balancer geral).
  // ----------------------------------------------------------------
  const disponiveisIds = disponiveis.map((s) => s._id);

  const cargasLimpeza = await Tarefa.aggregate([
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
  ]);

  const cargaLimpezaMap = new Map();
  for (const c of cargasLimpeza) {
    cargaLimpezaMap.set(String(c._id), c.total);
  }

  let melhorUtilizador = null;
  let menorCargaTotal = Infinity;
  let melhorTempoViagem = 0;

  for (const u of disponiveis) {
    const cargaLimpeza = cargaLimpezaMap.get(String(u._id)) ?? 0;

    const ultimaTarefa = await Tarefa.findOne({
      utilizador_id: u._id,
      data: { $gte: range.start, $lt: range.end },
      estado: { $nin: ['cancelada', 'concluida'] },
    })
      .populate({ path: 'propriedade_id', select: 'coordenadas' })
      .sort({ createdAt: -1 })
      .lean();

    let tempoViagem = 0;
    if (ultimaTarefa && ultimaTarefa.propriedade_id) {
      const coordAnterior = ultimaTarefa.propriedade_id.coordenadas;
      tempoViagem = calcularTempoViagem(coordAnterior, coordenadasNovaPropriedade);
    }

    const cargaTotal =
      Number(cargaLimpeza) + Number(tempoViagem) + Number(tempoNovaTarefa);

    if (!Number.isFinite(cargaTotal)) {
      console.warn(`⚠️  determinarUtilizadorAtribuido: cargaTotal=NaN para staff ${u._id} (cargaLimpeza=${cargaLimpeza}, tempoViagem=${tempoViagem}, tempoNovaTarefa=${tempoNovaTarefa})`);
      continue;
    }

    if (cargaTotal > CAPACIDADE_MAXIMA_MINUTOS) {
      console.log(`⚠️  SLA: staff ${u._id} excede 480min (cargaTotal=${cargaTotal}min) — excluído do load balancer.`);
      continue;
    }

    if (cargaTotal < menorCargaTotal) {
      menorCargaTotal = cargaTotal;
      melhorUtilizador = u;
      melhorTempoViagem = tempoViagem;
    }
  }

  if (!melhorUtilizador) {
    console.log(`⚠️  determinarUtilizadorAtribuido: nenhum staff disponível coube no SLA de ${CAPACIDADE_MAXIMA_MINUTOS}min — tarefa será 'nao_atribuida'.`);
  }

  return melhorUtilizador ? { utilizadorId: melhorUtilizador._id, tempoViagem: melhorTempoViagem } : null;
}

module.exports = {
  calcularCargaLimpezaDia,
  determinarUtilizadorAtribuido,
};
