/**
 * Helper: Notificações para utilizadores — FisioCell
 *
 * Prompt 114 — Envia DOIS tipos de notificação:
 *   1. Push (Web Push API) — se o utilizador tiver pushSubscription ativa.
 *   2. In-app (modelo Notificacao) — guardada na BD, mostrada no sino do
 *      header com badge de não-lidas.
 *
 * Prompt 115 (fix 2) — Não inundar o sino:
 *   Antes, TODA a chamada a notificarUtilizador criava uma notificação
 *   in-app. Se o gestor atribuía 10 tarefas ou o webhook criava 20 numa
 *   noite, o sino ficava com 20+ notificações — mau UX.
 *
 *   Agora a notificação in-app é OPT-IN via `opts.criarInApp: true`. Por
 *   defeito, só é enviado o PUSH (efémero, descartável — não acumula).
 *   Reserva-se a notificação in-app para eventos "principais" que o
 *   utilizador deve ver no sino: Daily Briefing, Tarefa Incompleta,
 *   Agenda de Amanhã, Falta de Emergência, Nova Avaria, Ausência
 *   aprovada/rejeitada. Atribuições de tarefas (per-task) são push-only.
 *
 * Ambas são fire-and-forget (não bloqueiam a resposta).
 */

const Utilizador = require('../models/Utilizador');
const { enviarNotificacaoPush, isConfigured } = require('./push');

/**
 * Carrega o modelo Notificacao de forma lazy (evita problemas de ordering
 * em testes onde o mongoose pode ainda não ter o modelo registado).
 */
function getNotificacaoModel() {
  return require('../models/Notificacao');
}

/**
 * Cria um registo de notificação in-app para o utilizador (fire-and-forget).
 * Não lança erro se falhar — só loga.
 *
 * Usar diretamente para notificações "principais" que devem aparecer no sino.
 * Para notificações per-task, usar notificarUtilizador sem `criarInApp`.
 *
 * @param {string} utilizadorId
 * @param {string} mensagem
 * @param {{ tipo?: string, url?: string, empresa_id?: string, tarefa_id?: string }} [opts]
 */
async function criarNotificacaoInApp(utilizadorId, mensagem, opts = {}) {
  try {
    const Notificacao = getNotificacaoModel();
    await Notificacao.create({
      utilizador_id: utilizadorId,
      mensagem,
      tipo: opts.tipo || 'sistema',
      url: opts.url || '/staff',
      empresa_id: opts.empresa_id || null,
      tarefa_id: opts.tarefa_id || null,
      lida: false,
    });
  } catch (err) {
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  criarNotificacaoInApp:', err.message);
  }
}

/**
 * Envia uma notificação a um utilizador.
 *
 * Por defeito envia SÓ PUSH (efémero, não acumula no sino). Para criar
 * também uma notificação in-app (visível no sino), passar `opts.criarInApp: true`.
 *
 * Fire-and-forget: não lança erro nem bloqueia.
 *
 * @param {string} utilizadorId — ID do utilizador
 * @param {string} title — Título da notificação push
 * @param {string} body — Corpo da notificação push
 * @param {string} [url='/staff'] — URL para abrir ao clicar
 * @param {{ tipo?: string, mensagem?: string, empresa_id?: string, criarInApp?: boolean }} [opts]
 *   - opts.tipo: categoria da notificação in-app (só relevante se criarInApp)
 *   - opts.mensagem: mensagem in-app (se diferente de `${title}: ${body}`)
 *   - opts.empresa_id: para auditoria/scoping da notificação
 *   - opts.criarInApp: se true, cria também registo in-app (sino). Default false.
 */
async function notificarUtilizador(utilizadorId, title, body, url = '/staff', opts = {}) {
  try {
    const criarInApp = opts.criarInApp === true;

    // Carrega o user uma vez (precisamos da pushSubscription e/ou empresa_id).
    const user = await Utilizador.findById(utilizadorId)
      .select('pushSubscription empresa_id')
      .lean();
    if (!user) return;

    const empresaId = opts.empresa_id || (user.empresa_id ? String(user.empresa_id) : null);

    // 1. Push (se configurado + tiver subscrição).
    if (isConfigured() && user.pushSubscription) {
      try {
        await enviarNotificacaoPush(user.pushSubscription, { title, body, url });
      } catch (pushErr) {
        console.error('⚠️  push falhou:', pushErr.message);
      }
    }

    // 2. In-app (OPT-IN via opts.criarInApp). Default: NÃO cria — evita
    //    inundar o sino com notificações per-task. Só para eventos principais.
    if (criarInApp) {
      const mensagemInApp = opts.mensagem || `${title}: ${body}`;
      await criarNotificacaoInApp(utilizadorId, mensagemInApp, {
        tipo: opts.tipo || 'sistema',
        url,
        empresa_id: empresaId,
        tarefa_id: opts.tarefa_id || null,
      });
    }
  } catch (err) {
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  notificarUtilizador:', err.message);
  }
}

module.exports = {
  notificarUtilizador,
  criarNotificacaoInApp,
};
