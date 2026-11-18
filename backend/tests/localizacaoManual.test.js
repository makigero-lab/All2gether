/** Ronda 5: localização aproximada automática, indicada à mão, «tentar de novo». */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn(), moradaDoPino: jest.fn() }));

const { obterCoordenadas, moradaDoPino } = require('../utils/geocoding');
const geocodingReal = jest.requireActual('../utils/geocoding');
const { interpretarCoordenadasManuais, extrairCoordenadas, resolverLinkGoogle } = require('../utils/coordenadasManuais');
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

const MORADA = 'Av. dos Combatentes da Grande Guerra 42, 2700-418 Amadora';
let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => {
  obterCoordenadas.mockReset();
  moradaDoPino.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('coordenadas indicadas à mão: formatos', () => {
  const casos = [
    ['38.7536, -9.2302', 38.7536, -9.2302],
    ['38.7536,-9.2302', 38.7536, -9.2302],
    ['38.7536 -9.2302', 38.7536, -9.2302],
    ['https://www.google.com/maps/place/X/@38.7536,-9.2302,17z', 38.7536, -9.2302],
    ['https://www.google.com/maps?q=38.7536,-9.2302', 38.7536, -9.2302],
    ['https://www.google.com/maps/search/?api=1&query=38.7536%2C-9.2302', 38.7536, -9.2302],
    ['https://www.google.com/maps/place/X/@38.1,-9.1,17z/data=!3d38.7536!4d-9.2302', 38.7536, -9.2302],
  ];
  test.each(casos)('%s', async (txt, lat, lng) => {
    expect(await interpretarCoordenadasManuais(txt)).toEqual({ lat, lng });
  });

  test('fora de Portugal, texto sem coordenadas e hosts desconhecidos dão erro claro', async () => {
    for (const txt of ['40.7128, -74.0060', '-9.2302, 38.7536', 'olá', '', 'https://evil.example/@38.7,-9.1']) {
      await expect(interpretarCoordenadasManuais(txt)).rejects.toMatchObject({ codigo: 'COORDENADAS_INVALIDAS' });
    }
    await expect(interpretarCoordenadasManuais('40.7128, -74.0060')).rejects.toThrow(/fora de Portugal/);
    expect(extrairCoordenadas(5)).toBeNull();
  });
});

describe('links curtos resolvidos no servidor', () => {
  const resposta = (status, location) => ({ status, headers: { get: (k) => (k === 'location' ? location : null) } });

  test('segue redirects e usa manual (sem seguir automaticamente)', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(resposta(302, 'https://www.google.com/maps/place/X'))
      .mockResolvedValueOnce(resposta(301, '/maps/place/X/@38.7536,-9.2302,17z'));
    const r = await resolverLinkGoogle('https://maps.app.goo.gl/abc', { fetchFn });
    expect(r).toEqual({ lat: 38.7536, lng: -9.2302 });
    expect(fetchFn.mock.calls.every((c) => c[1].redirect === 'manual')).toBe(true);
  });

  test('redirect para host não Google pára sem pedir esse host (SSRF)', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(resposta(302, 'https://169.254.169.254/latest'));
    expect(await resolverLinkGoogle('https://maps.app.goo.gl/abc', { fetchFn })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await resolverLinkGoogle('http://maps.app.goo.gl/abc', { fetchFn })).toBeNull();
  });

  test('no máximo 5 saltos', async () => {
    const fetchFn = jest.fn(async () => resposta(302, 'https://goo.gl/maps/outro'));
    expect(await resolverLinkGoogle('https://goo.gl/maps/a', { fetchFn })).toBeNull();
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(5);
  });

  test('erro de rede dá mensagem clara', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('rede'); });
    await expect(interpretarCoordenadasManuais('https://maps.app.goo.gl/abc', { fetchFn })).rejects.toThrow(/Não foi possível abrir o link/);
  });
});

