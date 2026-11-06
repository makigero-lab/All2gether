/**
 * Cão de Guarda — Cron Job (All2gether)
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
const { membrosPopulados } = require('../utils/equipaTarefa');
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
  const { atribuirTarefaEmFalta, FILTRO_SEM_PESSOA } = require('../utils/atribuicaoAutomatica');
  // 1) Calcula o intervalo do dia SEGUINTE (meia-noite UTC).
  const agora = new Date();
  const amanhaInicio = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
  );
  amanhaInicio.setUTCDate(amanhaInicio.getUTCDate() + 1);
  const amanhaFim = new Date(amanhaInicio.getTime() + 24 * 60 * 60 * 1000);

  // 2) Procura as Tarefas de amanhã por atribuir (sem utilizador) e as que ficaram
  //    com equipa incompleta (atribuida + pessoas_em_falta > 0: só se preenche a vaga).
  //    Popula propriedade_id (coordenadas + nome + staff_necessario).
  const tarefasOrfas = await Tarefa.find({
    data: { $gte: amanhaInicio, $lt: amanhaFim },
    $or: [
      { estado: 'por_atribuir', utilizador_id: null },
      { estado: 'atribuida', pessoas_em_falta: { $gt: 0 } },
      FILTRO_SEM_PESSOA,
    ],
  })
    .populate({
      path: 'propriedade_id',
      select: 'nome coordenadas staff_necessario tempo_limpeza_minutos',
    })
    .lean();

  if (tarefasOrfas.length === 0) {
    console.log('ℹ️  [Cão de Guarda / Fail-Safe] Sem tarefas órfãs para amanhã.');
    return { encontradas: 0, atribuidas: 0, orfas: 0 };
  }

  // 3) Motor partilhado (respeita staff_necessario, scheduler e motivo real).
  //    require lazy para testes (spyOn).

  const { notificarUtilizador } = require('../utils/notificar');

  let atribuidas = 0;
  let orfas = 0;
  const semResponsavelEmCurso = [];
  const avisar = (ids, propNome) => {
    for (const id of ids) {
      try {
        notificarUtilizador(String(id), '🧹 Nova Limpeza Atribuída', `Foste escalado para limpar a ${propNome}.`, '/staff');
      } catch (e) {
        // Fire-and-forget: não bloqueia.
      }
    }
  };

  for (const tarefa of tarefasOrfas) {
    try {
      // Lógica partilhada com o preenchimento após o fim de uma ausência.
      const r = await atribuirTarefaEmFalta(tarefa, amanhaInicio);
      if (r.resultado === 'em_curso_com_trabalho') {
        // 'em_curso' sem ninguém mas já com trabalho feito: não se mexe, o gestor decide.
        orfas++;
        semResponsavelEmCurso.push(r.propNome);
      } else if (r.resultado === 'atribuida') {
        atribuidas++;
        avisar(r.novos, r.propNome);
      } else {
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
    `🤖 [Cão de Guarda / Fail-Safe] ${tarefasOrfas.length} tarefa(s) órfã(s)/incompleta(s) de amanhã: ` +
      `${atribuidas} atribuída(s), ${orfas} continuam por atribuir.` +
      (semResponsavelEmCurso.length ? ` Em curso sem responsável e com trabalho feito (não mexidas): ${semResponsavelEmCurso.join(', ')}.` : '')
  );

  return {
    encontradas: tarefasOrfas.length,
    atribuidas,
    orfas,
    emCursoSemResponsavel: semResponsavelEmCurso.length,
  };
}

/**
 * B13 — Retoma tarefas presas com o motivo «Atribuição automática em curso»
 * (a importação de Excel responde antes de acabar a atribuição em segundo plano;
 * se o servidor reiniciar nesse intervalo, ficam assim para sempre).
 * Passados `minutos` sem alteração, volta a correr o motor; sem staff, o motivo
 * passa a ser o real.
 */
