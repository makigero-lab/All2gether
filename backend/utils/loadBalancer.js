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
 *   - Janela do dia (09:00-18:00, almoço e viagens, ver horario.js) — exclui quem não cabe
 *
 * Devolve { utilizadorId, tempoViagem } ou null se ninguém couber no SLA.
 */

const mongoose = require('mongoose');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const {
  obterRangeDia,
  calcularInicioTarefaUtilizador,
} = require('./scheduler');
const { minutosLocais } = require('./horario');
const { comMembro, EXPR_MEMBROS, retirarMembroDoc } = require('./equipaTarefa');

// Pesos do score (em minutos — quanto menor o score, melhor).
const PESO_CLUSTERING = 120;    // 2h de bónus se já está na mesma propriedade
const PESO_ROTATIVIDADE = 30;   // 30 min de penalização se limpou ontem
const PESO_EQUIDADE_HORA = 10;  // 10 min de penalização por hora semanal acumulada

// Os `aggregate` NÃO fazem cast automático: um id em string (ex.: do JWT)
// nunca casaria e a carga daria 0 (limite de 8h ignorado). Cast aqui, uma vez.
function oid(v) {
  if (v && typeof v === 'object' && v._bsontype) return v;
  if (v && typeof v === 'object' && v._id) return oid(v._id);
  return mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : v;
}

/**
 * Soma o tempo_limpeza_minutos de todas as tarefas não-canceladas/não-concluídas
 * de um utilizador num dia (range).
 */