describe('Google: aproximada automática', () => {
  const guardarFetch = global.fetch;
  const guardarChave = process.env.GOOGLE_MAPS_API_KEY;
  beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = 'chave'; });
  afterEach(() => { global.fetch = guardarFetch; if (guardarChave) process.env.GOOGLE_MAPS_API_KEY = guardarChave; else delete process.env.GOOGLE_MAPS_API_KEY; });
  const ok = (location_type, extra = {}) => ({ ok: true, json: async () => ({ status: 'OK', results: [{ formatted_address: 'X', geometry: { location: { lat: 1, lng: 2 }, location_type }, ...extra }] }) });

  test('ROOFTOP = exata; GEOMETRIC_CENTER, RANGE_INTERPOLATED, APPROXIMATE e partial_match = aproximada', async () => {
    const prec = async (r) => { global.fetch = jest.fn(async () => r); return (await geocodingReal.obterCoordenadas(MORADA)).precisao; };
    expect(await prec(ok('ROOFTOP'))).toBe('exata');
    expect(await prec(ok('GEOMETRIC_CENTER'))).toBe('aproximada');
    expect(await prec(ok('RANGE_INTERPOLATED'))).toBe('aproximada');
    expect(await prec(ok('APPROXIMATE'))).toBe('aproximada');
    expect(await prec(ok('ROOFTOP', { partial_match: true }))).toBe('aproximada');
  });

  test('ZERO_RESULTS: tenta «CP cidade, Portugal» no Google e marca aproximada', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(decodeURIComponent(url));
      return urls.length === 1 ? { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) } : ok('APPROXIMATE');
    });
    const r = await geocodingReal.obterCoordenadas(MORADA, { rapido: true });
    expect(r.precisao).toBe('aproximada');
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('address=2700-418 Amadora, Portugal');
  });

  test('REQUEST_DENIED não gasta a 2.ª tentativa no Google', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(url); return { ok: true, json: async () => (url.includes('googleapis') ? { status: 'REQUEST_DENIED' } : []) }; });
    await geocodingReal.obterCoordenadas(MORADA, { rapido: true, esperar: async () => {} });
    expect(urls.filter((u) => u.includes('googleapis'))).toHaveLength(1);
  });
});

describe('API: localização à mão e tentar de novo', () => {
  const put = (c, corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);

  test('grava coordenadas manuais sem tocar na morada; alterar a morada volta a geocodificar', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    obterCoordenadas.mockResolvedValue(null);
    await put(c, { morada: MORADA });
    const r = await put(c, { morada: MORADA, coordenadas_manuais: '38.7536, -9.2302' });
    expect(r.status).toBe(200);
    expect(r.body.warning).toBeUndefined();
    let bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.morada).toBe(MORADA);
    expect(bd.coordenadas).toEqual({ lat: 38.7536, lng: -9.2302 });
    expect(bd.coordenadas_precisao).toBe('manual');
    expect(bd.morada_localizada).toBe('Indicada à mão');

    // Guardar outra vez com a mesma morada mantém a localização manual.
    obterCoordenadas.mockClear();
    await put(c, { morada: MORADA, tempo_limpeza_minutos: 40 });
    expect(obterCoordenadas).not.toHaveBeenCalled();
    expect((await Propriedade.findById(c.p._id).lean()).coordenadas_precisao).toBe('manual');

    // Mudar a morada volta a geocodificar e a manual perde-se.
    obterCoordenadas.mockResolvedValue({ lat: 38.9, lng: -9.1, precisao: 'exata', morada_localizada: 'Nova' });
    await put(c, { morada: 'Rua Nova 1, Lisboa' });
    bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.coordenadas_precisao).toBe('exata');
    expect(bd.coordenadas.lat).toBe(38.9);
  });

  test('coordenadas fora de Portugal: 400 claro e nada é gravado', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    await Propriedade.updateOne({ _id: c.p._id }, { morada: MORADA, coordenadas: { lat: null, lng: null } });
    const r = await put(c, { morada: MORADA, coordenadas_manuais: '40.7128, -74.0060' });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('COORDENADAS_INVALIDAS');
    expect(r.body.erro).toMatch(/fora de Portugal/);
    expect((await Propriedade.findById(c.p._id).lean()).coordenadas.lat).toBeNull();
  });

  test('localizar_de_novo ignora a janela de 24 h e, se falhar mas já havia localização, mantém-na', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    await Propriedade.updateOne({ _id: c.p._id }, { morada: MORADA, coordenadas: { lat: null, lng: null }, geocoding_tentado_em: new Date() });
    obterCoordenadas.mockResolvedValue(null);
    await put(c, { morada: MORADA });
    expect(obterCoordenadas).not.toHaveBeenCalled();

    obterCoordenadas.mockResolvedValue({ lat: 38.7, lng: -9.2, precisao: 'aproximada', morada_localizada: 'Amadora' });
    const r = await put(c, { morada: MORADA, localizar_de_novo: true });
    expect(r.body.warning).toBeUndefined();
    let bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.coordenadas_precisao).toBe('aproximada');

    obterCoordenadas.mockResolvedValue(null);
    const r2 = await put(c, { morada: MORADA, localizar_de_novo: true });
    expect(r2.body.warning).toBeUndefined();
    bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.coordenadas.lat).toBe(38.7);
  });
});

