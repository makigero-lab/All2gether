/**
 * Geocoding — All2gether
 *
 * Converte moradas em coordenadas (lat, lng).
 *
 * FIX (google maps integration) — Agora usa Google Maps Geocoding API se a
 * env var GOOGLE_MAPS_API_KEY estiver definida. Fallback silencioso para
 * Nominatim (OpenStreetMap) se:
 *   - GOOGLE_MAPS_API_KEY não estiver definida
 *   - A chamada à API do Google falhar (rede, quota, key inválida)
 *   - A resposta não contiver dados válidos
 *
 * Vantagens do Google Maps sobre Nominatim:
 *   - Maior precisão em moradas portuguesas (rua, número, código postal)
 *   - Sem rate limit de 1 req/segundo (Nominatim limita a 1/s)
 *   - Better coverage de códigos postais e locais
 *   - Place ID (para futuras integrações com Places API)
 *
 * Limitações do Nominatim (fallback):
 *   - Máximo 1 pedido por segundo (rate limit).
 *   - User-Agent obrigatório (identifica a aplicação).
 *   - Uso para fins não comerciais (ver política de uso do Nominatim).
 */

/**
 * Tenta obter coordenadas via Google Maps Geocoding API.
 *
 * @param {string} morada - Morada completa
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
async function obterCoordenadasGoogleMaps(morada) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(morada)}` +
      `&language=pt-PT` +
      `&region=pt` +
      `&key=${apiKey.trim()}`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      console.warn(`⚠️  Google Maps Geocoding HTTP ${res.status} para "${morada}".`);
      return null;
    }

    const data = await res.json();

    // Google devolve status: 'OK', 'ZERO_RESULTS', 'OVER_QUERY_LIMIT', etc.
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      console.warn(`⚠️  Google Maps Geocoding: status=${data.status} para "${morada}".`);
      return null;
    }

    const resultado = data.results[0];
    const { lat, lng } = resultado.geometry.location;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      console.warn(`⚠️  Google Maps Geocoding: coordenadas inválidas para "${morada}".`);
      return null;
    }

    return { lat, lng };
  } catch (err) {
    console.warn(`⚠️  Google Maps Geocoding falhou para "${morada}": ${err.message}`);
    return null;
  }
}

/**
 * Fallback: obter coordenadas via Nominatim (OpenStreetMap).
 *
 * @param {string} morada - Morada completa
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
async function obterCoordenadasNominatim(morada) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      morada
    )}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'All2gether/1.0 (all2gether.app)',
      },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      console.error('⚠️  Nominatim HTTP', res.status);
      return null;
    }

    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`⚠️  Nominatim: sem resultados para "${morada}".`);
      return null;
    }

    const resultado = data[0];
    return {
      lat: parseFloat(resultado.lat),
      lng: parseFloat(resultado.lon),
    };
  } catch (err) {
    console.error('❌ Erro no geocoding (Nominatim):', err.message);
    return null;
  }
}

/**
 * Converte uma morada em coordenadas { lat, lng }.
 *
 * FIX (google maps integration) — Prioridade:
 *   1. Google Maps Geocoding API (se GOOGLE_MAPS_API_KEY definida)
 *   2. Nominatim (fallback)
 *
 * @param {string} morada - Morada completa (ex.: "Rua das Flores 12, Lisboa")
 * @returns {Promise<{ lat: number, lng: number } | null>} - Coordenadas ou null se não encontrado.
 */
async function obterCoordenadas(morada) {
  if (!morada || !String(morada).trim()) return null;

  // 1. Tenta Google Maps primeiro (se API key configurada).
  const coordsGoogle = await obterCoordenadasGoogleMaps(morada);
  if (coordsGoogle) return coordsGoogle;

  // 2. Fallback para Nominatim.
  return obterCoordenadasNominatim(morada);
}

/**
 * FIX (google maps integration) — Verifica se o Google Maps está configurado.
 * Usado pelo frontend (via API) para saber se pode mostrar botões "Abrir no
 * Google Maps" e links de navegação.
 *
 * @returns {boolean}
 */
function googleMapsAtivo() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  return !!(apiKey && apiKey.trim());
}

module.exports = { obterCoordenadas, googleMapsAtivo };
