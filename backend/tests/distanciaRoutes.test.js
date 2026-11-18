/** Distâncias via Routes API (computeRouteMatrix), com a Distance Matrix legada só como 2.ª tentativa. */
const { calcularTempoViagemReal, limparCacheDistancias } = require('../utils/distancia');

const A = { lat: 38.7223, lng: -9.1393 };
const B = { lat: 38.7536, lng: -9.2302 };
const CHAVE = 'chave-secreta-de-teste';

const resp = (corpo, ok = true, status = 200) => ({ ok, status, json: async () => corpo });
const routesOk = (duration) => resp([{ originIndex: 0, destinationIndex: 0, status: {}, condition: 'ROUTE_EXISTS', distanceMeters: 9000, duration }]);

let chaveAntiga;
beforeEach(() => {
  chaveAntiga = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = CHAVE;
  limparCacheDistancias();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (chaveAntiga === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = chaveAntiga;
});

test('pede à Routes API (POST, cabeçalhos e corpo certos) e converte segundos em minutos', async () => {
  const f = jest.spyOn(global, 'fetch').mockResolvedValue(routesOk('905s'));
  const r = await calcularTempoViagemReal(A, B);
  expect(r).toMatchObject({ minutos: 15, origem: 'google_maps' });
  expect(f).toHaveBeenCalledTimes(1);
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
  expect(url).not.toContain(CHAVE);
  expect(init.method).toBe('POST');
  expect(init.headers['X-Goog-Api-Key']).toBe(CHAVE);
  expect(init.headers['X-Goog-FieldMask']).toBe('originIndex,destinationIndex,duration,distanceMeters,status,condition');
  const corpo = JSON.parse(init.body);
  expect(corpo).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', languageCode: 'pt-PT', regionCode: 'PT' });
  expect(corpo.origins[0].waypoint.location.latLng).toEqual({ latitude: A.lat, longitude: A.lng });
  expect(corpo.destinations[0].waypoint.location.latLng).toEqual({ latitude: B.lat, longitude: B.lng });
});

test('cap de 60 min e cache (2.ª chamada não vai à rede)', async () => {
  const f = jest.spyOn(global, 'fetch').mockResolvedValue(routesOk('7200s'));
  expect((await calcularTempoViagemReal(A, B)).minutos).toBe(60);
  await calcularTempoViagemReal(A, B);
  expect(f).toHaveBeenCalledTimes(1);
});

test('mesmo local: 0s é válido', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(routesOk('0s'));
  const r = await calcularTempoViagemReal(A, A);
  expect(r).toMatchObject({ minutos: 0, origem: 'google_maps' });
});

test('erro da Routes (ex.: chave recusada) cai no Haversine e o log traz o motivo sem a chave', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(resp({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests from referer are blocked.' } }, false, 403));
  const r = await calcularTempoViagemReal(A, B);
  expect(r.origem).toBe('haversine');
  const log = console.warn.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(log).toMatch(/403/);
  expect(log).toMatch(/PERMISSION_DENIED|blocked/);
  expect(log).not.toContain(CHAVE);
  expect(global.fetch).toHaveBeenCalledTimes(1); // sem 2.ª tentativa: não é «serviço desativado»
});

test('Routes desativada (403 SERVICE_DISABLED): tenta a Distance Matrix legada', async () => {
  const f = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(resp({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Routes API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }, false, 403))
    .mockResolvedValueOnce(resp({ status: 'OK', rows: [{ elements: [{ status: 'OK', duration: { value: 600 } }] }] }));
  const r = await calcularTempoViagemReal(A, B);
  expect(r).toMatchObject({ minutos: 10, origem: 'google_maps' });
  expect(f).toHaveBeenCalledTimes(2);
  expect(f.mock.calls[1][0]).toContain('/distancematrix/json');
});

test('respostas inválidas (sem rota, duração mal formada, vazio) caem no Haversine sem lançar', async () => {
  const casos = [
    resp([{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' }]),
    resp([{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: 'abc' }]),
    resp([{ originIndex: 0, destinationIndex: 0, status: { code: 3, message: 'x' }, condition: 'ROUTE_EXISTS', duration: '10s' }]),
    resp([]),
    resp({}),
  ];
  for (const c of casos) {
    limparCacheDistancias();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(c);
    expect((await calcularTempoViagemReal(A, B)).origem).toBe('haversine');
  }
});

test('sem chave ou sem coordenadas não chama a rede', async () => {
  const f = jest.spyOn(global, 'fetch');
  delete process.env.GOOGLE_MAPS_API_KEY;
  expect((await calcularTempoViagemReal(A, B)).origem).toBe('haversine');
  process.env.GOOGLE_MAPS_API_KEY = CHAVE;
  expect((await calcularTempoViagemReal(null, B)).minutos).toBe(30);
  expect(f).not.toHaveBeenCalled();
});