async function retomarAtribuicoesPresas(minutos = 45) {
  const limite = new Date(Date.now() - minutos * 60000);
  const presas = await Tarefa.find({
    estado: 'por_atribuir',
    utilizador_id: null,
    motivo_nao_atribuicao: 'Atribuição automática em curso',
    updatedAt: { $lt: limite },
    data: { $gte: new Date(Date.now() - 24 * 3600000) },
  })
    .populate({ path: 'propriedade_id', select: 'nome coordenadas staff_necessario tempo_limpeza_minutos' })
    .lean();
  if (presas.length === 0) return { encontradas: 0, atribuidas: 0 };

  const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
  const { notificarUtilizador } = require('../utils/notificar');
  let atribuidas = 0;
  for (const t of presas) {
    try {
      const plano = await planearAtribuicao({
        empresaId: t.empresa_id,
        propriedade: t.propriedade_id || {},
        dia: t.data,
        tempoLimpeza: t.tempo_limpeza_minutos || 45,
      });
      const set = plano.estado === 'atribuida'
        ? {
            utilizador_id: plano.utilizador_id, equipa_atribuida: plano.equipa_atribuida, estado: 'atribuida',
            data: plano.data, tempo_viagem_minutos: plano.tempo_viagem_minutos, motivo_nao_atribuicao: null,
            pessoas_em_falta: plano.faltam,
          }
        : { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao || 'Sem staff disponível' };
      const r = await Tarefa.updateOne(
        { _id: t._id, estado: 'por_atribuir', motivo_nao_atribuicao: 'Atribuição automática em curso' },
        { $set: set }
      );
      if (r.modifiedCount && plano.estado === 'atribuida') {
        atribuidas++;
        for (const id of plano.equipa_atribuida) {
          notificarUtilizador(String(id), '🧹 Nova Limpeza Atribuída', `Foste escalado para limpar a ${t.propriedade_id?.nome ?? 'Propriedade'}.`, '/staff');
        }
      }
    } catch (e) {
      console.error(`⚠️  retomarAtribuicoesPresas ${t._id}:`, e.message);
    }
  }
  console.log(`🔁 [Atribuições presas] ${presas.length} encontrada(s), ${atribuidas} atribuída(s).`);
  return { encontradas: presas.length, atribuidas };
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
    .populate({
      path: 'equipa_atribuida',
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
  const { enviarEventoParaAutocell } = require('../utils/outboundWebhook');
  let notificadas = 0;
  // Acumula os IDs das tarefas pendentes que dispararam alertas, para
  // enviar um único webhook agregado ao Autocell no final.
  const tarefasIdsNotificadas = [];

  for (const t of tarefas) {
    // Ignora membros entretanto desativados/eliminados; todos os outros são avisados.
    const membros = membrosPopulados(t).filter((u) => !u.eliminado_em && u.ativo);
    if (membros.length === 0) continue;

    const nomePropriedade = t.propriedade_id?.nome ?? 'propriedade';
    for (const u of membros) {
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
    tarefasIdsNotificadas.push(String(t._id));
  }

  console.log(
    `✅ [Cão de Guarda / Alertas] ${notificadas} notificação(ões) enviada(s) ` +
      `(${tarefas.length} tarefa(s) de limpeza incompleta(s) hoje).`
  );

  // Notifica o portal Autocell das tarefas pendentes identificadas (webhook
  // agregado, fire-and-forget). Só dispara se houver pelo menos uma tarefa
  // pendente que disparou alerta — não envia webhooks "vazios".
  if (tarefasIdsNotificadas.length > 0) {
    try {
      enviarEventoParaAutocell('alerta.tarefas_pendentes', {
        tarefas_ids: tarefasIdsNotificadas,
        data_alvo: hojeInicio.toISOString(),
      });
    } catch (e) {
      // Fire-and-forget: não bloqueia o job.
    }
  }

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
    // B13 — retoma atribuições presas (antes da fase A, para as apanhar também).
    await retomarAtribuicoesPresas().catch((e) => console.error('⚠️  retomarAtribuicoesPresas:', e.message));

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

  // B13 — 2 min depois do arranque e de 30 em 30 minutos: retoma tarefas presas em
  // «Atribuição automática em curso» há mais de 45 min (a importação grande pode demorar).
  const tentar = () => retomarAtribuicoesPresas().catch((e) => console.error('⚠️  retomarAtribuicoesPresas:', e.message));
  const t0 = setTimeout(tentar, 2 * 60 * 1000);
  const t1 = setInterval(tentar, 30 * 60 * 1000);
  if (t0.unref) t0.unref();
  if (t1.unref) t1.unref();

  // Permite execução manual para teste (exporta as funções).
  return { retomarAtribuicoesPresas, executarCaoGuarda, autoAtribuicaoEmergencia, alertasTarefasIncompletas };
}

module.exports = {
  iniciarCaoGuarda,
  retomarAtribuicoesPresas,
  executarCaoGuarda,
  autoAtribuicaoEmergencia,
  alertasTarefasIncompletas,
};
