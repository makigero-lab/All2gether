/**
 * Distância entre coordenadas — All2gether
 *
 * Prompt 114 — Utilitário de cálculo de distância entre duas coordenadas
 * geográficas usando a fórmula de Haversine. Usado pelo tarefaController
 * para detetar quando um staff tem duas tarefas no mesmo dia em propriedades
 * distantes (>15km) e emitir um warning logístico ao gestor.
 *
 * HF16 (Fase 2) — Integração Google Maps Distance Matrix API:
 *   Se a env var GOOGLE_MAPS_API_KEY estiver definida, tenta usar a Distance
 *   Matrix API para calcular o tempo real de condução. Fallback silencioso
 *   para Haversine se: (a) a env var não existir; (b) a API falhar; (c) a
 *   resposta não contiver dados válidos. O fallback garante que o sistema
 *   funciona SEMPRE, mesmo sem Google Maps configurado.
 */

// Cache em memória de chamadas à API (evita chamadas repetidas para o
// mesmo par de coordenadas no mesmo ciclo de atribuição).
// TTL: 5 minutos (300s) — as distâncias de condução não mudam num dia.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheDistancias = new Map();

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

/**
 * Estima o tempo de viagem em minutos usando Haversine + velocidade média
 * urbana (30 km/h), com cap de 60 min (1h). É o fallback usado quando o
 * Google Maps não está disponível.
 *
 * @param {{ lat: number, lng: number } | null} origem
 * @param {{ lat: number, lng: number } | null} destino
 * @returns {number} tempo estimado em minutos (capped a 60, fallback 30)
 */
function tempoViagemHaversine(origem, destino) {
  if (
    !origem || !destino ||
    origem.lat == null || origem.lng == null ||
    destino.lat == null || destino.lng == null ||
    Number.isNaN(origem.lat) || Number.isNaN(origem.lng) ||
    Number.isNaN(destino.lat) || Number.isNaN(destino.lng)
  ) {
    return 30; // fallback razoável para deslocação urbana
  }

  const distanciaKm = distanciaHaversine(origem, destino);
  const velocidadeKmh = 30;
  let tempoMinutos = Math.round((distanciaKm / velocidadeKmh) * 60);
  tempoMinutos = Math.min(tempoMinutos, 60); // cap 1h
  if (!Number.isFinite(tempoMinutos) || tempoMinutos < 0) return 30;
  return tempoMinutos;
}

/**
 * Chave da cache para um par de coordenadas.
 */
function chaveCache(origem, destino) {
  return `${origem.lat.toFixed(5)},${origem.lng.toFixed(5)}→${destino.lat.toFixed(5)},${destino.lng.toFixed(5)}`;
}

const TIMEOUT_GOOGLE_MS = 5000; // não bloqueia o LB

/**
 * Routes API — computeRouteMatrix (Essentials: DRIVE + TRAFFIC_UNAWARE).
 * Devolve a duração em SEGUNDOS. Lança Error (nunca com a chave na mensagem);
 * `servicoDesativado=true` se o Google disser que a Routes API não está ativa neste projeto.
 */
async function segundosViaRoutes(origem, destino, apiKey) {
  const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
    },
    body: JSON.stringify({
      origins: [{ waypoint: { location: { latLng: { latitude: origem.lat, longitude: origem.lng } } } }],
      destinations: [{ waypoint: { location: { latLng: { latitude: destino.lat, longitude: destino.lng } } } }],
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      languageCode: 'pt-PT',
      regionCode: 'PT',
    }),
    signal: AbortSignal.timeout(TIMEOUT_GOOGLE_MS),
  });

  if (!res.ok) {
    let corpo = null;
    try { corpo = await res.json(); } catch (_) { /* sem JSON */ }
    const erro = (corpo && (Array.isArray(corpo) ? corpo[0] : corpo).error) || {};
    const motivo = (Array.isArray(erro.details) && erro.details.map((d) => d && d.reason).find(Boolean)) || erro.status || '';
    const e = new Error(`Google Routes API HTTP ${res.status}${motivo ? ` ${motivo}` : ''}${erro.message ? ` (${String(erro.message).slice(0, 160)})` : ''}`);
    e.servicoDesativado = res.status === 403 && (motivo === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(erro.message || ''));
    throw e;
  }

  const corpo = await res.json();
  const elementos = Array.isArray(corpo) ? corpo : [];
  const el = elementos.find((x) => x && (x.originIndex ?? 0) === 0 && (x.destinationIndex ?? 0) === 0);
  if (!el) throw new Error('Google Routes API: resposta sem elementos');
  if (el.condition !== undefined && el.condition !== 'ROUTE_EXISTS') throw new Error(`Google Routes API: condition=${el.condition}`);
  if (el.status && el.status.code) throw new Error(`Google Routes API: elemento status=${el.status.code}${el.status.message ? ` (${String(el.status.message).slice(0, 120)})` : ''}`);
  // duration vem como string em segundos («123s»); 0s é válido (mesmo local).
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(el.duration ?? ''));
  if (!m) throw new Error('Google Routes API: duração inválida');
  return parseFloat(m[1]);
}

