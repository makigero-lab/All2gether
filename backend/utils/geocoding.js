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
 */
const { derivarMoradaEstruturada, expandirAbreviaturas, semCodigoPostal } = require('./morada');

const PAUSA_NOMINATIM_MS = 1100;
const UA = 'All2gether/1.0 (all2gether.app)';
const STATUS_GRAVES = new Set(['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'INVALID_REQUEST', 'UNKNOWN_ERROR']);

const esperarPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

async function obterCoordenadasGoogleMaps(morada) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(morada)}&language=pt-PT&region=pt&key=${apiKey.trim()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`❌ Google Geocoding HTTP ${res.status} para "${morada}".`);
      return null;
    }
    const data = await res.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      const msg = `Google Geocoding status=${data.status}${data.error_message ? ` (${data.error_message})` : ''} para "${morada}".`;
      if (STATUS_GRAVES.has(data.status)) console.error(`❌ ${msg} A chave GOOGLE_MAPS_API_KEY pode estar inválida ou sem permissões.`);
      else console.warn(`⚠️  ${msg}`);
      return null;
    }
    const r = data.results[0];
    const { lat, lng } = (r.geometry && r.geometry.location) || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const aprox = r.partial_match === true || (r.geometry && r.geometry.location_type === 'APPROXIMATE');
    return { lat, lng, precisao: aprox ? 'aproximada' : 'exata', morada_localizada: r.formatted_address || null };
  } catch (err) {
    console.error(`❌ Google Geocoding falhou para "${morada}": ${err.message}`);
    return null;
  }
}

/** Uma pesquisa ao Nominatim; params é um objeto de query. */
async function pesquisarNominatim(params) {
  const qs = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'pt', ...params });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs.toString()}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('⚠️  Nominatim HTTP', res.status);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng, morada_localizada: data[0].display_name || null };
  } catch (err) {
    console.error('❌ Erro no geocoding (Nominatim):', err.message);
    return null;
  }
}

/** Variantes de pesquisa, por ordem de preferência (sem repetidas). */
function variantesNominatim(morada) {
  const original = String(morada).replace(/\s+/g, ' ').trim();
  const expandida = expandirAbreviaturas(original);
  const e = derivarMoradaEstruturada(expandida);
  const lista = [
    { params: { q: original }, precisao: 'exata' },
    { params: { q: expandida }, precisao: 'exata' },
    { params: { q: semCodigoPostal(expandida) }, precisao: 'exata' },
  ];
  if (e.rua) {
    lista.push({
      params: { street: e.rua, ...(e.cidade ? { city: e.cidade } : {}), ...(e.codigo_postal ? { postalcode: e.codigo_postal } : {}) },
      precisao: 'exata',
    });
  }
  if (e.codigo_postal) {
    lista.push({ params: { q: [e.codigo_postal, e.cidade].filter(Boolean).join(' ') }, precisao: 'aproximada' });
  }
  const vistos = new Set();
  return lista.filter((v) => {
    const chave = JSON.stringify(v.params);
    if (!Object.values(v.params).every((x) => String(x || '').trim()) || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

async function obterCoordenadasNominatim(morada, esperar = esperarPadrao) {
  let primeira = true;
  for (const v of variantesNominatim(morada)) {
    if (!primeira) await esperar(PAUSA_NOMINATIM_MS);
    primeira = false;
    const r = await pesquisarNominatim(v.params);
    if (r) return { ...r, precisao: v.precisao };
  }
  console.warn(`⚠️  Nominatim: sem resultados para "${morada}" (todas as variantes).`);
  return null;
}

/**
 * @param {string} morada
 * @param {{ esperar?: (ms:number)=>Promise<void> }} [opcoes] relógio injetável (testes)
 * @returns {Promise<{lat:number,lng:number,precisao:'exata'|'aproximada',morada_localizada:string|null}|null>}
 */
async function obterCoordenadas(morada, opcoes = {}) {
  if (!morada || !String(morada).trim()) return null;
  const g = await obterCoordenadasGoogleMaps(morada);
  if (g) return g;
  return obterCoordenadasNominatim(morada, opcoes.esperar);
}

function googleMapsAtivo() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  return !!(apiKey && apiKey.trim());
}

module.exports = { obterCoordenadas, googleMapsAtivo, variantesNominatim };
