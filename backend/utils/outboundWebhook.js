/**
 * Outbound Webhook — All2gether
 *
 * Serviço utilitário para envio de notificações (outgoing webhooks) do
 * All2gether para o portal central de orquestração Autocell, quando ocorrem
 * eventos críticos (ex.: relatório submetido, tarefas pendentes no Cão de
 * Guarda).
 *
 * Comunicação M2M (Server-to-Server) assíncrona com payloads leves
 * ("esparso") e assinatura HMAC-SHA256 para verificação de autenticidade.
 *
 * Fluxo:
 *   1. O caller invoca enviarEventoParaAutocell(tipoEvento, dadosPayload).
 *   2. O utilitário monta o payload base: { eventId, eventType, timestamp, data }.
 *   3. Gera a assinatura HMAC-SHA256 do corpo JSON com AUTOCELL_WEBHOOK_SECRET.
 *   4. Faz POST para AUTOCELL_WEBHOOK_URL com os cabeçalhos:
 *        Content-Type: application/json
 *        X-All2gether-Signature: <hmac_sha256_em_hex>
 *   5. O Autocell recalcula o HMAC com o MESMO segredo e compara — se bater,
 *      o webhook é autêntico e é processado; se não, é rejeitado.
 *
 * Modo degradado (dev/local):
 *   Se AUTOCELL_WEBHOOK_URL ou AUTOCELL_WEBHOOK_SECRET não estiverem
 *   definidas, a função faz apenas console.log do evento e retorna sem
 *   tentar o pedido de rede. Isto permite desenvolver localmente sem um
 *   Autocell a escutar.
 *
 * Fire-and-forget:
 *   A função é async mas os callers NÃO devem aguardar (await) — o evento
 *   é disparado em background e não deve bloquear o fluxo principal.
 *   Erros de rede são apanhados e loggados, nunca lançados.
 */

const crypto = require('crypto');

const WEBHOOK_URL = process.env.AUTOCELL_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.AUTOCELL_WEBHOOK_SECRET;

/**
 * Indica se o serviço de webhooks está configurado (ambas as env vars
 * definidas). Útil para os callers decidirem se valea a pena invocar.
 */
function webhookConfigurado() {
  return Boolean(WEBHOOK_URL && WEBHOOK_SECRET);
}

/**
 * Gera a assinatura HMAC-SHA256 do corpo JSON usando o segredo partilhado.
 *
 * @param {string} corpoJson — string JSON canónica do payload.
 * @param {string} segredo — AUTOCELL_WEBHOOK_SECRET.
 * @returns {string} assinatura em hexadecimal.
 */
function gerarAssinatura(corpoJson, segredo) {
  return crypto
    .createHmac('sha256', segredo)
    .update(corpoJson, 'utf8')
    .digest('hex');
}

/**
 * Envia um evento para o Autocell via webhook (POST assíncrono).
 *
 * @param {string} tipoEvento — ex.: 'relatorio.submetido', 'alerta.tarefas_pendentes'.
 * @param {object} dadosPayload — objeto esparso com apenas IDs críticos
 *   (ex.: { relatorio_id, empresa_id } ou { tarefas_ids, data_alvo }).
 *   Será colocado dentro do campo `data` do payload base.
 * @returns {Promise<void>} — nunca rejeita (erros são loggados, não lançados).
 *  fire-and-forget: o caller não precisa de aguardar.
 */
async function enviarEventoParaAutocell(tipoEvento, dadosPayload = {}) {
  // Modo degradado: sem config, loga e sai (não tenta rede).
  if (!webhookConfigurado()) {
    console.log(
      `📤 [Outbound Webhook] (modo dev) evento="${tipoEvento}" data=${JSON.stringify(dadosPayload)}`
    );
    return;
  }

  // Monta o payload base (esparso — só IDs críticos).
  const payload = {
    eventId: crypto.randomUUID(),
    eventType: tipoEvento,
    timestamp: new Date().toISOString(),
    data: dadosPayload,
  };

  // Serializa UMA VEZ — a assinatura e o corpo enviado têm de ser byte-idênticos.
  const corpoJson = JSON.stringify(payload);

  // Gera a assinatura HMAC-SHA256.
  const assinatura = gerarAssinatura(corpoJson, WEBHOOK_SECRET);

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-All2gether-Signature': assinatura,
      },
      body: corpoJson,
      // Timeout implícito via AbortController seria ideal em produção;
      // o fetch nativo do Node 18+ tem timeout default razoável.
    });

    if (!res.ok) {
      console.warn(
        `⚠️  [Outbound Webhook] Autocell devolveu ${res.status} ${res.statusText} para evento="${tipoEvento}" (eventId=${payload.eventId}).`
      );
      return;
    }

    console.log(
      `✅ [Outbound Webhook] evento="${tipoEvento}" enviado (eventId=${payload.eventId}, HTTP ${res.status}).`
    );
  } catch (err) {
    // Fire-and-forget: erros de rede são loggados mas não propagados.
    console.warn(
      `⚠️  [Outbound Webhook] falha ao enviar evento="${tipoEvento}" (eventId=${payload.eventId}): ${err.message}`
    );
  }
}

module.exports = {
  enviarEventoParaAutocell,
  webhookConfigurado,
  gerarAssinatura, // exportado para testes / verificação
};
