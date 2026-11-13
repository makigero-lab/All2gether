/**
 * Cifra do link do calendário em repouso (AES-256-GCM) — All2gether.
 *
 * O link do calendário (Airbnb, Booking...) é uma credencial do proprietário: quem o tiver lê o calendário
 * sem autenticação. Por isso guarda-se SÓ cifrado e a chave vive só em variáveis de ambiente:
 *   ICAL_CHAVES        1:<32 bytes em base64>[,2:<...>]   (várias chaves, para rodar)
 *   ICAL_CHAVE_ATUAL   id da chave usada para cifrar (ex.: 1)
 *   ICAL_HMAC_CHAVE    chave separada para o HMAC (comparar links e pseudonimizar códigos), ≥ 32 caracteres
 * Sem estas variáveis a funcionalidade fica desligada (nunca se guarda em claro).
 *
 * Formato do texto cifrado: v1:<id_chave>:<iv>:<tag>:<cifra>, tudo em base64url. O AAD é o id da fonte:
 * um texto cifrado copiado para outra fonte não decifra.
 */
const crypto = require('crypto');

const PREFIXO = 'v1';

/** Lê as chaves do ambiente: Map(id -> Buffer 32 bytes). Chaves inválidas são ignoradas. */
function lerChaves(env = process.env) {
  const mapa = new Map();
  for (const par of String(env.ICAL_CHAVES || '').split(',')) {
    const i = par.indexOf(':');
    if (i < 1) continue;
    const id = par.slice(0, i).trim();
    const buf = Buffer.from(par.slice(i + 1).trim(), 'base64');
    if (/^[A-Za-z0-9_-]{1,16}$/.test(id) && buf.length === 32) mapa.set(id, buf);
  }
  return mapa;
}

/** true se a cifra e o HMAC estão configurados (a funcionalidade só funciona assim). */
function chavesConfiguradas(env = process.env) {
  const chaves = lerChaves(env);
  const atual = String(env.ICAL_CHAVE_ATUAL || '').trim();
  const hmac = String(env.ICAL_HMAC_CHAVE || '');
  return chaves.has(atual) && hmac.length >= 32;
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const deB64 = (s) => Buffer.from(String(s), 'base64url');

function cifrar(texto, aad, env = process.env) {
  if (!chavesConfiguradas(env)) throw new Error('Cifra não configurada.');
  const id = String(env.ICAL_CHAVE_ATUAL).trim();
  const chave = lerChaves(env).get(id);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  c.setAAD(Buffer.from(String(aad)));
  const cifra = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [PREFIXO, id, b64(iv), b64(c.getAuthTag()), b64(cifra)].join(':');
}

/** Decifra com a chave indicada no prefixo. Lança se a chave não existe, o AAD é outro ou foi adulterado. */
function decifrar(token, aad, env = process.env) {
  const p = String(token || '').split(':');
  if (p.length !== 5 || p[0] !== PREFIXO) throw new Error('Texto cifrado inválido.');
  const chave = lerChaves(env).get(p[1]);
  if (!chave) throw new Error('Chave de cifra desconhecida.');
  const d = crypto.createDecipheriv('aes-256-gcm', chave, deB64(p[2]));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(deB64(p[3]));
  return Buffer.concat([d.update(deB64(p[4])), d.final()]).toString('utf8');
}

/** HMAC-SHA256 (hex) com a chave própria. */
function hmac(texto, env = process.env) {
  const k = String(env.ICAL_HMAC_CHAVE || '');
  if (k.length < 32) throw new Error('HMAC não configurado.');
  return crypto.createHmac('sha256', k).update(String(texto)).digest('hex');
}

/** Id da chave com que um texto cifrado foi feito (para a rotação). */
const idChaveDe = (token) => String(token || '').split(':')[1] || null;

/** Troca qualquer link por [url] (os erros e os registos nunca levam o link). */
const semUrl = (t) => String(t == null ? '' : t).replace(/https?:\/\/\S+/gi, '[url]');

/** Gera um par de chaves novas (para o script e a documentação). */
function gerarChaves() {
  return {
    ICAL_CHAVES: `1:${crypto.randomBytes(32).toString('base64')}`,
    ICAL_CHAVE_ATUAL: '1',
    ICAL_HMAC_CHAVE: crypto.randomBytes(32).toString('base64'),
  };
}

module.exports = { chavesConfiguradas, cifrar, decifrar, hmac, idChaveDe, semUrl, lerChaves, gerarChaves };
