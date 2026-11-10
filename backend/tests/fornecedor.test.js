/**
 * Testes do portal Fornecedor (lavandaria) e da atribuição fornecedor/parceiro.
 *  - Fornecedor só vê e altera tarefas das propriedades que lhe estão atribuídas
 *  - Isolamento entre fornecedores e entre empresas
 *  - Roles não-fornecedor recebem 403
 *  - Criação de propriedade valida parceiro_id/fornecedor_id da mesma empresa
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');

const PASSWORD = 'teste123';
let mongod;
let empresa;
let outraEmpresa;
let forn1;
let forn2;
let fornAlheio;
let parceiroAlheio;
let staffUser;
let tokens = {};
let tarefa1;
let tarefa2;
let tarefaAlheia;

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}
const hoje = () => {
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  return d;
};
const get = (url, t) => request(app).get(url).set('Authorization', `Bearer ${t}`);
const patch = (url, t, body = {}) =>
  request(app).patch(url).set('Authorization', `Bearer ${t}`).send(body);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  empresa = await Empresa.create({ nome: 'Empresa F' });
  outraEmpresa = await Empresa.create({ nome: 'Empresa Alheia' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role, emp = empresa) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: emp._id, role, ativo: true });

  await mk('Gestor', 'gestor@f.pt', 'gestor');
  staffUser = await mk('Staff', 'staff@f.pt', 'staff');
  forn1 = await mk('Lavandaria 1', 'forn1@f.pt', 'fornecedor');
  forn2 = await mk('Lavandaria 2', 'forn2@f.pt', 'fornecedor');
  fornAlheio = await mk('Lavandaria Alheia', 'fornx@f.pt', 'fornecedor', outraEmpresa);
  parceiroAlheio = await mk('Parceiro Alheio', 'parcx@f.pt', 'parceiro', outraEmpresa);

  const p1 = await Propriedade.create({ nome: 'Casa 1', empresa_id: empresa._id, ativo: true, fornecedor_id: forn1._id });
  const p2 = await Propriedade.create({ nome: 'Casa 2', empresa_id: empresa._id, ativo: true, fornecedor_id: forn2._id });
  const pAlheia = await Propriedade.create({ nome: 'Casa Alheia', empresa_id: outraEmpresa._id, ativo: true, fornecedor_id: fornAlheio._id });

  const mkT = (prop, emp) =>
    Tarefa.create({
      empresa_id: emp._id, propriedade_id: prop._id, origem: 'manual', data: hoje(),
      tipo: 'limpeza', estado: 'por_atribuir', tempo_limpeza_minutos: 45,
    });
  tarefa1 = await mkT(p1, empresa);
  tarefa2 = await mkT(p2, empresa);
  tarefaAlheia = await mkT(pAlheia, outraEmpresa);

  for (const [k, email] of Object.entries({
    gestor: 'gestor@f.pt', staff: 'staff@f.pt', forn1: 'forn1@f.pt', forn2: 'forn2@f.pt',
  })) {
    tokens[k] = await login(email);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Portal fornecedor — listagem', () => {
  it('cada fornecedor vê apenas as tarefas das suas propriedades', async () => {
    const r1 = await get('/api/fornecedor/tarefas', tokens.forn1);
    expect(r1.status).toBe(200);
    expect(r1.body.tarefas.map((t) => String(t._id))).toEqual([String(tarefa1._id)]);
    const r2 = await get('/api/fornecedor/tarefas', tokens.forn2);
    expect(r2.body.tarefas.map((t) => String(t._id))).toEqual([String(tarefa2._id)]);
  });

  it('staff e gestor recebem 403 no portal do fornecedor', async () => {
    expect((await get('/api/fornecedor/tarefas', tokens.staff)).status).toBe(403);
    expect((await get('/api/fornecedor/tarefas', tokens.gestor)).status).toBe(403);
  });
});

describe('Portal fornecedor — marcar roupa entregue', () => {
  it('altera tarefa de propriedade que lhe está atribuída', async () => {
    const res = await patch(`/api/fornecedor/tarefas/${tarefa1._id}/roupa`, tokens.forn1, { roupa_entregue: true });
    expect(res.status).toBe(200);
    expect((await Tarefa.findById(tarefa1._id)).roupa_entregue).toBe(true);
  });

  it('NÃO altera tarefa de propriedade atribuída a outro fornecedor (404)', async () => {
    const res = await patch(`/api/fornecedor/tarefas/${tarefa2._id}/roupa`, tokens.forn1, { roupa_entregue: true });
    expect(res.status).toBe(404);
    expect((await Tarefa.findById(tarefa2._id)).roupa_entregue).not.toBe(true);
  });

  it('NÃO altera tarefa de outra empresa (404)', async () => {
    const res = await patch(`/api/fornecedor/tarefas/${tarefaAlheia._id}/roupa`, tokens.forn1, { roupa_entregue: true });
    expect(res.status).toBe(404);
    expect((await Tarefa.findById(tarefaAlheia._id)).roupa_entregue).not.toBe(true);
  });

  it('staff recebe 403', async () => {
    const res = await patch(`/api/fornecedor/tarefas/${tarefa1._id}/roupa`, tokens.staff, { roupa_entregue: false });
    expect(res.status).toBe(403);
  });
});

describe('Criar propriedade — validação de fornecedor_id / parceiro_id', () => {
  const criar = (extra) =>
    request(app)
      .post('/api/gestor/propriedades')
      .set('Authorization', `Bearer ${tokens.gestor}`)
      .send({ nome: `Nova ${Math.random()}`, morada: 'Rua Teste 1, Lisboa', ...extra });

  it('rejeita fornecedor de outra empresa (400)', async () => {
    const res = await criar({ fornecedor_id: String(fornAlheio._id) });
    expect(res.status).toBe(400);
  });

  it('rejeita parceiro_id de outra empresa (400)', async () => {
    const res = await criar({ parceiro_id: String(parceiroAlheio._id) });
    expect(res.status).toBe(400);
  });

  it('rejeita utilizador com a role errada (staff como fornecedor) (400)', async () => {
    const res = await criar({ fornecedor_id: String(staffUser._id) });
    expect(res.status).toBe(400);
  });

  it('aceita fornecedor válido da mesma empresa', async () => {
    const res = await criar({ fornecedor_id: String(forn1._id) });
    expect(res.status).toBe(201);
  });
});
