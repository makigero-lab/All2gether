/** Sugestão do Google escolhida ao escrever a morada: validação e gravação sem geocodificar. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn(), moradaDoPino: jest.fn() }));

const { obterCoordenadas } = require('../utils/geocoding');
const { validarLocalizacaoEscolhida } = require('../utils/coordenadasManuais');
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

const MORADA = 'Av. dos Combatentes da Grande Guerra 42, 2700-418 Amadora';
const escolha = (extra = {}) => ({ lat: 38.7536, lng: -9.2302, origem: 'google_places', tipos: ['street_address'], ...extra });

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { obterCoordenadas.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('validarLocalizacaoEscolhida', () => {
  test('exata só para street_address, premise ou subpremise; senão aproximada', () => {
    for (const t of ['street_address', 'premise', 'subpremise']) {
      expect(validarLocalizacaoEscolhida(escolha({ tipos: ['x', t] }))).toEqual({ ok: true, valor: { lat: 38.7536, lng: -9.2302, precisao: 'exata' } });
    }
    expect(validarLocalizacaoEscolhida(escolha({ tipos: ['route'] })).valor.precisao).toBe('aproximada');
    expect(validarLocalizacaoEscolhida(escolha({ tipos: undefined })).valor.precisao).toBe('aproximada');
  });

  test('rejeita fora de Portugal, tipos errados, origem errada e não-objetos', () => {
    const maus = [
      escolha({ lat: 40.7, lng: -74 }),
      escolha({ lat: '38.7' }),
      escolha({ lat: NaN }),
      escolha({ origem: 'manual' }),
      escolha({ origem: undefined }),
      escolha({ tipos: 'street_address' }),
      escolha({ tipos: [1, 2] }),
      escolha({ tipos: Array(31).fill('a') }),
      null, undefined, 5, 'x', [], {},
    ];
    for (const m of maus) expect(validarLocalizacaoEscolhida(m).ok).toBe(false);
  });
});

describe('API', () => {
  test('editar: grava coordenadas escolhidas e o texto, sem geocodificar', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, localizacao_escolhida: escolha() });
    expect(r.status).toBe(200);
    expect(obterCoordenadas).not.toHaveBeenCalled();
    const bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.morada).toBe(MORADA);
    expect(bd.morada_estruturada.cidade).toBe('Amadora');
    expect(bd.coordenadas).toEqual({ lat: 38.7536, lng: -9.2302 });
    expect(bd.coordenadas_precisao).toBe('exata');
    expect(bd.morada_localizada).toBe(MORADA);
  });

  test('editar: tipo de lugar não exato fica aproximada; localização manual manda sobre a escolhida', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    const put = (corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);
    await put({ morada: MORADA, localizacao_escolhida: escolha({ tipos: ['route'] }) });
    expect((await Propriedade.findById(c.p._id).lean()).coordenadas_precisao).toBe('aproximada');
    await put({ morada: MORADA, localizacao_escolhida: escolha(), coordenadas_manuais: '38.76, -9.24' });
    const bd = await Propriedade.findById(c.p._id).lean();
    expect(bd.coordenadas).toEqual({ lat: 38.76, lng: -9.24 });
    expect(bd.coordenadas_precisao).toBe('manual');
  });

  test('editar e criar: escolha inválida dá 400 LOCALIZACAO_INVALIDA e não grava', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    const antes = await Propriedade.findById(c.p._id).lean();
    const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, localizacao_escolhida: escolha({ lat: 40.7, lng: -74 }) });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('LOCALIZACAO_INVALIDA');
    expect((await Propriedade.findById(c.p._id).lean()).morada).toBe(antes.morada);
    const p = await request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ nome: 'X', morada: MORADA, localizacao_escolhida: { lat: 1, lng: 2, origem: 'google_places' } });
    expect(p.status).toBe(400);
    expect(p.body.codigo).toBe('LOCALIZACAO_INVALIDA');
  });

  test('texto alterado sem escolha (o ecrã descarta-a) volta a geocodificar', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    obterCoordenadas.mockResolvedValue({ lat: 38.9, lng: -9.1, precisao: 'exata', morada_localizada: 'Nova' });
    await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, localizacao_escolhida: escolha() });
    await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: 'Rua Nova 1, Lisboa' });
    expect(obterCoordenadas).toHaveBeenCalledTimes(1);
    expect((await Propriedade.findById(c.p._id).lean()).coordenadas.lat).toBe(38.9);
  });

  test('criar com escolha grava sem geocodificar', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    const r = await request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ nome: 'Casa G', morada: MORADA, localizacao_escolhida: escolha() });
    expect(r.status).toBe(201);
    expect(r.body.warning).toBeUndefined();
    expect(obterCoordenadas).not.toHaveBeenCalled();
    expect(r.body.propriedade.coordenadas).toEqual({ lat: 38.7536, lng: -9.2302 });
    expect(r.body.propriedade.coordenadas_precisao).toBe('exata');
  });
});
