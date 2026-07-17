/**
 * Agenda de Amanhã — Cron Job (FisioCell)
 *
 * Prompt 94 (Fase 1.5) — "O Relógio das 19h".
 *
 * Todos os dias às 19:00 (fuso de Portugal/Lisboa), envia uma notificação
 * push a cada funcionário que tenha trabalho agendado para o dia seguinte,
 * com um resumo do número de tarefas.
 *
 * Fluxo:
 *   1. Calcula o intervalo do dia SEGUINTE [início, fim] (UTC meia-noite).
 *   2. Procura todas as Tarefas do dia seguinte com estado 'atribuida' ou
 *      'por_atribuir' (pendentes), fazendo populate de utilizador_id.
 *   3. Agrupa as tarefas por utilizador_id (só atribuídas a staff ativos).
 *   4. Para cada funcionário, chama notificarUtilizador com a push:
 *        '📅 Agenda de Amanhã: Tens X tarefas agendadas. Entra na app
 *         para ver o itinerário'
 *      (notificarUtilizador valida internamente se há pushSubscription
 *      ativa — skip silencioso caso contrário.)
 *
 * Nota: as tarefas 'por_atribuir' (utilizador_id = null) não geram
 * notificação (não há destinatário); só as 'atribuidas' disparam push.
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
// Nota: notificarUtilizador é carregado via require lazy dentro da função
// (e não no topo) para permitir que os testes façam jest.spyOn do módulo
// 'utils/notificar' e interceptem as chamadas. Se fosse importado no topo,
// a referência ficaria "fechada" (closed over) e o spy não teria efeito.

/**
 * Executa o job "Agenda de Amanhã".
 *
 * Procura as tarefas do dia seguinte (atribuídas ou pendentes), agrupa por
 * utilizador e envia uma push de resumo a cada staff que tenha trabalho.
 *
 * @returns {Promise<{processados: number, notificados: number, tarefas: number}>}
 *          Estatísticas (úteis para testes/logs).
 */
async function executarAgendaAmanha() {
  console.log('🔔 [Agenda de Amanhã] A iniciar às', new Date().toISOString());

  try {
    // 1) Calcula o intervalo do dia SEGUINTE (meia-noite UTC).
    const agora = new Date();
    const amanhaInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanhaInicio.setUTCDate(amanhaInicio.getUTCDate() + 1);
    const amanhaFim = new Date(amanhaInicio.getTime() + 24 * 60 * 60 * 1000);

    // 2) Procura as Tarefas do dia seguinte com estado 'atribuida' ou
    //    'por_atribuir'. Popula o utilizador (nome + ativo + eliminado_em)
    //    para poder filtrar e agrupar.
    const tarefas = await Tarefa.find({
      data: { $gte: amanhaInicio, $lt: amanhaFim },
      estado: { $in: ['atribuida', 'por_atribuir'] },
    })
      .populate({
        path: 'utilizador_id',
        select: 'nome ativo eliminado_em',
      })
      .lean();

    if (tarefas.length === 0) {
      console.log('ℹ️  [Agenda de Amanhã] Sem tarefas para amanhã.');
      return { processados: 0, notificados: 0, tarefas: 0 };
    }

    // 3) Agrupa por utilizador_id. Só interessam as tarefas atribuídas a
    //    staff ativos e não eliminados. Tarefas 'por_atribuir'
    //    (utilizador_id = null) não têm destinatário → não geram push.
    const porUtilizador = new Map();

    for (const t of tarefas) {
      const u = t.utilizador_id;
      // Ignora tarefas sem utilizador, eliminados ou inativos.
      if (!u || u.eliminado_em || !u.ativo) continue;

      const key = String(u._id);
      if (!porUtilizador.has(key)) {
        porUtilizador.set(key, { utilizador: u, tarefas: [] });
      }
      porUtilizador.get(key).tarefas.push(t);
    }

    if (porUtilizador.size === 0) {
      console.log(
        'ℹ️  [Agenda de Amanhã] Tarefas encontradas, mas sem staff ativo atribuído.'
      );
      return { processados: 0, notificados: 0, tarefas: tarefas.length };
    }

    // 4) Para cada staff, envia a push de resumo (fire-and-forget).
    //    require lazy para permitir spyOn nos testes (ver nota no topo).
    const { notificarUtilizador } = require('../utils/notificar');
    let notificados = 0;
    for (const [, { utilizador, tarefas: tarefasUser }] of porUtilizador) {
      const count = tarefasUser.length;
      // notificarUtilizador valida internamente se há pushSubscription ativa
      // (skip silencioso caso contrário) e se o Web Push está configurado.
      notificarUtilizador(
        String(utilizador._id),
        '📅 Agenda de Amanhã',
        `Tens ${count} ${count === 1 ? 'tarefa agendada' : 'tarefas agendadas'}. ` +
          `Entra na app para ver o itinerário`,
        '/staff',
        // Prompt 115 — Agenda de Amanhã é "principal" → cria in-app.
        { criarInApp: true, tipo: 'sistema' }
      );
      notificados++;
    }

    console.log(
      `✅ [Agenda de Amanhã] Concluído: ${notificados} staff notificado(s), ` +
        `${tarefas.length} tarefa(s) amanhã.`
    );

    return {
      processados: porUtilizador.size,
      notificados,
      tarefas: tarefas.length,
    };
  } catch (err) {
    console.error('❌ [Agenda de Amanhã] Erro:', err.message);
    return { processados: 0, notificados: 0, tarefas: 0, erro: err.message };
  }
}

/**
 * Inicia o cron job.
 *
 * Agenda para todos os dias às 19:00, fuso de Portugal/Lisboa
 * (0 19 * * *, timezone 'Europe/Lisbon'). O node-cron suporta a opção
 * `timezone` nativamente, pelo que o horário é estável mesmo que o
 * servidor esteja em UTC (caso do Render) — acompanha automaticamente
 * as mudanças legais de horário de Verão/Inverno de Portugal.
 */
function iniciarAgendaAmanha() {
  console.log(
    '⏰ [Agenda de Amanhã] Cron agendado para 19:00 (Europe/Lisbon) diariamente (0 19 * * *).'
  );

  cron.schedule(
    '0 19 * * *',
    async () => {
      await executarAgendaAmanha();
    },
    { timezone: 'Europe/Lisbon' }
  );

  // Permite execução manual para teste (exporta a função).
  return { executarAgendaAmanha };
}

module.exports = { iniciarAgendaAmanha, executarAgendaAmanha };
