/**
 * Helper: Notificações para utilizadores — Autocell
 *
 * Prompt 114 — Agora envia DOIS tipos de notificação:
 *   1. Push (Web Push API) — se o utilizador tiver pushSubscription ativa.
 *   2. In-app (modelo Notificacao) — guardada na BD, mostrada no sino do
 *      header com badge de não-lidas.
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
 * @param {string} utilizadorId
 * @param {string} mensagem
 * @param {{ tipo?: string, url?: string, empresa_id?: string }} [opts]
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
      lida: false,
    });
  } catch (err) {
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  criarNotificacaoInApp:', err.message);
  }
}

/**
 * Envia uma notificação a um utilizador (push + in-app).
 * Fire-and-forget: não lança erro nem bloqueia.
 *
 * @param {string} utilizadorId — ID do utilizador
 * @param {string} title — Título da notificação push (e mensagem in-app se
 *   `opts.mensagem` não for fornecido)
 * @param {string} body — Corpo da notificação push
 * @param {string} [url='/staff'] — URL para abrir ao clicar
 * @param {{ tipo?: string, mensagem?: string, empresa_id?: string }} [opts]
 *   - opts.tipo: categoria da notificação in-app
 *   - opts.mensagem: mensagem in-app (se diferente do title; por defeito
 *     usa `${title}: ${body}`)
 *   - opts.empresa_id: para auditoria/scoping da notificação
 */
async function notificarUtilizador(utilizadorId, title, body, url = '/staff', opts = {}) {
  try {
    // 1. Push (se configurado + tiver subscrição).
    if (isConfigured()) {
      const user = await Utilizador.findById(utilizadorId).select('pushSubscription empresa_id').lean();
      if (user) {
        if (user.pushSubscription) {
          try {
            await enviarNotificacaoPush(user.pushSubscription, { title, body, url });
          } catch (pushErr) {
            console.error('⚠️  push falhou:', pushErr.message);
          }
        }
        // 2. In-app — usa a empresa_id do utilizador se não vier em opts.
        const mensagemInApp = opts.mensagem || `${title}: ${body}`;
        await criarNotificacaoInApp(utilizadorId, mensagemInApp, {
          tipo: opts.tipo || 'sistema',
          url,
          empresa_id: opts.empresa_id || (user.empresa_id ? String(user.empresa_id) : null),
        });
      }
    } else {
      // Push não configurado — só cria a notificação in-app.
      const user = await Utilizador.findById(utilizadorId).select('empresa_id').lean();
      if (user) {
        const mensagemInApp = opts.mensagem || `${title}: ${body}`;
        await criarNotificacaoInApp(utilizadorId, mensagemInApp, {
          tipo: opts.tipo || 'sistema',
          url,
          empresa_id: opts.empresa_id || (user.empresa_id ? String(user.empresa_id) : null),
        });
      }
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
