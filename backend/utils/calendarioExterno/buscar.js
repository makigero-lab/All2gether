/**
 * Pedido HTTP ao calendário externo — All2gether.
 *
 * Seguro por construção: só os URL que passam em seguranca.analisarUrl, IP validado na ligação, redirecionamentos
 * manuais (até 3, cada um revalidado), corpo lido em fluxo e cortado ao limite, gzip com limite de saída e
 * tempo máximo total. O transporte é injetável: os testes nunca abrem ligações reais.
 */
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { analisarUrl, destinoPermitido, criarLookupSeguro, modoTesteAtivo } = require('./seguranca');
const { semUrl } = require('./cifra');

const LIMITES = { corpo: 2 * 1024 * 1024, descomprimido: 4 * 1024 * 1024, tempoMs: 15000, ligacaoMs: 5000, redirects: 3 };
const USER_AGENT = 'All2gether-Calendario/1.0';

class ErroFeed extends Error {
  constructor(codigo, mensagem, extra = {}) {
    super(semUrl(mensagem || codigo));
    this.codigo = codigo;
    Object.assign(this, extra);
  }
}

/** Lê um fluxo até `maxBytes` (acima disso: erro `tamanho`) e `timeoutMs` (erro `timeout`). */
function lerCorpo(fluxo, { maxBytes = LIMITES.corpo, timeoutMs = LIMITES.tempoMs } = {}) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let fim = false;
    const terminar = (fn, v) => { if (fim) return; fim = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => { terminar(reject, new ErroFeed('timeout', 'O calendário demorou demasiado a responder.')); if (fluxo.destroy) fluxo.destroy(); }, timeoutMs);
    fluxo.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        terminar(reject, new ErroFeed('tamanho', 'O calendário é demasiado grande.'));
        if (fluxo.destroy) fluxo.destroy();
        return;
      }
      partes.push(c);
    });
    fluxo.on('end', () => terminar(resolve, Buffer.concat(partes)));
    fluxo.on('error', (e) => terminar(reject, e));
    fluxo.on('close', () => { if (!fim) terminar(reject, new ErroFeed('outro', 'A ligação foi interrompida.')); });
  });
}

/** Descomprime gzip/deflate com limite de saída (contra bombas de compressão). */
function descomprimir(buf, encoding, maxSaida = LIMITES.descomprimido) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf, { maxOutputLength: maxSaida });
    if (enc.includes('deflate')) return zlib.inflateSync(buf, { maxOutputLength: maxSaida });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(e.message || ''))) throw new ErroFeed('tamanho', 'O calendário descomprimido é demasiado grande.');
    throw new ErroFeed('formato', 'O calendário veio comprimido de forma inválida.');
  }
  if (buf.length > maxSaida) throw new ErroFeed('tamanho', 'O calendário é demasiado grande.');
  return buf;
}

/** Traduz um erro de rede do Node para o nosso código. */
function codigoDeErroRede(e) {
  if (e instanceof ErroFeed) return e;
  const c = e && (e.codigoIcal || e.code);
  if (c === 'ip_bloqueado') return new ErroFeed('ip_bloqueado', 'O endereço do calendário não é permitido.');
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL'].includes(c)) return new ErroFeed('dns', 'Não foi possível encontrar o servidor do calendário.');
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'].includes(c)) return new ErroFeed('timeout', 'O calendário demorou demasiado a responder.');
  if (c && (String(c).startsWith('ERR_TLS') || String(c).startsWith('CERT_') || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/.test(String(c)))) return new ErroFeed('tls', 'O certificado do servidor do calendário não é de confiança.');
  return new ErroFeed('outro', 'Não foi possível ligar ao calendário.');
}

