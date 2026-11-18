/**
 * Pré-visualização da localização indicada à mão: interpreta o que o gestor
 * colou (coordenadas ou link do Google Maps) e sugere a morada que existe
 * nesse pino (reverse geocoding). Não grava nada.
 */
const { interpretarCoordenadasManuais, CoordenadasInvalidas } = require('../utils/coordenadasManuais');
const { moradaDoPino } = require('../utils/geocoding');
const rateLimit = require('express-rate-limit');
const { chaveGlobal } = require('../utils/limiteGlobal');

/**
 * Limite próprio da pré-visualização (gasta quota do Google): 30 por minuto por
 * utilizador (JWT verificado; sem JWT válido, por IP — mesmo padrão do limite global).
 * Em NODE_ENV=test está desligado, salvo `forcar` (testes do próprio limite).
 */
function criarLimitePrevisualizacao({ forcar = false, max = 30 } = {}) {
  const desligado = process.env.NODE_ENV === 'test' && !forcar;
  return rateLimit({
    windowMs: 60 * 1000,
    limit: desligado ? Infinity : max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Demasiadas verificações seguidas. Tenta novamente daqui a um minuto.' },
    keyGenerator: (req) => `prev:${chaveGlobal(req)}`,
    validate: { keyGeneratorIpFallback: false },
  });
}

async function previsualizarLocalizacaoManual(req, res) {
  try {
    const coords = await interpretarCoordenadasManuais(req.body && req.body.coordenadas_manuais);
    const morada = await moradaDoPino(coords.lat, coords.lng);
    return res.status(200).json({ lat: coords.lat, lng: coords.lng, morada_sugerida: morada || null });
  } catch (err) {
    if (err instanceof CoordenadasInvalidas) return res.status(400).json({ erro: err.message, codigo: err.codigo });
    console.error('❌ previsualizarLocalizacaoManual:', err.message);
    return res.status(500).json({ erro: 'Erro interno ao verificar a localização.' });
  }
}

module.exports = { previsualizarLocalizacaoManual, criarLimitePrevisualizacao };
