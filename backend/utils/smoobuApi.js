/**
 * Pedidos à REST API do Smoobu com assinatura HMAC-SHA256.
 *
 * Desde 31/10/2026 o Smoobu rejeita (401) os pedidos só com o header antigo `Api-Key`.
 * Cada pedido leva agora quatro headers (docs.smoobu.com/#hmac-authentication):
 *   X-API-Key, X-Timestamp (UTC ISO 8601, ±5 min), X-Nonce (UUID v4, nunca repetido)
 *   e X-Signature = base64(HMAC-SHA256(segredo, canónica)), com a canónica:
 *     MÉTODO \n caminho \n query ordenada (RFC 3986) \n timestamp \n nonce \n sha256hex(corpo) \n chave
 *
 * Sem segredo, cai no header antigo (só serve para chaves que o Smoobu ainda aceite).
 */
const crypto = require('crypto');

const BASE = 'https://login.smoobu.com';

/** RFC 3986: encodeURIComponent deixa !'()* por codificar. */
function rfc3986(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Query ordenada por nome (e por valor, se o nome repetir), já codificada. */
function queryCanonica(query = {}) {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Timestamp no formato do exemplo oficial (sem milissegundos): 2026-04-01T12:00:00Z. */
function timestampUtc(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Headers assinados de um pedido.
 * @returns {object} headers X-API-Key, X-Timestamp, X-Nonce, X-Signature
 */
function headersAssinados({ metodo, caminho, query, corpo = '', chave, segredo, agora, nonce }) {
  const ts = timestampUtc(agora);
  const n = nonce || crypto.randomUUID();
  const hashCorpo = crypto.createHash('sha256').update(corpo || '', 'utf8').digest('hex');
  const canonica = [metodo.toUpperCase(), caminho, queryCanonica(query), ts, n, hashCorpo, chave].join('\n');
  const assinatura = crypto.createHmac('sha256', segredo).update(canonica, 'utf8').digest('base64');
  return { 'X-API-Key': chave, 'X-Timestamp': ts, 'X-Nonce': n, 'X-Signature': assinatura };
}

/** Aceita `{ chave, segredo }` ou só a chave (texto). */
function normalizarCredenciais(cred) {
  if (typeof cred === 'string') return { chave: cred.trim(), segredo: '' };
  return { chave: String(cred?.chave || '').trim(), segredo: String(cred?.segredo || '').trim() };
}

/**
 * fetch à API do Smoobu.
 * @param {{chave:string, segredo?:string}|string} cred
 * @param {string} caminho ex.: '/api/reservations'
 * @param {{ metodo?: string, query?: object, corpo?: object|string, timeoutMs?: number }} [opcoes]
 * @returns {Promise<Response>}
 */
async function smoobuFetch(cred, caminho, { metodo = 'GET', query, corpo, timeoutMs = 15000 } = {}) {
  const { chave, segredo } = normalizarCredenciais(cred);
  const corpoTexto = corpo === undefined ? '' : typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  const qs = queryCanonica(query);
  const headers = { Accept: 'application/json' };
  if (corpoTexto) headers['Content-Type'] = 'application/json';
  if (segredo) {
    Object.assign(headers, headersAssinados({ metodo, caminho, query, corpo: corpoTexto, chave, segredo }));
  } else {
    headers['Api-Key'] = chave;
  }
  return fetch(`${BASE}${caminho}${qs ? '?' + qs : ''}`, {
    method: metodo,
    headers,
    ...(corpoTexto ? { body: corpoTexto } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

module.exports = { smoobuFetch, headersAssinados, queryCanonica, timestampUtc, rfc3986 };
