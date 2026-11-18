/**
 * Geocoding — All2gether
 *
 * Converte uma morada (texto único) em coordenadas. Devolve
 *   { lat, lng, precisao: 'exata' | 'aproximada', morada_localizada }
 * ou null se não localizou.
 *
 * 1. Google Maps Geocoding (se GOOGLE_MAPS_API_KEY existir). O `status` é
 *    registado de forma visível (REQUEST_DENIED, OVER_QUERY_LIMIT...).
 * 2. Nominatim (countrycodes=pt), por ordem, até uma variante dar:
 *      (1) morada tal como está; (2) abreviaturas expandidas;
 *      (3) sem código postal; (4) pesquisa estruturada;
 *      (5) só código postal + cidade (ÚLTIMO recurso, 'aproximada').
 *    Respeita 1 pedido/s entre tentativas.
 *
 * Orçamento: cada morada tem um tempo total máximo (por defeito 8 s); os
 * timeouts por pedido encurtam quando o orçamento aperta e não se começam
 * tentativas que já não cabem. Com { rapido: true } (importação em massa)
 * só se usa o Google + a morada tal como está + abreviaturas expandidas.
 */
const { logSeguro } = require('./segredos');
const { derivarMoradaEstruturada, expandirAbreviaturas, semCodigoPostal } = require('./morada');

const PAUSA_NOMINATIM_MS = 1100;
const ORCAMENTO_MS = 8000;
const TIMEOUT_PEDIDO_MS = 5000;
const MINIMO_PEDIDO_MS = 800;
const UA = 'All2gether/1.0 (all2gether.app)';
const STATUS_GRAVES = new Set(['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'INVALID_REQUEST', 'UNKNOWN_ERROR']);

const esperarPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

async function obterCoordenadasGoogleMaps(morada, timeoutMs = TIMEOUT_PEDIDO_MS, estado = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(morada)}&language=pt-PT&region=pt&key=${apiKey.trim()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logSeguro.error(`❌ Google Geocoding HTTP ${res.status} para "${morada}".`);
      return null;
    }
    const data = await res.json();
    estado.status = data.status;
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      const msg = `Google Geocoding status=${data.status}${data.error_message ? ` (${data.error_message})` : ''} para "${morada}".`;
      if (STATUS_GRAVES.has(data.status)) logSeguro.error(`❌ ${msg} A chave GOOGLE_MAPS_API_KEY pode estar inválida ou sem permissões.`);
      else logSeguro.warn(`⚠️  ${msg}`);
      return null;
    }
    const r = data.results[0];
    const { lat, lng } = (r.geometry && r.geometry.location) || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    // ROOFTOP = exata; partial_match, APPROXIMATE, GEOMETRIC_CENTER, RANGE_INTERPOLATED = aproximada.
    const aprox = r.partial_match === true || !(r.geometry && r.geometry.location_type === 'ROOFTOP');
    return { lat, lng, precisao: aprox ? 'aproximada' : 'exata', morada_localizada: r.formatted_address || null };
  } catch (err) {
    logSeguro.error(`❌ Google Geocoding falhou para "${morada}": ${err.message}`);
    return null;
  }
}

/** Uma pesquisa ao Nominatim; params é um objeto de query. */
async function pesquisarNominatim(params, timeoutMs = TIMEOUT_PEDIDO_MS) {
  const qs = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'pt', ...params });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs.toString()}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logSeguro.error('⚠️  Nominatim HTTP', res.status);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng, morada_localizada: data[0].display_name || null };
  } catch (err) {
    logSeguro.error('❌ Erro no geocoding (Nominatim):', err.message);
    return null;
  }
}

/**
 * Variantes de pesquisa, por ordem de preferência (sem repetidas).
 * rapido: só (1) tal como está e (2) abreviaturas expandidas.
 */
