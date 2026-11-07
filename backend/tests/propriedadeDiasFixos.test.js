/** Editar propriedade: os dias fixos de limpeza também se alteram ao editar (antes só ao criar). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test('PUT /propriedades/:id grava e valida dias_fixos_limpeza', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const put = (corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);
  const ok = await put({ dias_fixos_limpeza: [1, 3, 3, 0] });
  expect(ok.status).toBe(200);
  expect((await Propriedade.findById(c.p._id).lean()).dias_fixos_limpeza).toEqual([0, 1, 3]);
  expect((await put({ dias_fixos_limpeza: [7] })).status).toBe(400);
  expect((await put({ dias_fixos_limpeza: 'seg' })).status).toBe(400);
  expect((await put({ dias_fixos_limpeza: [] })).status).toBe(200);
  expect((await Propriedade.findById(c.p._id).lean()).dias_fixos_limpeza).toEqual([]);
  expect((await put({ dias_fixos_limpeza: [2] })).status).toBe(200);
});
