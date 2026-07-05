/**
 * Web Push — configuração e helpers para notificações push nativas.
 *
 * Usa a biblioteca `web-push` que implementa o protocolo Web Push (VAPID).
 * O browser subscreve via Service Worker (PWA) e guarda a subscrição no
 * utilizador (campo `pushSubscription`). O backend envia notificações
 * chamando `enviarNotificacaoPush(subscription, payload)`.
 *
 * Variáveis de ambiente (ver .env.example):
 *   - VAPID_PUBLIC_KEY  — chave pública (partilhada com o browser)
 *   - VAPID_PRIVATE_KEY — chave privada (assina as notificações)
 *   - VAPID_SUBJECT     — mailto:admin@autocell.com
 *
 * Gerar chaves: npx web-push generate-vapid-keys
 */

const webpush = require('web-push');

let configured = false;

/**
 * Configura o web-push com as variáveis de ambiente.
 * Deve ser chamado no arranque do servidor (server.js).
 * Se as variáveis não estiverem definidas, o push fica desativado
 * (silencioso — não quebra o servidor).
 */
function configurarWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  let subject =
    process.env.VAPID_SUBJECT || 'mailto:admin@autocell.com';

  // Garante que o subject tem o prefixo mailto: (exige o web-push).
  // Se vier só o email (ex: "makigerorr@gmail.com"), adiciona o prefixo.
  if (subject && !subject.startsWith('mailto:') && !subject.startsWith('http')) {
    subject = `mailto:${subject}`;
  }

  if (!publicKey || !privateKey) {
    console.warn(
      '⚠️  Web Push não configurado: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY em falta. ' +
        'Corre `npx web-push generate-vapid-keys` e define as variáveis em .env'
    );
    configured = false;
    return;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch (err) {
    console.error('❌ Erro ao configurar VAPID:', err.message);
    configured = false;
    return;
  }
  configured = true;
  console.log('✅ Web Push configurado (VAPID).');
}

/**
 * Verifica se o Web Push está configurado (chaves VAPID presentes).
 */
function isConfigured() {
  return configured;
}

/**
 * Devolve a chave pública VAPID (para o frontend pedir a subscrição).
 * Devolve null se não estiver configurado.
 */
function getPublicKey() {
  return configured ? process.env.VAPID_PUBLIC_KEY : null;
}

/**
 * Envia uma notificação push para uma subscrição.
 *
 * @param {object} subscription — objeto PushSubscription guardado no utilizador
 * @param {object|string} payload — conteúdo da notificação (JSON serializado)
 * @returns {Promise<boolean>} true se enviada, false se falhou
 */
async function enviarNotificacaoPush(subscription, payload) {
  if (!configured) {
    return false;
  }
  if (!subscription || !subscription.endpoint) {
    return false;
  }

  const payloadStr =
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    await webpush.sendNotification(subscription, payloadStr);
    return true;
  } catch (err) {
    // 410 Gone / 404 Not Found → subscrição expirou; deve ser removida.
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn(
        '⚠️  Subscrição push expirou (410/404) — deve ser removida do utilizador.'
      );
    } else {
      console.error('❌ Erro ao enviar notificação push:', err.message);
    }
    return false;
  }
}

module.exports = {
  configurarWebPush,
  isConfigured,
  getPublicKey,
  enviarNotificacaoPush,
};
