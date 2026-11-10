const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const { cenario, auth } = require('./helpersLote');
const { calcularCargaLimpezaDia, oid } = require('../utils/loadBalancer');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

test('A1 limite de 8h via HTTP com JWT real: 6 casas de 120 min e 1 staff = 3 atribuidas + 3 nao_atribuida (janela 09:00-18:00, almoço e viagens)', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  await Utilizador.updateMany({ _id: { $in: [c.ana._id, c.bia._id] } }, { ativo: false });
  const dia = new Date(); dia.setUTCDate(dia.getUTCDate() + 10); dia.setUTCHours(10, 0, 0, 0);
  const staff = await c.mk('Unico', 'staff');
  for (let i = 0; i < 6; i++) {
    const p = await Propriedade.create({ nome: 'L' + i + c.n(), empresa_id: c.e._id, smoobu_id: 'l' + c.n(), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 120, staff_necessario: 1 });
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: null, data: dia, tempo_limpeza_minutos: 120, estado: 'por_atribuir' });
  }
  const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(c.token)).send({});
  expect(r.status).toBe(200);
  const ts = await Tarefa.find({ empresa_id: c.e._id, propriedade_id: { $ne: c.p._id } }).lean();
  // 09:00-11:00, 11:30-13:30 (viagem de 30), almoço 13:30-14:30, 15:00-17:00; a 4.ª já não cabe (17:30 + 2h > 18:00).
  expect(ts.filter((t) => t.estado === 'atribuida')).toHaveLength(3);
  expect(ts.filter((t) => t.estado === 'nao_atribuida')).toHaveLength(3);
  expect(ts.every((t) => !t.utilizador_id || String(t.utilizador_id) === String(staff._id))).toBe(true);
});

test('A1 a carga aceita ids em string (cast no proprio loadBalancer)', async () => {
  const c = await cenario(app);
  const dia = '2036-03-10';
  await c.tarefa(dia);
  const range = { start: new Date(dia + 'T00:00:00Z'), end: new Date(dia + 'T23:59:59Z') };
  expect(await calcularCargaLimpezaDia(String(c.e._id), String(c.ana._id), range)).toBe(60);
  expect(String(oid(String(c.e._id)))).toBe(String(c.e._id));
});
