/** Dashboard: coluna «Próximas 48 h» (limpezas ativas, não só as por atribuir) e tipo na lista «A decorrer agora». */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Tarefa = require('../models/Tarefa');
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

test('proximas48h traz as limpezas ativas das próximas 48 h (e não as canceladas, concluídas ou de depois)', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const em = (h) => new Date(Date.now() + h * 3600 * 1000);
  const mk = (h, extra) => Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, tipo: 'limpeza', data: em(h), tempo_limpeza_minutos: 60, estado: 'por_atribuir', ...extra });
  await mk(5, { tipo_limpeza: 'profunda' });
  await mk(30, { estado: 'atribuida', utilizador_id: c.ana._id });
  await mk(10, { estado: 'cancelada' });
  await mk(12, { estado: 'concluida' });
  await mk(60, {});
  const r = await request(app).get('/api/gestor/dashboard').set(auth(c.token));
  expect(r.status).toBe(200);
  expect(r.body.proximas48h.map((t) => [t.estado, t.tipo_limpeza])).toEqual([['por_atribuir', 'profunda'], ['atribuida', 'normal']]);
  expect(r.body.checkinsEmRisco.total).toBe(1);
});