function variantesNominatim(morada, { rapido = false } = {}) {
  const original = String(morada).replace(/\s+/g, ' ').trim();
  const expandida = expandirAbreviaturas(original);
  const e = derivarMoradaEstruturada(expandida);
  const lista = [
    { params: { q: original }, precisao: 'exata' },
    { params: { q: expandida }, precisao: 'exata' },
  ];
  if (!rapido) {
    lista.push({ params: { q: semCodigoPostal(expandida) }, precisao: 'exata' });
    if (e.rua) {
      lista.push({
        params: { street: e.rua, ...(e.cidade ? { city: e.cidade } : {}), ...(e.codigo_postal ? { postalcode: e.codigo_postal } : {}) },
        precisao: 'exata',
      });
    }
    if (e.codigo_postal) {
      lista.push({ params: { q: [e.codigo_postal, e.cidade].filter(Boolean).join(' ') }, precisao: 'aproximada' });
    }
  }
  const vistos = new Set();
  return lista.filter((v) => {
    const chave = JSON.stringify(v.params);
    if (!Object.values(v.params).every((x) => String(x || '').trim()) || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

async function obterCoordenadasNominatim(morada, { esperar, rapido, restante }) {
  let primeira = true;
  for (const v of variantesNominatim(morada, { rapido })) {
    if (!primeira) {
      // Já não cabe pausa + um pedido útil no orçamento: desiste.
      if (restante() < PAUSA_NOMINATIM_MS + MINIMO_PEDIDO_MS) break;
      await esperar(PAUSA_NOMINATIM_MS);
    }
    primeira = false;
    const tempo = Math.min(TIMEOUT_PEDIDO_MS, restante());
    if (tempo < MINIMO_PEDIDO_MS) break;
    const r = await pesquisarNominatim(v.params, tempo);
    if (r) return { ...r, precisao: v.precisao };
  }
  logSeguro.warn(`⚠️  Nominatim: sem resultados para "${morada}" (variantes tentadas dentro do orçamento).`);
  return null;
}

/**
 * @param {string} morada
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.rapido] importação em massa: Google + 2 variantes
 * @param {number} [opcoes.orcamentoMs] tempo total máximo por morada (def. 8000)
 * @param {(ms:number)=>Promise<void>} [opcoes.esperar] pausa injetável (testes)
 * @param {()=>number} [opcoes.agora] relógio injetável (testes)
 * @returns {Promise<{lat:number,lng:number,precisao:'exata'|'aproximada',morada_localizada:string|null}|null>}
 */
async function obterCoordenadas(morada, opcoes = {}) {
  if (!morada || !String(morada).trim()) return null;
  const agora = opcoes.agora || Date.now;
  const fim = agora() + (opcoes.orcamentoMs || ORCAMENTO_MS);
  const restante = () => fim - agora();

  const estadoGoogle = {};
  const g = await obterCoordenadasGoogleMaps(morada, Math.min(TIMEOUT_PEDIDO_MS, restante()), estadoGoogle);
  if (g) return g;

  // Google não conhece a morada exata (ZERO_RESULTS): tenta só «<CP> <cidade>, Portugal» (aproximada).
  if (estadoGoogle.status === 'ZERO_RESULTS' && restante() >= MINIMO_PEDIDO_MS) {
    const e = derivarMoradaEstruturada(expandirAbreviaturas(String(morada)));
    if (e.codigo_postal) {
      const ga = await obterCoordenadasGoogleMaps(
        `${[e.codigo_postal, e.cidade].filter(Boolean).join(' ')}, Portugal`,
        Math.min(TIMEOUT_PEDIDO_MS, restante())
      );
      if (ga) return { ...ga, precisao: 'aproximada' };
    }
  }
  if (restante() < MINIMO_PEDIDO_MS) return null;
  return obterCoordenadasNominatim(morada, {
    esperar: opcoes.esperar || esperarPadrao,
    rapido: opcoes.rapido === true,
    restante,
  });
}

/**
 * Reverse geocoding: a morada «neste pino». Google (latlng, pt-PT) e, se falhar,
 * Nominatim /reverse. Respeita um orçamento total (def. 4 s). Devolve a morada
 * (texto) ou null; nunca lança.
 */
async function moradaDoPino(lat, lng, opcoes = {}) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const agora = opcoes.agora || Date.now;
  const fim = agora() + (opcoes.orcamentoMs || 4000);
  const restante = () => fim - agora();

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (apiKey && apiKey.trim() && restante() >= MINIMO_PEDIDO_MS) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=pt-PT&key=${apiKey.trim()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(3000, restante())) });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'OK' && Array.isArray(data.results) && data.results[0] && data.results[0].formatted_address) {
          return String(data.results[0].formatted_address);
        }
        const msg = `Google reverse geocoding status=${data.status}${data.error_message ? ` (${data.error_message})` : ''}.`;
        if (STATUS_GRAVES.has(data.status)) logSeguro.error(`❌ ${msg}`); else logSeguro.warn(`⚠️  ${msg}`);
      } else {
        logSeguro.error(`❌ Google reverse geocoding HTTP ${res.status}.`);
      }
    } catch (err) {
      logSeguro.error(`❌ Google reverse geocoding falhou: ${err.message}`);
    }
  }
  if (restante() < MINIMO_PEDIDO_MS) return null;
  try {
    const qs = new URLSearchParams({ format: 'json', lat: String(lat), lon: String(lng), zoom: '18', 'accept-language': 'pt-PT' });
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${qs.toString()}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(Math.min(3000, restante())),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.display_name === 'string' && data.display_name ? data.display_name : null;
  } catch (err) {
    logSeguro.error('❌ Erro no reverse geocoding (Nominatim):', err.message);
    return null;
  }
}

function googleMapsAtivo() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  return !!(apiKey && apiKey.trim());
}

module.exports = { obterCoordenadas, moradaDoPino, googleMapsAtivo, variantesNominatim };