/** Distance Matrix legada (2.ª tentativa, só em projetos onde a Routes API não está ativa). Devolve SEGUNDOS. */
async function segundosViaDistanceMatrixLegada(origem, destino, apiKey) {
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origem.lat},${origem.lng}` +
    `&destinations=${destino.lat},${destino.lng}` +
    `&mode=driving&units=metric&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_GOOGLE_MS) });
  if (!res.ok) throw new Error(`Google Distance Matrix HTTP ${res.status}`);
  const body = await res.json();
  if (body?.status !== 'OK' || !Array.isArray(body?.rows) || !body.rows[0]?.elements?.[0]) {
    throw new Error(`Google Distance Matrix status=${body?.status}${body?.error_message ? ` (${body.error_message})` : ''}`);
  }
  const elemento = body.rows[0].elements[0];
  if (elemento.status !== 'OK' || typeof elemento.duration?.value !== 'number') {
    throw new Error(`Google Distance Matrix: elemento status=${elemento.status}`);
  }
  return elemento.duration.value;
}

/**
 * HF16 — Tenta obter o tempo de condução real via Google Maps Distance
 * Matrix API (hoje Routes API; Distance Matrix legada só se a Routes estiver desativada). Fallback silencioso para Haversine se:
 *   - GOOGLE_MAPS_API_KEY não estiver definida
 *   - A chamada à API falhar (rede, timeout, 4xx/5xx)
 *   - A resposta não contiver dados válidos
 *   - HF24: a data da tarefa for daqui a mais de 48h (otimização de custos)
 *
 * @param {{ lat: number, lng: number } | null} origem
 * @param {{ lat: number, lng: number } | null} destino
 * @param {Date} [dataTarefa] - data da tarefa (para otimização de custos)
 * @returns {Promise<{ minutos: number, origem: 'google_maps' | 'haversine', distanciaKm: number }>}
 */
async function calcularTempoViagemReal(origem, destino, dataTarefa) {
  // Validação básica de coordenadas.
  if (
    !origem || !destino ||
    origem.lat == null || origem.lng == null ||
    destino.lat == null || destino.lng == null
  ) {
    return { minutos: 30, origem: 'haversine', distanciaKm: 0 };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const distanciaKm = distanciaHaversine(origem, destino);

  // Sem API key → fallback Haversine.
  if (!apiKey || !apiKey.trim()) {
    return {
      minutos: tempoViagemHaversine(origem, destino),
      origem: 'haversine',
      distanciaKm,
    };
  }

  // HF24 — Otimização de custos: se a tarefa for daqui a mais de 48h,
  // usa Haversine (linha reta) em vez de chamar a API do Google Maps.
  // Reserva os pedidos à API apenas para tarefas de curto prazo (hoje e
  // amanhã), onde a precisão do tempo de condução real é mais importante.
  // Para tarefas futuras, Haversine é suficiente — o LB re-calculará quando
  // a tarefa se aproximar (via auto-atribuição ou reatribuição manual).
  if (dataTarefa) {
    const agora = Date.now();
    const limite = agora + 48 * 60 * 60 * 1000; // 48 horas
    if (new Date(dataTarefa).getTime() > limite) {
      return {
        minutos: tempoViagemHaversine(origem, destino),
        origem: 'haversine',
        distanciaKm,
      };
    }
  }

  // Cache hit?
  const chave = chaveCache(origem, destino);
  const cached = cacheDistancias.get(chave);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.resultado };
  }

  // Tenta o Google Maps: Routes API (computeRouteMatrix) primeiro; a Distance
  // Matrix legada só como 2.ª tentativa se a Routes estiver desativada (projetos antigos).
  try {
    let segundos;
    try {
      segundos = await segundosViaRoutes(origem, destino, apiKey.trim());
    } catch (err) {
      if (!err.servicoDesativado) throw err;
      console.warn('⚠️  [Distâncias] Routes API desativada neste projeto Google: a tentar a Distance Matrix legada.');
      segundos = await segundosViaDistanceMatrixLegada(origem, destino, apiKey.trim());
    }

    // Segundos → minutos, com cap de 60 min (1h), consistente com o cap do Haversine.
    const minutosCapped = Math.min(Math.round(segundos / 60), 60);

    const resultado = {
      minutos: minutosCapped,
      origem: 'google_maps',
      distanciaKm,
    };

    // Guarda na cache.
    cacheDistancias.set(chave, { resultado, timestamp: Date.now() });

    return resultado;
  } catch (err) {
    // Fallback silencioso — não loga como erro (pode ser comum se a API key
    // for inválida ou o quota excedido). Loga como warning apenas.
    console.warn(
      `⚠️  [Distâncias] Google Maps falhou (${err.message}) — fallback para Haversine.`
    );

    const resultado = {
      minutos: tempoViagemHaversine(origem, destino),
      origem: 'haversine',
      distanciaKm,
    };

    // Não coloca na cache o fallback (próxima chamada pode ter a API recuperada).
    return resultado;
  }
}

/**
 * Limpa a cache de distâncias (para testes).
 */
function limparCacheDistancias() {
  cacheDistancias.clear();
}

module.exports = {
  distanciaHaversine,
  tempoViagemHaversine,
  calcularTempoViagemReal,
  limparCacheDistancias,
  RAIO_TERRA_KM,
};
