/**
 * Geocoding — FisioCell
 *
 * Converte moradas em coordenadas (lat, lng) usando a API gratuita do
 * Nominatim (OpenStreetMap).
 *
 * Limitações do Nominatim:
 *   - Máximo 1 pedido por segundo (rate limit).
 *   - User-Agent obrigatório (identifica a aplicação).
 *   - Uso para fins não comerciais (ver política de uso do Nominatim).
 *
 * Em produção com volume elevado, considerar migrar para Google Maps
 * Geocoding API ou Mapbox (com API key).
 */

/**
 * Converte uma morada em coordenadas { lat, lng }.
 *
 * @param {string} morada - Morada completa (ex.: "Rua das Flores 12, Lisboa")
 * @returns {Promise<{ lat: number, lng: number } | null>} - Coordenadas ou null se não encontrado.
 */
async function obterCoordenadas(morada) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      morada
    )}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'FisioCell/1.0 (fisiocell.app)',
      },
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
    console.error('❌ Erro no geocoding:', err.message);
    return null;
  }
}

module.exports = { obterCoordenadas };