describe('morada neste pino (reverse geocoding)', () => {
  const guardarFetch = global.fetch;
  const guardarChave = process.env.GOOGLE_MAPS_API_KEY;
  afterEach(() => { global.fetch = guardarFetch; if (guardarChave) process.env.GOOGLE_MAPS_API_KEY = guardarChave; else delete process.env.GOOGLE_MAPS_API_KEY; });

  test('Google primeiro (latlng, pt-PT); sem Google ou se falhar, Nominatim /reverse', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'chave';
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ status: 'OK', results: [{ formatted_address: 'Av. X 1, Amadora' }] }) };
    });
    expect(await geocodingReal.moradaDoPino(38.7, -9.2)).toBe('Av. X 1, Amadora');
    expect(urls[0]).toContain('latlng=38.7,-9.2');
    expect(urls[0]).toContain('language=pt-PT');

    global.fetch = jest.fn(async (url) => (url.includes('googleapis')
      ? { ok: true, json: async () => ({ status: 'REQUEST_DENIED' }) }
      : { ok: true, json: async () => ({ display_name: 'Rua do Pino, Amadora' }) }));
    expect(await geocodingReal.moradaDoPino(38.7, -9.2)).toBe('Rua do Pino, Amadora');

    delete process.env.GOOGLE_MAPS_API_KEY;
    global.fetch = jest.fn(async () => { throw new Error('rede'); });
    expect(await geocodingReal.moradaDoPino(38.7, -9.2)).toBeNull();
    expect(await geocodingReal.moradaDoPino('x', 1)).toBeNull();
  });

  test('endpoint de pré-visualização devolve a morada sugerida e valida as coordenadas', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    moradaDoPino.mockResolvedValue('Av. dos Combatentes 42, 2700-418 Amadora');
    const post = (t) => request(app).post('/api/gestor/propriedades/localizacao-manual/previsualizar').set(auth(c.token)).send({ coordenadas_manuais: t });
    const ok = await post('38.7536, -9.2302');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ lat: 38.7536, lng: -9.2302, morada_sugerida: 'Av. dos Combatentes 42, 2700-418 Amadora' });
    moradaDoPino.mockResolvedValue(null);
    expect((await post('38.7536, -9.2302')).body.morada_sugerida).toBeNull();
    const mau = await post('40.7, -74');
    expect(mau.status).toBe(400);
    expect(mau.body.codigo).toBe('COORDENADAS_INVALIDAS');
    expect(await request(app).post('/api/gestor/propriedades/localizacao-manual/previsualizar').send({})).toHaveProperty('status', 401);
  });

  test('«Usar esta morada»: troca o texto e mantém as coordenadas do pino sem geocodificar', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    obterCoordenadas.mockResolvedValue({ lat: 1, lng: 2 });
    const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token))
      .send({ morada: 'Av. dos Combatentes 42, 2700-418 Amadora', coordenadas_manuais: '38.7536, -9.2302' });
    expect(r.status).toBe(200);
    expect(obterCoordenadas).not.toHaveBeenCalled();
    const bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.morada).toBe('Av. dos Combatentes 42, 2700-418 Amadora');
    expect(bd.morada_estruturada.cidade).toBe('Amadora');
    expect(bd.coordenadas).toEqual({ lat: 38.7536, lng: -9.2302 });
    expect(bd.coordenadas_precisao).toBe('manual');
  });
});
