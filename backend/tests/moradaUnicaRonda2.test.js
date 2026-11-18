/** Morada única, ronda 2: A1 (estruturada vazia), A2 (orçamento), A6, A7 (validação), A9 (24 h). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn() }));

const { obterCoordenadas } = require('../utils/geocoding');
const geocodingReal = jest.requireActual('../utils/geocoding');
const { derivarMoradaEstruturada, validarMorada } = require('../utils/morada');
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

const MORADA = 'Av. dos Combatentes da Grande Guerra 42, 2700-418 Amadora';
let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { obterCoordenadas.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('derivação (A6)', () => {
  test('cidade é só a 1.ª parte depois do código postal', () => {
    expect(derivarMoradaEstruturada('Av. A 4, 2700-418 Amadora, Portugal')).toEqual({ rua: 'Av. A 4', codigo_postal: '2700-418', cidade: 'Amadora' });
  });
  test('«Portugal» / «PT» no fim nunca é a cidade', () => {
    expect(derivarMoradaEstruturada('Rua X 5, Lisboa, Portugal')).toEqual({ rua: 'Rua X 5', codigo_postal: '', cidade: 'Lisboa' });
    expect(derivarMoradaEstruturada('Av. A 4, 2700-418, PT')).toEqual({ rua: 'Av. A 4', codigo_postal: '2700-418', cidade: '' });
    expect(derivarMoradaEstruturada('Rua X 5, Portugal').cidade).toBe('');
  });
  test('sem CP, andar/fração não é cidade', () => {
    for (const fim of ['R/C Esq', '3º Dto', 'Lote 4', 'Bloco B', 'Fração A', 'Edifício Sol']) {
      expect(derivarMoradaEstruturada(`Rua X 5, ${fim}`).cidade).toBe('');
    }
    expect(derivarMoradaEstruturada('Rua X 5, Oeiras')).toEqual({ rua: 'Rua X 5', codigo_postal: '', cidade: 'Oeiras' });
  });
});

describe('validarMorada (A7)', () => {
  test('aceita texto normal e aplica trim', () => { expect(validarMorada('  Rua 1 ')).toEqual({ ok: true, valor: 'Rua 1' }); });
  test('rejeita não-string, só pontuação e demasiado longa', () => {
    for (const v of [5, null, undefined, {}, [], ',,,', '   ', '---']) expect(validarMorada(v).ok).toBe(false);
    expect(validarMorada('a'.repeat(300)).ok).toBe(true);
    expect(validarMorada('a'.repeat(301)).ok).toBe(false);
  });
});

describe('orçamento do geocoding (A2)', () => {
  const guardarFetch = global.fetch;
  const guardarChave = process.env.GOOGLE_MAPS_API_KEY;
  afterEach(() => { global.fetch = guardarFetch; if (guardarChave) process.env.GOOGLE_MAPS_API_KEY = guardarChave; else delete process.env.GOOGLE_MAPS_API_KEY; });

  test('pedidos lentos esgotam o orçamento de 8 s: pára cedo e devolve null', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    let t = 0;
    const tempos = [];
    global.fetch = jest.fn(async (url, init) => { t += 3000; tempos.push(init.signal); return { ok: true, json: async () => [] }; });
    const r = await geocodingReal.obterCoordenadas(MORADA, { agora: () => t, esperar: async (ms) => { t += ms; } });
    expect(r).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(t).toBeLessThanOrEqual(9000);
  });

  test('modo rápido só tenta 2 variantes', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => [] }));
    expect(await geocodingReal.obterCoordenadas(MORADA, { rapido: true, esperar: async () => {} })).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(geocodingReal.variantesNominatim(MORADA, { rapido: true })).toHaveLength(2);
  });
});

describe('API', () => {
  test('A1: PUT só com morada_estruturada vazia não apaga a morada nem as coordenadas', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    await Propriedade.updateOne({ _id: c.p._id }, { morada: MORADA, coordenadas: { lat: 38.7, lng: -9.1 } });
    const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token))
      .send({ morada_estruturada: { rua: '', codigo_postal: '', cidade: '' }, observacoes: 'x' });
    expect(r.status).toBe(200);
    const bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.morada).toBe(MORADA);
    expect(bd.coordenadas).toEqual({ lat: 38.7, lng: -9.1 });
    expect(obterCoordenadas).not.toHaveBeenCalled();
  });

  test('A7: criar e editar rejeitam morada inválida com 400', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    const post = (m) => request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ nome: 'X', morada: m });
    const put = (m) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: m });
    for (const m of [',,,', 123, 'a'.repeat(301), '   ']) {
      expect((await post(m)).status).toBe(400);
      expect((await put(m)).status).toBe(400);
    }
    expect((await post(',,,')).body.erro).toMatch(/morada/i);
    expect((await post(',,,')).body.codigo).toBe('MORADA_INVALIDA');
    expect((await put(',,,')).body.codigo).toBe('MORADA_INVALIDA');
    expect(obterCoordenadas).not.toHaveBeenCalled();
  });

  test('A9: morada igual sem coordenadas só repete a tentativa passadas 24 h', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    obterCoordenadas.mockResolvedValue(null);
    await Propriedade.updateOne({ _id: c.p._id }, { morada: MORADA, coordenadas: { lat: null, lng: null }, geocoding_tentado_em: new Date() });
    const put = () => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, tempo_limpeza_minutos: 50 });
    expect((await put()).status).toBe(200);
    expect(obterCoordenadas).not.toHaveBeenCalled();

    await Propriedade.updateOne({ _id: c.p._id }, { geocoding_tentado_em: new Date(Date.now() - 25 * 3600 * 1000) });
    const r = await put();
    expect(r.body.geocoding_falhou).toBe(true);
    expect(obterCoordenadas).toHaveBeenCalledTimes(1);
    // A tentativa ficou registada: a seguinte não repete.
    obterCoordenadas.mockClear();
    expect((await put()).body.warning).toBeUndefined();
    expect(obterCoordenadas).not.toHaveBeenCalled();
  });

  test('A7: proprietário (parceiro) também valida a morada', async () => {
    const bcrypt = require('bcryptjs');
    const Empresa = require('../models/Empresa');
    const Utilizador = require('../models/Utilizador');
    const empresa = await Empresa.create({ nome: 'Empresa Parc' });
    await Utilizador.create({ nome: 'P', email: 'pp@x.pt', password_hash: await bcrypt.hash('teste123', 10), empresa_id: empresa._id, role: 'parceiro', ativo: true });
    const login = await request(app).post('/api/auth/login').send({ email: 'pp@x.pt', password: 'teste123' });
    const post = (m) => request(app).post('/api/parceiro/propriedades').set(auth(login.body.token)).send({ nome: 'Casa', morada: m });
    for (const m of [',,,', 123, 'a'.repeat(301)]) expect((await post(m)).status).toBe(400);
    obterCoordenadas.mockResolvedValue({ lat: 1, lng: 2 });
    const ok = await post(MORADA);
    expect(ok.status).toBe(201);
    expect(ok.body.propriedade.morada_estruturada.cidade).toBe('Amadora');
  });
});
