/**
 * Motivo de não atribuição: reflete a causa real (ninguém disponível vs. lotação),
 * é limpo quando a tarefa passa a ter pessoa, e o dashboard conta também as
 * 'nao_atribuida' do dia.
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
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const { diagnosticarFaltaDeStaff } = require('../utils/atribuicaoAutomatica');
const { autoAtribuicaoEmergencia } = require('../jobs/caoGuarda');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });

async function cenario() {
  const e = await Empresa.create({ nome: 'M' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const p = await Propriedade.create({ nome: 'Casa Azul', empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const token = (await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' })).body.token;
  const tarefa = (dia, extra = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date(`${dia}T10:00:00Z`), estado: 'por_atribuir', ...extra });
  return { e, g, ana, p, token, tarefa };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('motivo de não atribuição', () => {
  test('equipa toda ausente: o motivo é a ausência, nunca a lotação, e a tarefa continua por atribuir', async () => {
    const { e, ana, token, tarefa } = await cenario();
    await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: new Date('2033-03-10T00:00:00Z'), data_fim: new Date('2033-03-10T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const t = await tarefa('2033-03-10');
    const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(token)).send({});
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('por_atribuir');
    expect(d.motivo_nao_atribuicao).toMatch(/ausente/i);
    expect(d.motivo_nao_atribuicao).not.toMatch(/Lotação/);
  });

  test('há quem esteja disponível mas ninguém cabe no limite diário: nao_atribuida com motivo de lotação', async () => {
    const { token, tarefa } = await cenario();
    const t = await tarefa('2033-03-11', { tempo_limpeza_minutos: 900 });
    const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(token)).send({});
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('nao_atribuida');
    expect(d.motivo_nao_atribuicao).toMatch(/Lotação/);
  });

  test('ao ser atribuída (automático), o motivo antigo é limpo', async () => {
    const { ana, token, tarefa } = await cenario();
    const t = await tarefa('2033-03-12', { estado: 'nao_atribuida', motivo_nao_atribuicao: 'Lotação máxima excedida (toda a equipa > 8h/dia)' });
    const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(token)).send({});
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(String(d.utilizador_id)).toBe(String(ana._id));
    expect(d.motivo_nao_atribuicao).toBeNull();
  });

  test('ao ser atribuída (manual), o motivo antigo é limpo', async () => {
    const { ana, token, tarefa } = await cenario();
    const t = await tarefa('2033-03-13', { motivo_nao_atribuicao: 'Sem equipa disponível' });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(token)).send({ utilizador_id: String(ana._id) });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.motivo_nao_atribuicao).toBeNull();
  });
});

describe('dashboard: tarefasPorAtribuir', () => {
  test('conta por_atribuir e nao_atribuida de hoje, e não as atribuídas', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const { ana, token, tarefa } = await cenario();
    await tarefa(hoje);
    await tarefa(hoje, { estado: 'nao_atribuida' });
    await tarefa(hoje, { estado: 'atribuida', utilizador_id: ana._id });
    const r = await request(app).get('/api/gestor/dashboard').set(auth(token));
    expect(r.status).toBe(200);
    expect(r.body.tarefasPorAtribuir).toBe(2);
    expect(r.body.checkinsEmRisco.total).toBeLessThanOrEqual(2);
  });
});

describe('diagnóstico partilhado e outros caminhos', () => {
  const range = (dia) => ({ start: new Date(`${dia}T00:00:00Z`), end: new Date(new Date(`${dia}T00:00:00Z`).getTime() + 86400000) });

  test('diagnosticarFaltaDeStaff distingue sem equipa, ausência e lotação', async () => {
    const vazia = await Empresa.create({ nome: 'Vazia' + ++n });
    expect((await diagnosticarFaltaDeStaff(vazia._id, range('2033-04-01'))).causa).toBe('sem_equipa');

    const { e, ana } = await cenario();
    expect((await diagnosticarFaltaDeStaff(e._id, range('2033-04-01'))).causa).toBe('lotacao');
    await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: new Date('2033-04-01T00:00:00Z'), data_fim: new Date('2033-04-01T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const d = await diagnosticarFaltaDeStaff(e._id, range('2033-04-01'));
    expect(d.causa).toBe('indisponivel');
    expect(d.estado).toBe('por_atribuir');
  });

  test('parceiro: reserva com toda a equipa ausente fica por atribuir com o motivo real', async () => {
    const { e, ana, p } = await cenario();
    const parceiro = await Utilizador.create({ nome: 'Par', email: `par${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'parceiro', ativo: true });
    await Propriedade.updateOne({ _id: p._id }, { parceiro_id: parceiro._id });
    await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: new Date('2033-05-10T00:00:00Z'), data_fim: new Date('2033-05-10T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const tk = (await request(app).post('/api/auth/login').send({ email: parceiro.email, password: 'p-de-teste-123' })).body.token;
    const r = await request(app).post('/api/parceiro/reservas').set(auth(tk)).send({ propriedade_id: String(p._id), check_in: '2033-05-08', check_out: '2033-05-10' });
    expect(r.status).toBe(201);
    const t = await Tarefa.findOne({ propriedade_id: p._id });
    expect(t.estado).toBe('por_atribuir');
    expect(t.motivo_nao_atribuicao).toMatch(/ausente, de folga/);
    expect(t.motivo_nao_atribuicao).not.toMatch(/lotação/i);
  });

  test('cão de guarda: equipa ausente amanhã não vira nao_atribuida e grava o motivo real', async () => {
    const { e, ana, tarefa } = await cenario();
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await Ausencia.create({ utilizador_id: ana._id, empresa_id: e._id, data_inicio: new Date(`${amanha}T00:00:00Z`), data_fim: new Date(`${amanha}T00:00:00Z`), tipo: 'ferias', estado: 'aprovada' });
    const t = await tarefa(amanha);
    await autoAtribuicaoEmergencia();
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('por_atribuir');
    expect(d.motivo_nao_atribuicao).toMatch(/ausente, de folga/);
  });
});
