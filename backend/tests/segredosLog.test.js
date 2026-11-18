/** A chave do Google nunca aparece nos logs (distancia.js e geocoding.js). */
const { redigir } = require('../utils/segredos');
const { calcularTempoViagemReal, limparCacheDistancias } = require('../utils/distancia');
const { obterCoordenadas, moradaDoPino } = require('../utils/geocoding');

const CHAVE = 'AIzaSyCHAVE-super-secreta-123';
let antiga;
beforeEach(() => {
  antiga = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = CHAVE;
  limparCacheDistancias();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (antiga === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = antiga;
});

const logs = () => [...console.warn.mock.calls, ...console.error.mock.calls].map((c) => c.join(' ')).join('\n');

test('redigir troca o valor da chave e qualquer key= por ***', () => {
  expect(redigir(`erro em https://x/y?a=1&key=${CHAVE}&b=2 e ${CHAVE}`)).toBe('erro em https://x/y?a=1&key=***&b=2 e ***');
  expect(redigir('sem segredo')).toBe('sem segredo');
  expect(redigir('key=abc123')).toBe('key=***');
});

test('distancia.js: erro de rede com a chave na mensagem é redigido', async () => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`falhou https://routes.googleapis.com/x?key=${CHAVE} (${CHAVE})`));
  const r = await calcularTempoViagemReal({ lat: 38.7, lng: -9.1 }, { lat: 38.8, lng: -9.2 });
  expect(r.origem).toBe('haversine');
  expect(logs()).toContain('***');
  expect(logs()).not.toContain(CHAVE);
});

test('geocoding.js: erros do Google, Nominatim e reverse são redigidos', async () => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`boom ${CHAVE} ?key=${CHAVE}`));
  await obterCoordenadas('Rua X 1, 1000-001 Lisboa', { esperar: async () => {} });
  await moradaDoPino(38.7, -9.1);
  expect(logs()).toContain('***');
  expect(logs()).not.toContain(CHAVE);

  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'REQUEST_DENIED', error_message: `A chave ${CHAVE} foi recusada` }) });
  await obterCoordenadas('Rua X 1, 1000-001 Lisboa', { esperar: async () => {} });
  expect(logs()).not.toContain(CHAVE);
  expect(logs()).toContain('REQUEST_DENIED');
});
