/**
 * Ausência/baixa/falta: tarefas 'em_curso' NÃO são desatribuídas (ficam com a
 * pessoa) e o gestor é avisado (resposta + notificação in-app).
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
const Notificacao = require('../models/Notificacao');
const Ausencia = require('../models/Ausencia');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);

async function cenario(dia = '2032-03-10') {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const s = await mk('Ana', 'staff');
  const p = await Propriedade.create({ nome: 'Casa Azul', empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const token = (await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' })).body.token;
  const tarefa = (estado, hora) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: s._id, data: new Date(`${dia}T${hora}:00Z`), estado });
  return { e, g, s, p, token, tarefa };
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

describe('em_curso nunca é desatribuída', () => {
  test('registar ausência: atribuida -> por_atribuir; em_curso mantém pessoa/estado, é reportada e há sino', async () => {
    const { s, g, token, tarefa } = await cenario();
    const ta = await tarefa('atribuida', '09:00');
    const te = await tarefa('em_curso', '11:00');
    const r = await request(app)
      .post('/api/gestor/ausencias')
      .set('Authorization', 'Bearer ' + token)
      .send({ utilizador_id: String(s._id), data_inicio: '2032-03-10', data_fim: '2032-03-10', tipo: 'doenca' });
    expect(r.status).toBe(201);
    expect(r.body.desatribuicao.desatribuidas).toBe(1);
    expect(r.body.desatribuicao.em_curso_mantidas).toBe(1);
    expect(r.body.desatribuicao.em_curso[0]).toMatchObject({ tarefa_id: String(te._id), propriedade: 'Casa Azul' });
    expect(r.body.desatribuicao.aviso).toMatch(/1 limpeza em curso.*Ana/);

    const a = await Tarefa.findById(ta._id);
    expect(a.estado).toBe('por_atribuir');
    expect(a.utilizador_id).toBeNull();
    const e = await Tarefa.findById(te._id);
    expect(e.estado).toBe('em_curso');
    expect(String(e.utilizador_id)).toBe(String(s._id));

    // aviso persistente ao gestor (não depende do ecrã de quem fez a ação)
    const notif = await Notificacao.find({ utilizador_id: g._id, tipo: 'aviso' });
    expect(notif.length).toBe(1);
    expect(notif[0].mensagem).toMatch(/em curso/);
  });

  test('sem em_curso não há aviso nem notificação', async () => {
    const { s, g, token, tarefa } = await cenario();
    await tarefa('atribuida', '09:00');
    const r = await request(app)
      .post('/api/gestor/ausencias')
      .set('Authorization', 'Bearer ' + token)
      .send({ utilizador_id: String(s._id), data_inicio: '2032-03-10', data_fim: '2032-03-10', tipo: 'ferias' });
    expect(r.body.desatribuicao.em_curso_mantidas).toBe(0);
    expect(r.body.desatribuicao.aviso).toBeUndefined();
    expect(await Notificacao.countDocuments({ utilizador_id: g._id })).toBe(0);
  });

  test('aprovar pedido e reaplicar: mensagem menciona a em_curso e a reatribuição não lhe toca', async () => {
    const { e, s, token, tarefa } = await cenario();
    const outra = await Utilizador.create({ nome: 'Bia', email: `bia${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'staff', ativo: true, dias_folga: [] });
    const te = await tarefa('em_curso', '11:00');
    const au = await Ausencia.create({ utilizador_id: s._id, empresa_id: e._id, data_inicio: new Date('2032-03-10T00:00:00Z'), data_fim: new Date('2032-03-10T00:00:00Z'), tipo: 'doenca', estado: 'pendente' });
    const r = await request(app)
      .patch(`/api/gestor/ausencias/${au._id}/estado`)
      .set('Authorization', 'Bearer ' + token)
      .send({ estado: 'aprovada' });
    expect(r.status).toBe(200);
    expect(r.body.redistribuicao.em_curso_mantidas).toBe(1);
    expect(r.body.mensagem).toMatch(/em curso/);
    const depois = await Tarefa.findById(te._id);
    expect(depois.estado).toBe('em_curso');
    expect(String(depois.utilizador_id)).toBe(String(s._id));
    expect(String(depois.utilizador_id)).not.toBe(String(outra._id));

    const rr = await request(app).post(`/api/gestor/ausencias/${au._id}/reaplicar`).set('Authorization', 'Bearer ' + token);
    expect(rr.status).toBe(200);
    expect(rr.body.redistribuicao.em_curso_mantidas).toBe(1);
    expect(rr.body.mensagem).toMatch(/em curso/);
    expect((await Tarefa.findById(te._id)).estado).toBe('em_curso');
  });

  test('inativar membro desatribui também a em_curso (inativo não consegue autenticar-se)', async () => {
    const { s, token, tarefa } = await cenario(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
    const te = await tarefa('em_curso', '11:00');
    const r = await request(app)
      .patch(`/api/gestor/equipa/${s._id}/estado`)
      .set('Authorization', 'Bearer ' + token)
      .send({ ativo: false });
    expect(r.status).toBe(200);
    expect(r.body.tarefas_desatribuidas).toBe(1);
    const depois = await Tarefa.findById(te._id);
    expect(depois.estado).toBe('por_atribuir');
    expect(depois.utilizador_id).toBeNull();
  });

  test('falta súbita (gestor) mantém a em_curso e avisa', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const { s, token, tarefa } = await cenario(hoje);
    const ta = await tarefa('atribuida', '09:00');
    const te = await tarefa('em_curso', '11:00');
    const r = await request(app).post(`/api/gestor/equipa/${s._id}/falta-subita`).set('Authorization', 'Bearer ' + token).send({});
    expect(r.status).toBe(200);
    expect(r.body.em_curso_mantidas).toBe(1);
    expect(r.body.aviso).toMatch(/em curso/);
    expect((await Tarefa.findById(ta._id)).estado).toBe('por_atribuir');
    expect((await Tarefa.findById(te._id)).estado).toBe('em_curso');
  });
});
