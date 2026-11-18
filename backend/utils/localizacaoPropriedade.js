/**
 * Localização de uma propriedade — All2gether
 *
 * Junta o geocoding ao que se grava na propriedade. Nunca mantém coordenadas
 * antigas: se a morada não for localizada, as coordenadas ficam a null (o motor
 * e o load balancer já tratam coordenadas null; a staff navega pelo texto).
 */
const { obterCoordenadas } = require('./geocoding');

const SEM_LOCALIZACAO = Object.freeze({
  coordenadas: { lat: null, lng: null },
  coordenadas_precisao: null,
  morada_localizada: null,
});

/**
 * @param {string} morada
 * @param {{ forcar?: boolean }} [opcoes] forcar = o gestor confirmou gravar sem localização
 * @returns {Promise<{coordenadas, coordenadas_precisao, morada_localizada, falhou: boolean}>}
 */
async function localizarMorada(morada, opcoes = {}) {
  if (opcoes.forcar || !morada || !String(morada).trim()) {
    return { ...SEM_LOCALIZACAO, coordenadas: { lat: null, lng: null }, falhou: false };
  }
  try {
    const r = await obterCoordenadas(String(morada).trim());
    if (r && typeof r.lat === 'number' && typeof r.lng === 'number') {
      return {
        coordenadas: { lat: r.lat, lng: r.lng },
        coordenadas_precisao: r.precisao === 'aproximada' ? 'aproximada' : 'exata',
        morada_localizada: r.morada_localizada || null,
        falhou: false,
      };
    }
  } catch (err) {
    console.error('⚠️  Geocoding falhou (coordenadas ficam vazias):', err.message);
  }
  return { ...SEM_LOCALIZACAO, coordenadas: { lat: null, lng: null }, falhou: true };
}

module.exports = { localizarMorada };
