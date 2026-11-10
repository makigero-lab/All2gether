const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7, lng: -9.1 }) }));
const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const { LockEmpresa } = require('../utils/lockEmpresa');
const { preencherVagasPeriodo } = require('../utils/atribuicaoAutomatica');
let mongod, n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const dia = (s) => new Date(`${s}T00:00:00Z`);
async function cen(staffNec = 1) {
  const e = await Empresa.create({ nome: 'T' + ++n });
  const mk = (nome, role) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('g', 'gestor'); const ana = await mk('Ana', 'staff');
  const p = await Propriedade.create({ nome: 'C', empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: staffNec });
  const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
  return { e, g, ana, p, login };
}
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

test('staff cancela a propria ausencia aprovada pela rota gestor: preenche com empresa da ausencia', async () => {
  const { e, ana, p, login } = await cen();
  const a = await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: dia('2036-03-10'), data_fim: dia('2036-03-10'), tipo: 'ferias', estado: 'aprovada' });
  const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date('2036-03-10T10:00:00Z'), estado: 'por_atribuir' });
  const r = await request(app).patch(`/api/gestor/ausencias/${a._id}/cancelar`).set({ Authorization: 'Bearer ' + await login(ana) });
  expect([r.status, r.body.preenchimento && r.body.preenchimento.atribuidas]).toEqual([200, 1]);
  expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
});
test('rota de staff (PATCH /staff/ausencias/:id/cancelar) preenche', async () => {
  const { e, ana, p, login } = await cen();
  const a = await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: dia('2036-03-11'), data_fim: dia('2036-03-11'), tipo: 'ferias', estado: 'aprovada' });
  const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date('2036-03-11T10:00:00Z'), estado: 'por_atribuir' });
  const r = await request(app).patch(`/api/staff/ausencias/${a._id}/cancelar`).set({ Authorization: 'Bearer ' + await login(ana) });
  expect([r.status, r.body.preenchimento && r.body.preenchimento.atribuidas]).toEqual([200, 1]);
  expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
});
test('nao_atribuida, fantasma atribuida, ultimo dia, dia seguinte; lock libertado', async () => {
  const { e, g, ana, p, login } = await cen();
  const a = await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: dia('2036-04-10'), data_fim: dia('2036-04-11'), tipo: 'ferias', estado: 'cancelada' });
  const mk = (d, estado, x = {}) => Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date(d), estado, ...x });
  const na = await mk('2036-04-10T10:00:00Z', 'nao_atribuida');
  const fa = await mk('2036-04-11T23:30:00Z', 'atribuida');
  const fora = await mk('2036-04-12T00:30:00Z', 'por_atribuir');
  const r = await preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim);
  console.log('R', JSON.stringify(r));
  expect((await Tarefa.findById(na._id)).estado).toBe('atribuida');
  expect((await Tarefa.findById(fa._id)).estado).toBe('atribuida');
  expect((await Tarefa.findById(fora._id)).estado).toBe('por_atribuir');
  expect(await LockEmpresa.countDocuments({})).toBe(0);
});
test('ausencia longa: 60 tarefas, uma pessoa, tempo e carga', async () => {
  const { e, ana, p } = await cen();
  const a = { data_inicio: dia('2036-06-01'), data_fim: dia('2036-06-30') };
  for (let i = 1; i <= 30; i++) for (let k = 0; k < 2; k++)
    await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date(`2036-06-${String(i).padStart(2, '0')}T1${k}:00:00Z`), estado: 'por_atribuir' });
  const t0 = Date.now();
  const r = await preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim);
  console.log('LONGA', JSON.stringify(r), Date.now() - t0, 'ms');
  expect(r.total).toBe(60);
}, 120000);
