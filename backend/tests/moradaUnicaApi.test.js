/** Morada única na API: estruturada derivada, coordenadas a null e forcar_morada. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn() }));

const { obterCoordenadas } = require('../utils/geocoding');
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

const MORADA = 'Av. dos Combatentes da Grande Guerra 42, 2700-418 Amadora';
let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { obterCoordenadas.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test('criar: deriva a estrutura da morada única e guarda a localização', async () => {
  obterCoordenadas.mockResolvedValue({ lat: 38.75, lng: -9.23, precisao: 'aproximada', morada_localizada: 'Amadora, Portugal' });
  const c = await cenario(app, { extra: 0, sn: 1 });
  const r = await request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ nome: 'Casa A', morada: MORADA });
  expect(r.status).toBe(201);
  expect(r.body.warning).toBeUndefined();
  const bd = await Propriedade.findById(r.body.propriedade._id).lean();
  expect(bd.morada).toBe(MORADA);
  expect(bd.morada_estruturada).toEqual({ rua: 'Av. dos Combatentes da Grande Guerra 42', codigo_postal: '2700-418', cidade: 'Amadora' });
  expect(bd.coordenadas).toEqual({ lat: 38.75, lng: -9.23 });
  expect(bd.coordenadas_precisao).toBe('aproximada');
  expect(bd.morada_localizada).toBe('Amadora, Portugal');
});

test('criar: cliente antigo só com morada_estruturada continua aceite', async () => {
  obterCoordenadas.mockResolvedValue({ lat: 1, lng: 2 });
  const c = await cenario(app, { extra: 0, sn: 1 });
  const r = await request(app).post('/api/gestor/propriedades').set(auth(c.token))
    .send({ nome: 'Casa B', morada_estruturada: { rua: 'Rua B 2', codigo_postal: '1000-001', cidade: 'Lisboa' } });
  expect(r.status).toBe(201);
  expect(r.body.propriedade.morada).toBe('Rua B 2, 1000-001, Lisboa');
});

test('editar: morada não localizada anula as coordenadas antigas e avisa; forcar_morada grava sem aviso', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  await Propriedade.updateOne({ _id: c.p._id }, { coordenadas: { lat: 38.7, lng: -9.1 }, coordenadas_precisao: 'exata', morada_localizada: 'antiga' });
  obterCoordenadas.mockResolvedValue(null);
  const put = (extra) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, ...extra });

  const r1 = await put({});
  expect(r1.status).toBe(200);
  expect(r1.body.geocoding_falhou).toBe(true);
  expect(r1.body.warning).toBeTruthy();
  let bd = await Propriedade.findById(c.p._id).lean();
  expect(bd.morada).toBe(MORADA);
  expect(bd.coordenadas).toEqual({ lat: null, lng: null });
  expect(bd.coordenadas_precisao).toBeNull();
  expect(bd.morada_localizada).toBeNull();
  expect(bd.morada_estruturada.cidade).toBe('Amadora');

  obterCoordenadas.mockClear();
  const r2 = await put({ forcar_morada: true });
  expect(r2.status).toBe(200);
  expect(r2.body.warning).toBeUndefined();
  expect(obterCoordenadas).not.toHaveBeenCalled();
  bd = await Propriedade.findById(c.p._id).lean();
  expect(bd.coordenadas).toEqual({ lat: null, lng: null });
});

test('editar: morada igual não volta a geocodificar nem perde a localização', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  obterCoordenadas.mockResolvedValue({ lat: 38.75, lng: -9.23, precisao: 'exata', morada_localizada: 'X' });
  await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA });
  obterCoordenadas.mockClear();
  const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ morada: MORADA, tempo_limpeza_minutos: 50 });
  expect(r.status).toBe(200);
  expect(obterCoordenadas).not.toHaveBeenCalled();
  expect((await Propriedade.findById(c.p._id).lean()).coordenadas.lat).toBe(38.75);
});

test('criar com forcar_morada: grava sem localizar e sem aviso', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const r = await request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ nome: 'Casa C', morada: MORADA, forcar_morada: true });
  expect(r.status).toBe(201);
  expect(r.body.warning).toBeUndefined();
  expect(obterCoordenadas).not.toHaveBeenCalled();
  expect(r.body.propriedade.coordenadas).toEqual({ lat: null, lng: null });
});
