/**
 * Localização de uma propriedade — All2gether
 *
 * Junta o geocoding ao que se grava na propriedade. Nunca mantém coordenadas
 * antigas: se a morada não for localizada, as coordenadas ficam a null (o motor
 * e o load balancer já tratam coordenadas null; a staff navega pelo texto).
 */
const { obterCoordenadas } = require('./geocoding');
const { derivarMoradaEstruturada } = require('./morada');

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

/**
 * Grava «coordenadas + texto da morada escolhido» SEM geocodificar. Reutilizável
 * por qualquer origem que já tenha as coordenadas certas: pino indicado à mão,
 * e, no futuro, uma sugestão escolhida ao escrever (Places Autocomplete).
 *
 * @param {object} propriedade documento Mongoose (é alterado, não guardado)
 * @param {{ coordenadas: {lat:number,lng:number}, precisao: 'exata'|'aproximada'|'manual',
 *           moradaLocalizada?: string|null, morada?: string }} escolha
 *        morada só é passada quando o texto muda (a estruturada é re-derivada).
 */
function gravarLocalizacaoEscolhida(propriedade, escolha) {
  if (typeof escolha.morada === 'string' && escolha.morada.trim()) {
    propriedade.morada = escolha.morada.trim();
    propriedade.morada_estruturada = derivarMoradaEstruturada(propriedade.morada);
  }
  propriedade.coordenadas = { lat: escolha.coordenadas.lat, lng: escolha.coordenadas.lng };
  propriedade.coordenadas_precisao = escolha.precisao;
  propriedade.morada_localizada = escolha.moradaLocalizada || null;
  propriedade.geocoding_tentado_em = new Date();
}

module.exports = { localizarMorada, gravarLocalizacaoEscolhida };