async function calcularCargaLimpezaDia(empresaId, utilizadorId, range) {
  // Conta as tarefas em que é responsável OU membro da equipa.
  const res = await Tarefa.aggregate([
    {
      $match: {
        empresa_id: oid(empresaId),
        $or: [{ utilizador_id: oid(utilizadorId) }, { utilizador_id: { $ne: null }, equipa_atribuida: oid(utilizadorId) }],
        data: { $gte: range.start, $lt: range.end },
        estado: { $nin: ['cancelada', 'concluida'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$tempo_limpeza_minutos' } } },
  ]);
  return res.length > 0 ? res[0].total : 0;
}

/** A limpeza cabe na agenda desta pessoa neste dia (janela, almoço e viagens)? */
async function cabeNoHorario(utilizadorId, range, coord, tempo, propriedadeId = null) {
  try {
    const r = await calcularInicioTarefaUtilizador(utilizadorId, range.start, coord, Number(tempo) || 45, null, propriedadeId);
    return !!r.cabe;
  } catch (e) {
    return false;
  }
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
  const count = await Tarefa.countDocuments(comMembro({
    propriedade_id: propriedadeId,
    data: { $gte: range.start, $lt: range.end },
    estado: { $nin: ['cancelada'] },
  }, utilizadorId));
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
        empresa_id: oid(empresaId),
        $or: [{ utilizador_id: oid(utilizadorId) }, { utilizador_id: { $ne: null }, equipa_atribuida: oid(utilizadorId) }],
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

  const count = await Tarefa.countDocuments(comMembro({
    propriedade_id: propriedadeId,
    data: { $gte: rangeOntem.start, $lt: rangeOntem.end },
    estado: { $nin: ['cancelada'] },
  }, utilizadorId));
  return count > 0;
}

/**
 * Staff elegível (ativo, sem ausência/folga, equipa exclusiva) para o dia.
 * Partilhado pelo load balancer e pelo diagnóstico do motivo de falha.
 */
async function obterStaffDisponivel(empresaId, range, propriedadeId = null, excluirStaffIds = null) {
  // Procurar todos os Staff ativos da empresa.
  const staff = await Utilizador.find({
    empresa_id: empresaId,
    role: 'staff',
    ativo: true,
    eliminado_em: null,
  }).lean();

  if (staff.length === 0) return { staff, disponiveis: [], setAusentes: new Set(), setExcluidos: null, diaSemana: range.start.getDay() };

  // ------------------------------------------------------------------
  // FIX (folgas/férias) — Filtro de Ausências (interseção de intervalos).
  // ------------------------------------------------------------------
  // Antes: data_inicio <= range.start AND data_fim >= range.start.
  //   → Falhava quando a ausência terminava no dia da tarefa com horário
  //     inferior a range.start, ou quando range.start não era meia-noite.
  // Agora: data_inicio < range.end AND data_fim >= range.start.
  //   → Interseção de intervalos padrão: cobre qualquer parte do dia.
  // Estados considerados ausência ATIVA:
  //   - 'aprovada' — férias/doença confirmadas pelo gestor.
  //   - 'pendente_emergencia' — falta súbita do próprio funcionário para o
  //     dia atual (v1.26.0). É uma ausência real mesmo sem aprovação — se
  //     o LB corre hoje, o staff está de facto indisponível.
  // Exclui: 'pendente' (pedido normal não confirmado), 'rejeitada', 'cancelada'.
  const ausentes = await Ausencia.find({
    utilizador_id: { $in: staff.map((s) => s._id) },
    estado: { $in: ['aprovada', 'pendente_emergencia'] },
    data_inicio: { $lt: range.end },
    data_fim: { $gte: range.start },
  }).distinct('utilizador_id');

  const setAusentes = new Set(ausentes.map(String));

  // ------------------------------------------------------------------
  // FIX (folgas/férias) — Filtro de Folgas Fixas Semanais (dias_folga).
  // FIX (equipas preferenciais) — Se a propriedade tiver equipa_preferencial,
  // staff com exclusivo_preferenciais: true SÓ são elegíveis se estiverem
  // nesse array. Staff sem exclusivo_preferenciais pode ser atribuído a qualquer
  // propriedade.
  // ------------------------------------------------------------------
  const diaSemana = range.start.getDay();

  // Set de exclusão explícita (versão de equipas — staff já escolhidos).
  const setExcluidos = excluirStaffIds instanceof Set ? excluirStaffIds : null;

  // FIX (equipas preferenciais) — Carrega a equipa_preferencial da propriedade
  // (se propriedadeId for fornecido). Usa para filtrar exclusivos.
  let setEquipaPreferencial = null;
  if (propriedadeId) {
    try {
      const propEquip = await Propriedade.findById(propriedadeId)
        .select('equipa_preferencial')
        .lean();
      if (propEquip?.equipa_preferencial && Array.isArray(propEquip.equipa_preferencial)) {
        setEquipaPreferencial = new Set(propEquip.equipa_preferencial.map(String));
      }
    } catch (e) {
      // Se falhar, continua sem filtro de exclusividade (seguro).
    }
  }

  const disponiveis = staff.filter((s) => {
    const idStr = String(s._id);
    // (c) Exclusão explícita (versão de equipas).
    if (setExcluidos && setExcluidos.has(idStr)) return false;
    // (b) Ausência ativa (férias/doença/emergência) que cobre o dia.
    if (setAusentes.has(idStr)) return false;
    // (a) Folga fixa semanal — dia da semana da tarefa no array dias_folga.
    if (
      Array.isArray(s.dias_folga) &&
      s.dias_folga.length > 0 &&
      s.dias_folga.includes(diaSemana)
    ) {
      return false;
    }
    // Folgas rotativas (datas avulsas): antes só o ramo VIP do Smoobu as respeitava.
    if (
      Array.isArray(s.folgas_rotativas) &&
      s.folgas_rotativas.some(
        (fr) => fr && fr.data && new Date(fr.data) >= range.start && new Date(fr.data) < range.end
      )
    ) {
      return false;
    }
    // FIX (equipas preferenciais) — Se o staff tem exclusivo_preferenciais: true,
    // só é elegível se a propriedade estiver nas suas propriedades_alocadas OU
    // se o seu ID constar na equipa_preferencial da propriedade.
    // Isto garante que um funcionário exclusivo de Lisboa NUNCA recebe
    // tarefas de uma casa do Algarve, mesmo que a casa não tenha
    // equipa_preferencial definida.
    if (s.exclusivo_preferenciais === true) {
      // Verifica se o staff está na equipa_preferencial da propriedade.
      const naEquipaPreferencial = setEquipaPreferencial && setEquipaPreferencial.has(idStr);
      // Verifica se a propriedade está nas propriedades_alocadas do staff.
      const propriedadesAlocadas = Array.isArray(s.propriedades_alocadas) ? s.propriedades_alocadas.map(String) : [];
      const nasAlocadas = propriedadeId && propriedadesAlocadas.includes(String(propriedadeId));
      // Se não estiver em nenhuma das duas, exclui.
      if (!naEquipaPreferencial && !nasAlocadas) return false;
    }
    return true;
  });

  return { staff, disponiveis, setAusentes, setExcluidos, diaSemana };
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
 * FIX (folgas/férias) — Filtros de indisponibilidade reforçados:
 *   a) Folgas fixas semanais (Utilizador.dias_folga): compara o dia da
 *      semana da tarefa contra o array [0=Dom ... 6=Sáb] de cada staff.
 *      O dia da semana é calculado a partir de range.start (meia-noite UTC
 *      do dia da tarefa, devolvido por obterRangeDia).
 *   b) Ausências (coleção Ausencia): query por interseção de intervalos
 *      (data_inicio < range.end AND data_fim >= range.start) que englobe
 *      qualquer parte do dia da tarefa. Inclui estado 'aprovada' (férias/
 *      doença confirmadas) E 'pendente_emergencia' (falta súbita do próprio
 *      funcionário para o dia atual — ausência ativa mesmo sem aprovação).
 *      Exclui 'pendente' (pedido normal não confirmado), 'rejeitada' e
 *      'cancelada'.
 *   c) Exclusão explícita via excluirStaffIds (Set) — usado pela versão de
 *      equipas (determinarEquipaAtribuida) para não repetir o mesmo staff.
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {{start: Date, end: Date}} range - intervalo do dia (start=meia-noite UTC, end=meia-noite do dia seguinte)
 * @param {{ lat: number, lng: number } | null} coordenadasNovaPropriedade
 * @param {number} tempoNovaTarefa - tempo_limpeza_minutos da nova tarefa
 * @param {import('mongoose').Types.ObjectId|null} [propriedadeId=null]
 * @param {Set<string>|null} [excluirStaffIds=null] - IDs (string) a excluir do pool (usado pela versão de equipas)
 * @returns {Promise<{ utilizadorId, tempoViagem } | null>}
 */
async function determinarUtilizadorAtribuido(
  empresaId,
  range,
  coordenadasNovaPropriedade,
  tempoNovaTarefa,
  propriedadeId = null,
  excluirStaffIds = null
) {
  const { staff, disponiveis, setAusentes, setExcluidos, diaSemana } = await obterStaffDisponivel(
    empresaId,
    range,
    propriedadeId,
    excluirStaffIds
  );
  if (staff.length === 0) return null;

  if (disponiveis.length === 0) {
    console.log(
      `⚠️  [FIX folgas] Nenhum elemento da equipa disponível para o dia ${range.start.toISOString().slice(0, 10)} ` +
        `(diaSemana=${diaSemana}). ` +
        `Total staff=${staff.length}, ausentes=${setAusentes.size}, ` +
        `excluídos explicitamente=${setExcluidos ? setExcluidos.size : 0}.`
    );
    return null;
  }

  // ----------------------------------------------------------------
  // Algoritmo VIP (equipa preferencial + funcionário preferencial) — preservado.
  // FIX (equipas preferenciais) — Usa equipa_preferencial (array) para dar
  // prioridade máxima absoluta a quem pertence à equipa. Mantém o
  // funcionario_preferencial_id (legacy) como fallback individual.
  // FIX (prioridade equipa) — Se o VIP exceder o SLA por ter tarefas futuras
  // atribuídas, o sistema desatribui a tarefa futura mais distante desse VIP
  // (coloca 'por_atribuir') para libertar capacidade, e tenta novamente.
  // ----------------------------------------------------------------
  if (propriedadeId) {
    const propVIP = await Propriedade.findById(propriedadeId)
      .select('funcionario_preferencial_id equipa_preferencial')
      .lean();

    // FIX (equipas preferenciais) — Tenta cada membro da equipa_preferencial
    // (prioridade máxima absoluta). Se nenhum estiver disponível, faz fallback
    // para o funcionario_preferencial_id (legacy) e depois para o LB geral.
    const equipaIds = propVIP?.equipa_preferencial || [];
    if (equipaIds.length > 0) {
      for (const equipaId of equipaIds) {
        const equipaIdStr = String(equipaId);
        const vip = disponiveis.find((s) => String(s._id) === equipaIdStr);
        if (vip) {
          let cabeVIP = await cabeNoHorario(vip._id, range, coordenadasNovaPropriedade, tempoNovaTarefa, propriedadeId);

          // FIX (prioridade equipa) — Se o VIP não cabe no horário, tenta libertar
          // capacidade desatribuindo a tarefa futura mais distante desse VIP.
          // Isto garante que a equipa preferencial é priorizada mesmo que
          // tenha tarefas futuras que possam ser reatribuídas a outro staff.
          if (!cabeVIP) {
            console.log(
              `⭐ VIP (equipa): ${equipaIdStr} não cabe no horário. A tentar libertar capacidade...`
            );
            // Procura a tarefa futura mais distante do VIP (maior data) que
            // não seja a tarefa atual e que esteja 'atribuida' ou 'em_curso'.
            const tarefaParaLibertar = await Tarefa.findOne(comMembro({
              empresa_id: empresaId,
              // Só liberta uma tarefa do MESMO dia e ainda não iniciada: libertar outro
              // dia não reduz a carga deste e libertar 'em_curso' tira trabalho a quem já está a fazê-lo.
              data: { $gte: range.start, $lt: range.end },
              estado: 'atribuida',
            }, vip._id)).sort({ data: -1 });

            if (tarefaParaLibertar) {
              // Sai só o VIP; se a equipa ficar vazia a tarefa volta a 'por_atribuir'.
              const vazia = retirarMembroDoc(tarefaParaLibertar, vip._id);
              if (vazia) tarefaParaLibertar.motivo_nao_atribuicao = 'Desatribuída para libertar equipa preferencial';
              await tarefaParaLibertar.save();
              console.log(
                `⭐ VIP (equipa): tarefa ${tarefaParaLibertar._id} desatribuída do VIP ${equipaIdStr} para libertar capacidade.`
              );
              // Volta a verificar (a tarefa libertada já não conta).
              cabeVIP = await cabeNoHorario(vip._id, range, coordenadasNovaPropriedade, tempoNovaTarefa, propriedadeId);
            }
          }

          if (cabeVIP) {
            console.log(`⭐ VIP (equipa): tarefa atribuída ao preferencial ${equipaIdStr} (cabe no horário).`);
            return { utilizadorId: vip._id, tempoViagem: 0 };
          }
        }
      }
      console.log(
        `⭐ VIP (equipa): ${equipaIds.length} preferencial(is) — nenhum disponível ou dentro do SLA. Fallback para LB.`
      );
    }

    // Fallback legacy: funcionario_preferencial_id (individual).
    const vipId = propVIP?.funcionario_preferencial_id;
    if (vipId) {
      const vipIdStr = String(vipId);
      const vip = disponiveis.find((s) => String(s._id) === vipIdStr);
      if (vip) {
        if (await cabeNoHorario(vip._id, range, coordenadasNovaPropriedade, tempoNovaTarefa, propriedadeId)) {
          console.log(`⭐ VIP (legacy): tarefa atribuída ao preferencial ${vipIdStr} (cabe no horário).`);
          return { utilizadorId: vip._id, tempoViagem: 0 };
        }
        console.log(`⭐ VIP (legacy): preferencial ${vipIdStr} não cabe no horário — fallback para LB.`);
      }
    }
  }

  // ----------------------------------------------------------------
  // HF16 — Load Balancer geral com 4 fatores de scoring.
  // ----------------------------------------------------------------
  const disponiveisIds = disponiveis.map((s) => s._id);

  // Para cada staff, calcula os 4 fatores e o score final.
  const candidatos = [];

  for (const u of disponiveis) {
    // Janela do dia: início, fim, almoço e viagens (horario.js). Quem não cabe
    // fica de fora; o início mais cedo vem do mesmo cálculo.
    let resultadoScheduler;
    try {
      resultadoScheduler = await calcularInicioTarefaUtilizador(
        u._id, range.start, coordenadasNovaPropriedade, Number(tempoNovaTarefa) || 45, null, propriedadeId
      );
    } catch (err) {
      console.warn(`⚠️  scheduler falhou para staff ${u._id}: ${err.message} — excluído.`);
      continue;
    }
    if (!resultadoScheduler.cabe) {
      console.log(`⚠️  Horário: staff ${u._id} não tem lugar neste dia (${resultadoScheduler.motivo}) — excluído.`);
      continue;
    }
    const earliestStart = resultadoScheduler.data;
    const tempoViagem = Number(resultadoScheduler.tempoViagem) || 0;
    const origemViagem = 'maps';

    // FATOR 1: Agrupamento Diário (Same-Day Clustering).
    const jaNaPropriedade = propriedadeId
      ? await temTarefaNaMesmaPropriedade(u._id, propriedadeId, range)
      : false;
    const bonusClustering = jaNaPropriedade ? PESO_CLUSTERING : 0;

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
    const minutosDesdeMeiaNoite = minutosLocais(earliestStart);

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
      '⚠️  determinarUtilizadorAtribuido: nenhum staff coube no horário do dia.'
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

/**
 * HF21 — Determina uma EQUIPA de N utilizadores para uma tarefa.
 *
 * Se a propriedade exige staff_necessario > 1, esta função usa o mesmo
 * sistema de score do determinarUtilizadorAtribuido mas devolve os Top N
 * candidatos em vez de apenas o vencedor #1.
 *
 * Estratégia:
 *   1. Calcula o score para todos os staff disponíveis (igual ao HF16).
 *   2. Ordena por score (menor = melhor).
 *   3. Devolve os Top N (onde N = numStaffNecessario).
 *   4. Se houver menos disponíveis do que N, devolve os que estiverem +
 *      log de aviso. O caller decide se marca como 'por_atribuir' ou
 *      atribui parcialmente.
 *
 * @param {import('mongoose').Types.ObjectId} empresaId
 * @param {{start: Date, end: Date}} range
 * @param {{ lat: number, lng: number } | null} coordenadasNovaPropriedade
 * @param {number} tempoNovaTarefa
 * @param {import('mongoose').Types.ObjectId|null} propriedadeId
 * @param {number} numStaffNecessario - N de pessoas necessárias
 * @returns {Promise<{ equipa: Array<{utilizadorId, tempoViagem}>, insuficiente: boolean } | null>}
 */
async function determinarEquipaAtribuida(
  empresaId,
  range,
  coordenadasNovaPropriedade,
  tempoNovaTarefa,
  propriedadeId = null,
  numStaffNecessario = 1,
  excluirInicial = null
) {
  // `excluirInicial` (Set de ids string): pessoas que não podem entrar (ex.:
  // o ausente e os membros que já estão na tarefa).
  if (numStaffNecessario <= 1) {
    // Caso normal: 1 staff = comportamento original.
    const resultado = await determinarUtilizadorAtribuido(
      empresaId,
      range,
      coordenadasNovaPropriedade,
      tempoNovaTarefa,
      propriedadeId,
      excluirInicial instanceof Set ? excluirInicial : null
    );
    if (!resultado) return null;
    return { equipa: [resultado], insuficiente: false };
  }

  // Para N > 1: chama determinarUtilizadorAtribuido N vezes, passando um
  // Set de IDs já escolhidos (excluirStaffIds) a cada iteração. Isto garante
  // que o score é recalculado para cada staff restante (a carga muda quando
  // atribuímos a alguém) E que nunca se repete o mesmo staff.
  //
  // FIX (folgas/férias) — A exclusão é feita DENTRO de
  // determinarUtilizadorAtribuido (filtro de dias_folga + query Ausencia +
  // excluirStaffIds), pelo que a versão de equipas herda automaticamente o
  // mesmo rigor de filtragem da versão de 1 staff.

  const equipa = [];
  const staffExcluidos = new Set(excluirInicial instanceof Set ? [...excluirInicial] : []);

  for (let i = 0; i < numStaffNecessario; i++) {
    const resultado = await determinarUtilizadorAtribuido(
      empresaId,
      range,
      coordenadasNovaPropriedade,
      tempoNovaTarefa,
      propriedadeId,
      staffExcluidos // ← FIX: exclui os já escolhidos + filtra folgas/férias
    );

    if (!resultado) {
      // Não há mais staff disponível (todos os restantes estão de folga/
      // férias ou excederam o SLA). Atribuição parcial.
      console.log(
        `⚠️  [HF21] determinarEquipaAtribuida: sem staff disponível para o slot ` +
          `${i + 1}/${numStaffNecessario} (restantes de folga/férias/SLA). Atribuição parcial.`
      );
      break;
    }

    const staffIdStr = String(resultado.utilizadorId);
    staffExcluidos.add(staffIdStr);
    equipa.push(resultado);

    console.log(
      `👥 [HF21] Equipa slot ${i + 1}/${numStaffNecessario}: staff ${staffIdStr} atribuído.`
    );
  }

  const insuficiente = equipa.length < numStaffNecessario;

  if (insuficiente) {
    console.warn(
      `⚠️  [HF21] determinarEquipaAtribuida: apenas ${equipa.length}/${numStaffNecessario} ` +
        `staff disponíveis. Tarefa terá equipa parcial.`
    );
  } else {
    console.log(
      `✅ [HF21] Equipa completa: ${equipa.length} staff atribuídos para propriedade ${propriedadeId}.`
    );
  }

  return { equipa, insuficiente };
}

module.exports = {
  oid,
  calcularCargaLimpezaDia,
  cabeNoHorario,
  determinarUtilizadorAtribuido,
  determinarEquipaAtribuida,
  obterStaffDisponivel,
  // Exportados para testes:
  temTarefaNaMesmaPropriedade,
  calcularCargaSemanal,
  limpouPropriedadeOntem,
};
