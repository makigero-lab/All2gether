/**
 * Localização indicada à mão — All2gether
 *
 * O gestor cola coordenadas ("38.7536, -9.2302") ou um link do Google Maps
 * (completo ou curto). Os links curtos são resolvidos NO SERVIDOR seguindo os
 * redirects à mão (máx. 5 saltos, 5 s no total), só por HTTPS e só para hosts
 * do Google conhecidos (sem SSRF: cada salto é validado antes de ser seguido).
 */

const LAT_MIN = 32;
const LAT_MAX = 42.5;
const LNG_MIN = -31.5;
const LNG_MAX = -6;
const MAX_SALTOS = 5;
const TIMEOUT_TOTAL_MS = 5000;

const HOSTS_GOOGLE = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'www.google.com',
  'google.com',
  'maps.google.com',
  'www.google.pt',
  'google.pt',
  'maps.google.pt',
]);

class CoordenadasInvalidas extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'CoordenadasInvalidas';
    this.codigo = 'COORDENADAS_INVALIDAS';
  }
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const RE_SIMPLES = new RegExp(`^\\s*${NUM}\\s*[,;]?\\s+${NUM}\\s*$|^\\s*${NUM}\\s*[,;]\\s*${NUM}\\s*$`);
// Vírgula decimal portuguesa: «38,7536, -9,2302», «38,7536 -9,2302», «38,7536; -9,2302».
const NUM_VIRGULA = '(-?\\d{1,3},\\d+)';
const RE_VIRGULA = new RegExp(`^\\s*${NUM_VIRGULA}\\s*(?:;|,|\\s)\\s*${NUM_VIRGULA}\\s*$`);
const RE_PINO = new RegExp(`!3d${NUM}!4d${NUM}`);
const RE_QUERY = new RegExp(`[?&](?:q|query|ll|center|destination)=${NUM}(?:,|%2C)\\s*${NUM}`, 'i');
const RE_ARROBA = new RegExp(`@${NUM},${NUM}`);

/** Extrai [lat, lng] (números, sem validar o intervalo) de um texto ou null. */
function extrairCoordenadas(texto) {
  if (typeof texto !== 'string') return null;
  let t = texto.trim();
  if (!t) return null;
  const simples = RE_SIMPLES.exec(t);
  if (simples) {
    const [a, b] = simples[1] !== undefined ? [simples[1], simples[2]] : [simples[3], simples[4]];
    return { lat: parseFloat(a), lng: parseFloat(b) };
  }
  const virgula = RE_VIRGULA.exec(t);
  if (virgula) return { lat: parseFloat(virgula[1].replace(',', '.')), lng: parseFloat(virgula[2].replace(',', '.')) };
  try { t = decodeURIComponent(t); } catch (_) { /* mantém o texto */ }
  for (const re of [RE_PINO, RE_QUERY, RE_ARROBA]) {
    const m = re.exec(t);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }
  return null;
}

function dentroDePortugal({ lat, lng }) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX;
}

function urlGoogleValido(texto) {
  let u;
  try { u = new URL(texto); } catch (_) { return null; }
  // Só HTTPS, sem porta explícita nem credenciais, e só hosts Google conhecidos.
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return null;
  if (!HOSTS_GOOGLE.has(u.hostname.toLowerCase())) return null;
  return u;
}

/** Segue redirects à mão (hosts Google, HTTPS, máx. 5 saltos) à procura de coordenadas. */
async function resolverLinkGoogle(url, { fetchFn = fetch, timeoutMs = TIMEOUT_TOTAL_MS } = {}) {
  const sinal = AbortSignal.timeout(timeoutMs);
  let atual = urlGoogleValido(url);
  for (let salto = 0; atual && salto <= MAX_SALTOS; salto++) {
    const coords = extrairCoordenadas(atual.href);
    if (coords) return coords;
    if (salto === MAX_SALTOS) break;
    const res = await fetchFn(atual.href, { redirect: 'manual', signal: sinal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; All2gether/1.0)' } });
    const destino = res && res.status >= 300 && res.status < 400 && res.headers && res.headers.get('location');
    if (!destino) return null;
    let proximo;
    try { proximo = new URL(destino, atual); } catch (_) { return null; }
    atual = urlGoogleValido(proximo.href);
  }
  return null;
}

/**
 * Converte o texto colado em { lat, lng } válidos em Portugal.
 * @throws {CoordenadasInvalidas} com mensagem clara em português.
 */
async function interpretarCoordenadasManuais(texto, opcoes = {}) {
  if (typeof texto !== 'string' || !texto.trim()) throw new CoordenadasInvalidas('Cola as coordenadas ou o link do Google Maps.');
  if (texto.length > 2000) throw new CoordenadasInvalidas('O texto colado é demasiado longo.');
  const t = texto.trim();
  const eLink = /^https?:\/\//i.test(t);
  if (eLink && !urlGoogleValido(t)) throw new CoordenadasInvalidas('Só são aceites links do Google Maps (https).');
  let coords = extrairCoordenadas(t);
  if (!coords && eLink) {
    try {
      coords = await resolverLinkGoogle(t, opcoes);
    } catch (_) {
      throw new CoordenadasInvalidas('Não foi possível abrir o link. Cola antes as coordenadas (ex.: 38.7536, -9.2302).');
    }
  }
  if (!coords) throw new CoordenadasInvalidas('Não encontrei coordenadas. Usa o formato 38.7536, -9.2302 (com ponto decimal) ou um link do Google Maps.');
  if (!dentroDePortugal(coords)) {
    throw new CoordenadasInvalidas('Estas coordenadas ficam fora de Portugal (latitude 32 a 42,5; longitude -31,5 a -6). Confirma a ordem: primeiro a latitude, depois a longitude.');
  }
  return { lat: coords.lat, lng: coords.lng };
}

const TIPOS_EXATOS = new Set(['street_address', 'premise', 'subpremise']);

/**
 * Valida a «localização escolhida» enviada pelo ecrã depois de o gestor escolher
 * uma sugestão do Google ao escrever a morada: { lat, lng, origem: 'google_places', tipos?: string[] }.
 * Devolve a precisão: 'exata' só se o tipo do lugar for street_address/premise/subpremise.
 * @returns {{ ok: true, valor: { lat: number, lng: number, precisao: 'exata'|'aproximada' } } | { ok: false, erro: string }}
 */
function validarLocalizacaoEscolhida(v) {
  const invalida = (erro) => ({ ok: false, erro });
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalida('A localização escolhida é inválida.');
  if (v.origem !== 'google_places') return invalida('A origem da localização escolhida é inválida.');
  if (typeof v.lat !== 'number' || typeof v.lng !== 'number') return invalida('A localização escolhida tem de ter latitude e longitude numéricas.');
  if (!dentroDePortugal({ lat: v.lat, lng: v.lng })) return invalida('A localização escolhida fica fora de Portugal.');
  let tipos = [];
  if (v.tipos !== undefined) {
    if (!Array.isArray(v.tipos) || v.tipos.length > 30 || v.tipos.some((t) => typeof t !== 'string' || t.length > 60)) {
      return invalida('Os tipos do lugar escolhido são inválidos.');
    }
    tipos = v.tipos;
  }
  return { ok: true, valor: { lat: v.lat, lng: v.lng, precisao: tipos.some((t) => TIPOS_EXATOS.has(t)) ? 'exata' : 'aproximada' } };
}

module.exports = { validarLocalizacaoEscolhida, interpretarCoordenadasManuais, extrairCoordenadas, resolverLinkGoogle, dentroDePortugal, CoordenadasInvalidas, HOSTS_GOOGLE };
