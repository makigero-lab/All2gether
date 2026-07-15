/**
 * Cão de Guarda — Cron Job (Autocell)
 *
 * Prompt 96 (Fase 1.5) — "O Cão de Guarda do Final de Dia".
 * Prompt 98 (Fase 1.5) — "A Rede de Segurança das 18h" (auto-atribuição de
 *                         emergência das tarefas órfãs de amanhã).
 *
 * Todos os dias às 18:00 (fuso de Portugal/Lisboa), executa DUAS rotinas:
 *
 *   FASE A — Auto-Atribuição de Emergência (Prompt 98, ANTES dos alertas):
 *     Procura as Tarefas marcadas para o DIA SEGUINTE (amanhã) com estado
 *     'por_atribuir' (sem funcionário) e invoca o load balancer
 *     (determinarUtilizadorAtribuido) para as distribuir inteligentemente.
 *     Recalcula a hora de início via scheduler sequencial e notifica o
 *     staff (push). Assim, quando o relógio das 19:00 (Agenda de Amanhã)
 *     correr uma hora depois, os funcionários já recebem a notificação com
 *     as escalas 100% preenchidas.
 *
 *   FASE B — Alertas de Tarefas Incompletas (Prompt 96, os alertas):
 *     Procura as Tarefas de limpeza do DIA ATUAL que estejam atribuídas a
 *     uma funcionária mas ainda não concluídas (estado 'atribuida' ou
 *     'em_curso') e envia uma push a lembrar cada funcionária de fechar a
 *     tarefa na app.
 *
 * Nota sobre estados: o modelo Tarefa tem os estados
 *   ['por_atribuir','atribuida','em_curso','concluida','cancelada'].
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const { calcularInicioTarefaUtilizador } = require('../utils/scheduler');
// Nota: notificarUtilizador e determinarUtilizadorAtribuido são carregados
// via require lazy dentro das funções (e não no topo) para permitir que os
// testes façam jest.spyOn / require reInject. Se fossem importados no topo,
// a referência ficaria "fechada" (closed over) e o spy não teria efeito.

/**
 * FASE A — Auto-Atribuição de Emergência (Prompt 98).
 *
 * Procura as tarefas de AMANHÃ com estado 'por_atribuir' e invoca o load
 * balancer para as atribuir a staff disponível (com scheduler sequencial
 * + push de notificação). Devolve estatísticas.
 *
 * @returns {Promise<{encontradas: number, atribuidas: number, orfas: number}>}
 */
