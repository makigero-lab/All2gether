/**
 * Helper: Notificações Push para utilizadores — Autocell
 *
 * Funções de conveniência que carregam o pushSubscription do utilizador
 * e enviam a notificação. Fire-and-forget (não bloqueia a resposta).
 */

const Utilizador = require('../models/Utilizador');
const { enviarNotificacaoPush, isConfigured } = require('./push');

/**
 * Envia uma notificação push a um utilizador (se tiver subscrição ativa).
 * Fire-and-forget: não lança erro nem bloqueia.
 *
 * @param {string} utilizadorId — ID do utilizador
 * @param {string} title — Título da notificação
 * @param {string} body — Corpo da notificação
 * @param {string} [url='/staff'] — URL para abrir ao clicar
 */
async function notificarUtilizador(utilizadorId, title, body, url = '/staff') {
  try {
    if (!isConfigured()) return;

    const user = await Utilizador.findById(utilizadorId).select('pushSubscription').lean();
    if (!user || !user.pushSubscription) return;

    await enviarNotificacaoPush(user.pushSubscription, { title, body, url });
  } catch (err) {
    // Fire-and-forget: loga mas não propaga.
    console.error('⚠️  notificarUtilizador:', err.message);
  }
}

module.exports = { notificarUtilizador };
