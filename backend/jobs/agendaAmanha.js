/**
 * Agenda de Amanhã — Cron Job (All2gether)
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
const Propriedade = require('../models/Propriedade');
const { membrosPopulados } = require('../utils/equipaTarefa');
const H = require('../utils/horario');
const { notificarSino } = require('../utils/notificar');
const { horaLisboa } = require('../utils/cicloTarefa');
// Nota: notificarUtilizador é carregado via require lazy dentro da função
// (e não no topo) para permitir que os testes façam jest.spyOn do módulo
// 'utils/notificar' e interceptem as chamadas. Se fosse importado no topo,
// a referência ficaria "fechada" (closed over) e o spy não teria efeito.

/**
 * Aviso no sino da lavandaria: «Amanhã: N casas» (casas com limpeza amanhã, das que lhe estão
 * atribuídas). Sem push. Idempotente: a chave leva o dia, por isso reexecutar não duplica.
 */
async function avisarLavandarias(amanhaInicio, amanhaFim) {
  const dia = amanhaInicio.toISOString().slice(0, 10);
  const comLavandaria = await Propriedade.find({ fornecedor_id: { $ne: null }, ativo: true })
    .select('_id nome fornecedor_id empresa_id')
    .lean();
  if (comLavandaria.length === 0) return { avisados: 0 };
  const porId = new Map(comLavandaria.map((p) => [String(p._id), p]));
  const tarefas = await Tarefa.find({
    propriedade_id: { $in: comLavandaria.map((p) => p._id) },
    tipo: 'limpeza',
    data: { $gte: amanhaInicio, $lt: amanhaFim },
    estado: { $nin: ['cancelada'] },
  }).select('propriedade_id').lean();
  const porFornecedor = new Map();
  for (const t of tarefas) {
    const p = porId.get(String(t.propriedade_id));
    if (!p) continue;
    const f = String(p.fornecedor_id);
    if (!porFornecedor.has(f)) porFornecedor.set(f, { empresa: p.empresa_id, casas: new Map() });
    porFornecedor.get(f).casas.set(String(p._id), p.nome);
  }
  let avisados = 0;
  for (const [fornecedorId, { empresa, casas }] of porFornecedor) {
    const nomes = [...casas.values()];
    const texto = `Amanhã: ${nomes.length} ${nomes.length === 1 ? 'casa' : 'casas'} (${nomes.slice(0, 5).join(', ')}${nomes.length > 5 ? '…' : ''}).`;
    const criada = await notificarSino(fornecedorId, texto, {
      tipo: 'aviso', url: '/fornecedor/tarefas', empresa_id: empresa ? String(empresa) : null, chave: `lav_amanha:${dia}`,
    });
    if (criada) avisados++;
  }
  return { avisados };
}

/**
 * Texto do aviso da véspera: nº de tarefas + hora e casa da PRIMEIRA limpeza (a que tem hora
 * real e é mais cedo). Sem hora real (ainda por calcular), diz só a casa.
 */
function textoAgenda(tarefasUser) {
  const count = tarefasUser.length;
  const base = `Tens ${count} ${count === 1 ? 'tarefa agendada' : 'tarefas agendadas'}`;
  const ordenadas = [...tarefasUser].sort((a, b) => new Date(a.data) - new Date(b.data));
  const primeira = ordenadas.find((t) => H.temHoraReal(t.data)) || ordenadas[0];
  const casa = primeira && primeira.propriedade_id && primeira.propriedade_id.nome;
  if (!primeira || !casa) return `${base}. Entra na app para ver o itinerário`;
  const quando = H.temHoraReal(primeira.data) ? `às ${horaLisboa(primeira.data)}` : 'amanhã';
  return `${base}. A primeira é ${quando} em ${casa}. Entra na app para ver o itinerário`;
}

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

    // 1b) Lavandaria: «Amanhã: N casas» no sino (independente de haver staff atribuído).
    try {
      await avisarLavandarias(amanhaInicio, amanhaFim);
    } catch (e) {
      console.error('⚠️  [Agenda de Amanhã] lavandaria:', e.message);
    }

    // 2) Procura as Tarefas do dia seguinte com estado 'atribuida' ou
    //    'por_atribuir'. Popula o utilizador (nome + ativo + eliminado_em)
    //    para poder filtrar e agrupar.
    const tarefas = await Tarefa.find({
      data: { $gte: amanhaInicio, $lt: amanhaFim },
      estado: { $in: ['atribuida', 'por_atribuir'] },
    })
      .populate({ path: 'propriedade_id', select: 'nome' })
      .populate({
        path: 'utilizador_id',
        select: 'nome ativo eliminado_em',
      })
      .populate({
        path: 'equipa_atribuida',
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

    // Todos os membros da equipa (não só o responsável) recebem a agenda.
    for (const t of tarefas) {
      for (const u of membrosPopulados(t)) {
        // Ignora eliminados ou inativos.
        if (u.eliminado_em || !u.ativo) continue;

        const key = String(u._id);
        if (!porUtilizador.has(key)) {
          porUtilizador.set(key, { utilizador: u, tarefas: [] });
        }
        porUtilizador.get(key).tarefas.push(t);
      }
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
        textoAgenda(tarefasUser),
        '/staff',
        // Prompt 115 — Agenda de Amanhã é "principal" → cria in-app. A chave do dia impede
        // duplicados se o job correr duas vezes.
        { criarInApp: true, tipo: 'sistema', chave: `agenda_amanha:${amanhaInicio.toISOString().slice(0, 10)}` }
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

module.exports = { iniciarAgendaAmanha, executarAgendaAmanha, textoAgenda, avisarLavandarias };