async function autoAtribuicaoEmergencia() {
  // 1) Calcula o intervalo do dia SEGUINTE (meia-noite UTC).
  const agora = new Date();
  const amanhaInicio = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
  );
  amanhaInicio.setUTCDate(amanhaInicio.getUTCDate() + 1);
  const amanhaFim = new Date(amanhaInicio.getTime() + 24 * 60 * 60 * 1000);

  // 2) Procura as Tarefas de amanhã por atribuir (sem utilizador).
  //    Popula propriedade_id (coordenadas + nome para o load balancer +
  //    mensagem) e empresa_id para passar ao load balancer.
  const tarefasOrfas = await Tarefa.find({
    data: { $gte: amanhaInicio, $lt: amanhaFim },
    estado: 'por_atribuir',
    utilizador_id: null,
  })
    .populate({
      path: 'propriedade_id',
      select: 'nome coordenadas',
    })
    .lean();

  if (tarefasOrfas.length === 0) {
    console.log('ℹ️  [Cão de Guarda / Fail-Safe] Sem tarefas órfãs para amanhã.');
    return { encontradas: 0, atribuidas: 0, orfas: 0 };
  }

  // 3) Importa o load balancer e o notificador (require lazy para testes).
  const { _determinarUtilizadorAtribuido: determinarUtilizadorAtribuido } = require('../controllers/webhookController');
  const { notificarUtilizador } = require('../utils/notificar');

  let atribuidas = 0;
  let orfas = 0;

  for (const tarefa of tarefasOrfas) {
    try {
      const empresaId = tarefa.empresa_id;
      // Range do dia da tarefa (meia-noite UTC a meia-noite do dia seguinte).
      const start = amanhaInicio;
      const end = amanhaFim;
      const range = { start, end };

      const coordenadas = tarefa.propriedade_id?.coordenadas ?? null;
      const tempoNovaTarefa = tarefa.tempo_limpeza_minutos || 45;
      const propriedadeId = tarefa.propriedade_id?._id ?? null;

      // Invoca o load balancer (Algoritmo VIP + Haversine + SLA 8h).
      // Prompt 138 (136 V2) — agora devolve { utilizadorId, tempoViagem } ou null.
      const resultadoLB = await determinarUtilizadorAtribuido(
        empresaId,
        range,
        coordenadas,
        tempoNovaTarefa,
        propriedadeId
      );

      const utilizadorAtribuido = resultadoLB?.utilizadorId ?? null;
      const tempoViagemLB = Number(resultadoLB?.tempoViagem) || 0;

      if (utilizadorAtribuido) {
        // Recalcula a hora de início via scheduler sequencial (respeita
        // viagem Haversine + almoço 13h-14h). Best-effort: se falhar,
        // mantém a data original.
        let novaData = tarefa.data;
        let tempoViagemScheduler = 0;
        try {
          const resultadoScheduler = await calcularInicioTarefaUtilizador(
            utilizadorAtribuido,
            start,
            coordenadas,
            tempoNovaTarefa
          );
          novaData = resultadoScheduler.data;
          tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
        } catch (errScheduler) {
          console.warn(
            `⚠️  [Fail-Safe] scheduler falhou para tarefa ${tarefa._id} (mantém data original):`,
            errScheduler.message
          );
        }

        // Prompt 138 (136 V2) — tempo de viagem final (scheduler > LB).
        const tempoViagemFinal = tempoViagemScheduler > 0 ? tempoViagemScheduler : tempoViagemLB;

        await Tarefa.updateOne(
          { _id: tarefa._id },
          {
            $set: {
              utilizador_id: utilizadorAtribuido,
              estado: 'atribuida',
              data: novaData,
              tempo_viagem_minutos: tempoViagemFinal,
            },
          }
        );

        atribuidas++;

        // Notifica o staff (fire-and-forget).
        try {
          const propNome = tarefa.propriedade_id?.nome ?? 'Propriedade';
          notificarUtilizador(
            String(utilizadorAtribuido),
            '🧹 Nova Limpeza Atribuída',
            `Foste escalado para limpar a ${propNome}.`,
            '/staff'
          );
        } catch (e) {
          // Fire-and-forget: não bloqueia.
        }
      } else {
        // Prompt 138 (136 V2) — Se há staff ativo mas não atribuiu, é SLA.
        // Marca 'nao_atribuida' para o gestor ver no painel.
        try {
          const Utilizador = require('../models/Utilizador');
          const temStaffAtivo = await Utilizador.exists({
            empresa_id: empresaId,
            role: 'staff',
            ativo: true,
            eliminado_em: null,
          });
          if (temStaffAtivo) {
            await Tarefa.updateOne(
              { _id: tarefa._id },
              { $set: { estado: 'nao_atribuida' } }
            );
          }
        } catch (e) {
          // Best-effort: se falhar, mantém por_atribuir.
        }
        orfas++;
      }
    } catch (errTarefa) {
      // Erro numa tarefa específica não aborta o lote.
      orfas++;
      console.error(
        `⚠️  [Fail-Safe] erro na tarefa ${tarefa._id}:`,
        errTarefa.message
      );
    }
  }

  console.log(
    `🤖 [Cão de Guarda / Fail-Safe] ${tarefasOrfas.length} tarefa(s) órfã(s) de amanhã: ` +
      `${atribuidas} atribuída(s), ${orfas} continuam por atribuir.`
  );

  return {
    encontradas: tarefasOrfas.length,
    atribuidas,
    orfas,
  };
}

/**
 * FASE B — Alertas de Tarefas Incompletas (Prompt 96).
 *
 * Procura as tarefas de limpeza de hoje não concluídas (atribuídas a staff
 * ativo) e envia uma push por cada tarefa esquecida.
 *
 * @returns {Promise<{encontradas: number, notificadas: number}>}
 */