/** Transporte real: um pedido GET, sem seguir redirects. Devolve { status, headers, corpo, ip }. */
function pedir(url, { headers, timeoutMs = LIMITES.tempoMs, maxBytes = LIMITES.corpo, env = process.env }) {
  const teste = modoTesteAtivo(env);
  const lib = url.protocol === 'http:' && teste ? http : https;
  const lookup = criarLookupSeguro({ permitirLocal: teste });
  return new Promise((resolve, reject) => {
    let ip = null;
    const req = lib.request(url, { method: 'GET', headers, lookup, timeout: LIMITES.ligacaoMs, rejectUnauthorized: true }, (res) => {
      lerCorpo(res, { maxBytes, timeoutMs })
        .then((corpo) => resolve({ status: res.statusCode, headers: res.headers, corpo, ip }))
        .catch(reject);
    });
    req.on('socket', (s) => { s.once('connect', () => { ip = s.remoteAddress || null; }); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Lê o calendário. Devolve { status, texto, notModified, bytes, bytes_descomprimidos, redirecionamentos, ip,
 * etag, last_modified, content_type, hash_bruto }. Lança ErroFeed.
 */
async function buscarFeed(urlTexto, {
  etag = null, lastModified = null, transporte = pedir, env = process.env, timeoutMs = LIMITES.tempoMs,
} = {}) {
  let a = analisarUrl(urlTexto, { env });
  if (!a.ok) throw new ErroFeed(a.codigo === 'dominio' ? 'redirect_invalido' : 'formato', a.erro);
  const canalOriginal = a.canal;
  let url = a.url;
  let redirecionamentos = 0;
  const limite = Date.now() + timeoutMs;

  for (;;) {
    const restante = limite - Date.now();
    if (restante <= 0) throw new ErroFeed('timeout', 'O calendário demorou demasiado a responder.');
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
      'Accept-Encoding': 'gzip',
      ...(redirecionamentos === 0 && etag ? { 'If-None-Match': etag } : {}),
      ...(redirecionamentos === 0 && lastModified ? { 'If-Modified-Since': lastModified } : {}),
    };
    let r;
    try {
      r = await transporte(url, { headers, timeoutMs: restante, maxBytes: LIMITES.corpo, env });
    } catch (e) {
      throw codigoDeErroRede(e);
    }
    const st = r.status;
    if ([301, 302, 303, 307, 308].includes(st)) {
      const loc = r.headers && r.headers.location;
      if (!loc) throw new ErroFeed('redirect_invalido', 'O calendário redirecionou sem indicar o destino.');
      if (++redirecionamentos > LIMITES.redirects) throw new ErroFeed('redirect_invalido', 'O calendário tem redirecionamentos a mais.');
      let destino;
      try { destino = new URL(loc, url); } catch { throw new ErroFeed('redirect_invalido', 'Redirecionamento inválido.'); }
      if (!destinoPermitido(destino, canalOriginal, { env })) throw new ErroFeed('redirect_invalido', 'O calendário redirecionou para um endereço não permitido.');
      url = destino;
      continue;
    }
    const base = { status: st, redirecionamentos, ip: r.ip || null, etag: (r.headers && r.headers.etag) || null,
      last_modified: (r.headers && r.headers['last-modified']) || null, content_type: String((r.headers && r.headers['content-type']) || '').slice(0, 100) };
    if (st === 304) return { ...base, notModified: true, texto: null, bytes: 0, bytes_descomprimidos: 0, hash_bruto: null };
    if (st === 404 || st === 410) throw new ErroFeed('http_404_410', 'O link do calendário deixou de funcionar.', { http_status: st });
    if (st === 429) throw new ErroFeed('http_429', 'O canal pediu para esperar antes de ler outra vez.', { http_status: st, retryAfter: Number(r.headers && r.headers['retry-after']) || null });
    if (st >= 500) throw new ErroFeed('http_5xx', 'O servidor do canal está com problemas.', { http_status: st });
    if (st !== 200) throw new ErroFeed('http_4xx', `O canal recusou o pedido (${st}).`, { http_status: st });
    const bruto = r.corpo || Buffer.alloc(0);
    const corpo = descomprimir(bruto, r.headers && r.headers['content-encoding']);
    return { ...base, notModified: false, texto: corpo.toString('utf8'), bytes: bruto.length, bytes_descomprimidos: corpo.length, hash_bruto: sha(bruto) };
  }
}

module.exports = { buscarFeed, lerCorpo, descomprimir, ErroFeed, codigoDeErroRede, LIMITES, pedir };
