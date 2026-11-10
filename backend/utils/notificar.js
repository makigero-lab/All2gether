/**
 * Helper: Notificações para utilizadores — All2gether
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
      ...(opts.chave ? { chave: String(opts.chave) } : {}),
      lida: false,
    });
    return true;
  } catch (err) {
    // Chave repetida = já foi enviada: não é erro.
    if (err && err.code === 11000 && opts.chave) return false;
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  criarNotificacaoInApp:', err.message);
    return false;
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

    // 1. In-app (OPT-IN via opts.criarInApp). Default: NÃO cria — evita inundar o sino com
    //    notificações per-task. Com `opts.chave`, a notificação é única por utilizador: se já
    //    existia, não se repete nem o push.
    if (criarInApp) {
      const mensagemInApp = opts.mensagem || `${title}: ${body}`;
      const criada = await criarNotificacaoInApp(utilizadorId, mensagemInApp, {
        tipo: opts.tipo || 'sistema',
        url,
        empresa_id: empresaId,
        tarefa_id: opts.tarefa_id || null,
        chave: opts.chave || null,
      });
      if (opts.chave && criada === false) return false;
    }

    // 2. Push (se configurado + tiver subscrição).
    if (isConfigured() && user.pushSubscription) {
      try {
        await enviarNotificacaoPush(user.pushSubscription, { title, body, url });
      } catch (pushErr) {
        console.error('⚠️  push falhou:', pushErr.message);
      }
    }
    return true;
  } catch (err) {
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  notificarUtilizador:', err.message);
  }
}

/**
 * Push + sino in-app a todos os gestores/admins ativos da empresa.
 * Best-effort: nunca lança.
 */
async function avisarGestores(empresaId, titulo, texto, url = '/gestor/calendario', opts = {}) {
  try {
    const gestores = await Utilizador.find({
      empresa_id: empresaId,
      role: { $in: ['gestor', 'admin'] },
      ativo: true,
      eliminado_em: null,
    })
      .select('_id')
      .lean();
    for (const g of gestores) {
      await notificarUtilizador(String(g._id), titulo, texto, url, {
        criarInApp: true,
        tipo: 'aviso',
        ...(opts.chave ? { chave: opts.chave } : {}),
      });
    }
  } catch (e) {
    console.error('⚠️  avisarGestores:', e.message);
  }
}

/**
 * Aviso SÓ no sino (sem push), para parceiro e lavandaria. Com `chave`, não se repete.
 * Best-effort: nunca lança. Devolve true se criou.
 */
async function notificarSino(utilizadorId, mensagem, opts = {}) {
  try {
    if (!utilizadorId) return false;
    return await criarNotificacaoInApp(String(utilizadorId), mensagem, {
      tipo: opts.tipo || 'aviso',
      url: opts.url || '/',
      empresa_id: opts.empresa_id || null,
      tarefa_id: opts.tarefa_id || null,
      chave: opts.chave || null,
    });
  } catch (e) {
    console.error('⚠️  notificarSino:', e.message);
    return false;
  }
}

module.exports = {
  notificarSino,
  avisarGestores,
  notificarUtilizador,
  criarNotificacaoInApp,
};