async function alertasTarefasIncompletas() {
  // 1) Calcula o intervalo do dia ATUAL (meia-noite UTC).
  const agora = new Date();
  const hojeInicio = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
  );
  const hojeFim = new Date(hojeInicio.getTime() + 24 * 60 * 60 * 1000);

  // 2) Procura as Tarefas de limpeza de hoje, atribuídas e não concluídas.
  const tarefas = await Tarefa.find({
    data: { $gte: hojeInicio, $lt: hojeFim },
    tipo: 'limpeza',
    utilizador_id: { $ne: null },
    estado: { $in: ['atribuida', 'em_curso'] },
  })
    .populate({
      path: 'propriedade_id',
      select: 'nome',
    })
    .populate({
      path: 'utilizador_id',
      select: 'ativo eliminado_em',
    })
    .lean();

  if (tarefas.length === 0) {
    console.log('ℹ️  [Cão de Guarda / Alertas] Sem tarefas de limpeza incompletas hoje.');
    return { encontradas: 0, notificadas: 0 };
  }

  // 3) Para cada tarefa esquecida, envia a push à funcionária responsável.
  //    require lazy para permitir spyOn nos testes.
  //    Nota: o prompt pede uma push POR TAREFA (loop por cada tarefa
  //    esquecida), e não agrupado por utilizador — a mensagem inclui o
  //    nome da propriedade, pelo que cada push é específica.
  const { notificarUtilizador } = require('../utils/notificar');
  let notificadas = 0;

  for (const t of tarefas) {
    const u = t.utilizador_id;
    // Ignora tarefas cujo staff foi entretanto desativado/eliminado.
    if (!u || u.eliminado_em || !u.ativo) continue;

    const nomePropriedade = t.propriedade_id?.nome ?? 'propriedade';
    notificarUtilizador(
      String(u._id),
      '⚠️ Tarefa Incompleta',
      `Ainda não marcaste a limpeza da ${nomePropriedade} como concluída. Por favor, atualiza a app!`,
      '/staff',
      // Prompt 115 — Alerta de tarefa incompleta é "principal" → cria in-app.
      { criarInApp: true, tipo: 'aviso' }
    );
    notificadas++;
  }

  console.log(
    `✅ [Cão de Guarda / Alertas] ${notificadas} notificação(ões) enviada(s) ` +
      `(${tarefas.length} tarefa(s) de limpeza incompleta(s) hoje).`
  );

  return { encontradas: tarefas.length, notificadas };
}

/**
 * Executa o job "Cão de Guarda" completo (Fail-Safe + Alertas).
 *
 * Ordem (Prompt 98): a auto-atribuição de emergência corre ANTES dos
 * alertas, para que as escalas de amanhã fiquem preenchidas antes das
 * notificações.
 *
 * @returns {Promise<{failSafe: {encontradas, atribuidas, orfas}, alertas: {encontradas, notificadas}}>}
 */
async function executarCaoGuarda() {
  console.log('🐶 [Cão de Guarda] A iniciar às', new Date().toISOString());

  try {
    // FASE A — Auto-Atribuição de Emergência (Prompt 98).
    const failSafe = await autoAtribuicaoEmergencia();

    // FASE B — Alertas de Tarefas Incompletas (Prompt 96).
    const alertas = await alertasTarefasIncompletas();

    console.log(
      `🐶 [Cão de Guarda] Concluído: Fail-Safe ${failSafe.atribuidas}/${failSafe.encontradas} atribuída(s); ` +
        `Alertas ${alertas.notificadas}/${alertas.encontradas} notificada(s).`
    );

    return { failSafe, alertas };
  } catch (err) {
    console.error('❌ [Cão de Guarda] Erro:', err.message);
    return {
      failSafe: { encontradas: 0, atribuidas: 0, orfas: 0, erro: err.message },
      alertas: { encontradas: 0, notificadas: 0 },
      erro: err.message,
    };
  }
}

/**
 * Inicia o cron job.
 *
 * Agenda para todos os dias às 18:00, fuso de Portugal/Lisboa
 * (0 18 * * *, timezone 'Europe/Lisbon'). O node-cron suporta a opção
 * `timezone` nativamente, pelo que o horário é estável mesmo que o
 * servidor esteja em UTC (caso do Render) — acompanha automaticamente
 * as mudanças legais de horário de Verão/Inverno de Portugal.
 */
function iniciarCaoGuarda() {
  console.log(
    '⏰ [Cão de Guarda] Cron agendado para 18:00 (Europe/Lisbon) diariamente (0 18 * * *).'
  );

  cron.schedule(
    '0 18 * * *',
    async () => {
      await executarCaoGuarda();
    },
    { timezone: 'Europe/Lisbon' }
  );

  // Permite execução manual para teste (exporta as funções).
  return { executarCaoGuarda, autoAtribuicaoEmergencia, alertasTarefasIncompletas };
}

module.exports = {
  iniciarCaoGuarda,
  executarCaoGuarda,
  autoAtribuicaoEmergencia,
  alertasTarefasIncompletas,
};
