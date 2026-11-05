const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Tarefa = require('../models/Tarefa');
const { cenario, login, auth } = require('./helpersLote');
const { idsEquipa, eMembro, filtroMembro } = require('../utils/equipaTarefa');
const { limparEquipasFantasma } = require('../scripts/limpar-equipas-fantasma');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const fantasma = (c, estado, id) => Tarefa.collection.insertOne({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, equipa_atribuida: [id], data: new Date('2035-06-10T10:00:00Z'), tempo_limpeza_minutos: 60, estado, tipo: 'limpeza', pessoas_em_falta: 1 });

test('A2 sem responsavel = sem equipa (helpers)', () => {
  const t = { utilizador_id: null, equipa_atribuida: ['aaaaaaaaaaaaaaaaaaaaaaaa'] };
  expect(idsEquipa(t)).toEqual([]);
  expect(eMembro(t, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  expect(JSON.stringify(filtroMembro('aaaaaaaaaaaaaaaaaaaaaaaa'))).toContain('$ne');
});

test('A2 o fantasma nao ve a tarefa por_atribuir nem a cancelada', async () => {
  const c = await cenario(app);
  const r1 = await fantasma(c, 'por_atribuir', c.bia._id);
  const r2 = await fantasma(c, 'cancelada', c.bia._id);
  const tok = await login(app, c.bia);
  const lista = await request(app).get('/api/auth/me/tarefas').set(auth(tok));
  const ids = lista.body.tarefas.map((t) => String(t._id));
  expect(ids).not.toContain(String(r1.insertedId));
  expect(ids).not.toContain(String(r2.insertedId));
  const det = await request(app).get(`/api/auth/me/tarefas/${r2.insertedId}`).set(auth(tok));
  expect(det.status).toBe(404);
});

test('A2 atribuir a tarefa fantasma nao herda o fantasma na equipa', async () => {
  const c = await cenario(app, { extra: 1 });
  const r = await fantasma(c, 'por_atribuir', c.bia._id);
  const a = await request(app).patch(`/api/gestor/tarefas/${r.insertedId}/atribuir`).set(auth(c.token)).send({ utilizador_id: String(c.subs[0]._id) });
  expect(a.status).toBe(200);
  const d = await Tarefa.findById(r.insertedId).lean();
  expect(d.equipa_atribuida.map(String)).not.toContain(String(c.bia._id));
});

test('A2 concluir tarefa cancelada: 400 claro nos dois caminhos', async () => {
  const c = await cenario(app);
  const t = await c.tarefa('2035-06-11', { estado: 'cancelada' });
  const tok = await login(app, c.bia);
  const a = await request(app).patch(`/api/auth/me/tarefas/${t._id}/concluir`).set(auth(tok)).send({});
  const b = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(tok)).send({ fotos_conclusao: ['data:image/jpeg;base64,AAAA'] });
  expect(a.status).toBe(400); expect(a.body.erro).toMatch(/cancelada/);
  expect(b.status).toBe(400);
  expect((await Tarefa.findById(t._id)).estado).toBe('cancelada');
});

test('B11 conclusao simultanea por 2 membros: 200 + 400, nunca 500', async () => {
  const c = await cenario(app);
  const t = await c.tarefa(new Date().toISOString().slice(0, 10));
  const ta = await login(app, c.ana), tb = await login(app, c.bia);
  const body = (x) => ({ fotos_conclusao: ['data:image/jpeg;base64,' + x], observacoes_staff: x });
  const rs = await Promise.all([
    request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(ta)).send(body('AAAA')),
    request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(tb)).send(body('BBBB')),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
});

test('A2 script: conta por defeito, altera so com --aplicar, idempotente, nao toca no resto', async () => {
  await Tarefa.deleteMany({});
  const c = await cenario(app);
  await fantasma(c, 'por_atribuir', c.ana._id);
  await fantasma(c, 'nao_atribuida', c.ana._id);
  await fantasma(c, 'cancelada', c.bia._id);
  const normal = await c.tarefa('2035-06-12'); // com responsavel: nao e alvo
  const concl = await Tarefa.collection.insertOne({ empresa_id: c.e._id, utilizador_id: null, equipa_atribuida: [c.ana._id], estado: 'concluida', pessoas_em_falta: 1, data: new Date(), propriedade_id: c.p._id, tipo: 'limpeza', observacoes: 'x' });
  const db = mongoose.connection.db;
  const seco = await limparEquipasFantasma(db);
  expect(seco.aplicado).toBe(false);
  expect(seco.porEstado).toEqual({ por_atribuir: 1, nao_atribuida: 1, cancelada: 1 });
  expect(seco.total).toBe(3);
  expect(await Tarefa.countDocuments({ utilizador_id: null, 'equipa_atribuida.0': { $exists: true } })).toBe(4);
  const antes = await Tarefa.collection.findOne({ estado: 'cancelada', empresa_id: c.e._id });
  const real = await limparEquipasFantasma(db, { aplicar: true });
  expect(real.alteradas).toBe(3);
  const depois = await Tarefa.collection.findOne({ _id: antes._id });
  expect(depois.equipa_atribuida).toEqual([]);
  expect(depois.pessoas_em_falta).toBe(0);
  const { equipa_atribuida: _a, pessoas_em_falta: _p, ...restoAntes } = antes;
  const { equipa_atribuida: _a2, pessoas_em_falta: _p2, ...restoDepois } = depois;
  expect(restoDepois).toEqual(restoAntes);
  expect((await Tarefa.findById(normal._id)).equipa_atribuida).toHaveLength(2);
  expect((await Tarefa.collection.findOne({ _id: concl.insertedId })).equipa_atribuida).toHaveLength(1);
  const outra = await limparEquipasFantasma(db, { aplicar: true });
  expect(outra.total).toBe(0); expect(outra.alteradas).toBe(0);
});
