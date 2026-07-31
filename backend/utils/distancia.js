/**
 * Distância entre coordenadas — FisioCell
 *
 * Prompt 114 — Utilitário de cálculo de distância entre duas coordenadas
 * geográficas usando a fórmula de Haversine. Usado pelo tarefaController
 * para detetar quando um staff tem duas tarefas no mesmo dia em propriedades
 * distantes (>15km) e emitir um warning logístico ao gestor.
 */

/**
 * Raio médio da Terra em quilómetros (WGS-84).
 */
const RAIO_TERRA_KM = 6371;

/**
 * Converte graus para radianos.
 */
function paraRadianos(graus) {
  return (graus * Math.PI) / 180;
}

/**
 * Calcula a distância em quilómetros entre dois pontos (lat/lng) usando a
 * fórmula de Haversine.
 *
 *   a = sin²(Δφ/2) + cos(φ1) · cos(φ2) · sin²(Δλ/2)
 *   c = 2 · atan2(√a, √(1−a))
 *   d = R · c
 *
 * @param {{ lat: number, lng: number }} origem
 * @param {{ lat: number, lng: number }} destino
 * @returns {number} distância em km (≥ 0). Devolve 0 se alguma coordenada
 *   for inválida ou se os pontos forem o mesmo.
 */
function distanciaHaversine(origem, destino) {
  if (
    !origem || !destino ||
    typeof origem.lat !== 'number' || typeof origem.lng !== 'number' ||
    typeof destino.lat !== 'number' || typeof destino.lng !== 'number' ||
    Number.isNaN(origem.lat) || Number.isNaN(origem.lng) ||
    Number.isNaN(destino.lat) || Number.isNaN(destino.lng)
  ) {
    return 0;
  }

  const lat1 = paraRadianos(origem.lat);
  const lat2 = paraRadianos(destino.lat);
  const deltaLat = paraRadianos(destino.lat - origem.lat);
  const deltaLng = paraRadianos(destino.lng - origem.lng);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return RAIO_TERRA_KM * c;
}

module.exports = {
  distanciaHaversine,
  RAIO_TERRA_KM,
};
