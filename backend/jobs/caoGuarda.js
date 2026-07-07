/**
 * Cão de Guarda — Cron Job (Autocell)
 *
 * Prompt 96 (Fase 1.5) — "O Cão de Guarda do Final de Dia".
 *
 * Todos os dias às 18:00 (fuso de Portugal/Lisboa), procura as tarefas de
 * limpeza do DIA ATUAL que estejam atribuídas a uma funcionária mas ainda
 * não concluídas (estado 'atribuida' ou 'em_curso'), e envia uma push a
 * lembrar cada funcionária de fechar a tarefa na app.
 *
 * Fluxo:
 *   1. Calcula o intervalo do dia ATUAL [início, fim] (UTC meia-noite).
 *   2. Procura todas as Tarefas de tipo 'limpeza' do dia atual, com
 *      utilizador_id atribuído e estado 'atribuida' ou 'em_curso'
 *      (i.e. não concluídas nem canceladas). Faz populate de propriedade_id
 *      (nome) e utilizador_id (ativo, eliminado_em).
 *   3. Para cada tarefa "esquecida", chama notificarUtilizador com a push:
 *        Título: '⚠️ Tarefa Incompleta'
 *        Corpo:  'Ainda não marcaste a limpeza da [nome da propriedade]
 *                 como concluída. Por favor, atualiza a app!'
 *        Link:   '/staff'
 *      (notificarUtilizador valida internamente se há pushSubscription
 *      ativa — skip silencioso caso contrário.)
 *
 * Nota sobre estados: o modelo Tarefa tem os estados
 *   ['por_atribuir','atribuida','em_curso','concluida','cancelada'].
 * Não existe 'pendente' — o equivalente é 'atribuida' (atribuída mas ainda
 * não iniciada). O prompt pede 'pendente' ou 'em_curso', pelo que usamos
 * ['atribuida', 'em_curso'] (= atribuídas + não concluídas).
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
// Nota: notificarUtilizador é carregado via require lazy dentro da função
// (e não no topo) para permitir que os testes façam jest.spyOn do módulo
// 'utils/notificar' e interceptem as chamadas. Se fosse importado no topo,
// a referência ficaria "fechada" (closed over) e o spy não teria efeito.

/**
 * Executa o job "Cão de Guarda".
 *
 * Procura as tarefas de limpeza de hoje não concluídas (atribuídas a staff
 * ativo) e envia uma push por cada tarefa esquecida.
 *
 * @returns {Promise<{encontradas: number, notificadas: number}>}
 *          Estatísticas (úteis para testes/logs).
 */
async function executarCaoGuarda() {
  console.log('🐶 [Cão de Guarda] A iniciar às', new Date().toISOString());

  try {
    // 1) Calcula o intervalo do dia ATUAL (meia-noite UTC).
    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const hojeFim = new Date(hojeInicio.getTime() + 24 * 60 * 60 * 1000);

    // 2) Procura as Tarefas de limpeza de hoje, atribuídas e não concluídas.
    //    Popula propriedade_id (nome para a mensagem) e utilizador_id
    //    (ativo + eliminado_em para filtrar).
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
      console.log('ℹ️  [Cão de Guarda] Sem tarefas de limpeza incompletas hoje.');
      return { encontradas: 0, notificadas: 0 };
    }

    // 3) Para cada tarefa esquecida, envia a push à funcionária responsável.
    //    require lazy para permitir spyOn nos testes (ver nota no topo).
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
      // notificarUtilizador valida internamente se há pushSubscription ativa
      // (skip silencioso caso contrário) e se o Web Push está configurado.
      notificarUtilizador(
        String(u._id),
        '⚠️ Tarefa Incompleta',
        `Ainda não marcaste a limpeza da ${nomePropriedade} como concluída. Por favor, atualiza a app!`,
        '/staff'
      );
      notificadas++;
    }

    console.log(
      `✅ [Cão de Guarda] Concluído: ${notificadas} notificação(ões) enviada(s) ` +
        `(${tarefas.length} tarefa(s) de limpeza incompleta(s) hoje).`
    );

    return { encontradas: tarefas.length, notificadas };
  } catch (err) {
    console.error('❌ [Cão de Guarda] Erro:', err.message);
    return { encontradas: 0, notificadas: 0, erro: err.message };
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

  // Permite execução manual para teste (exporta a função).
  return { executarCaoGuarda };
}

module.exports = { iniciarCaoGuarda, executarCaoGuarda };
