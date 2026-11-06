/**
 * Limpezas com 2 ou mais pessoas: equipa_atribuida é a equipa completa,
 * utilizador_id é o responsável. Todos veem e podem agir; ausência de um
 * membro tira só esse; sem substituto o gestor é avisado ("falta 1 pessoa").
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
const { calcularCargaLimpezaDia } = require('../utils/loadBalancer');
const { calcularCargaDiaUtilizador } = require('../utils/scheduler');
const { idsEquipa, normalizarEquipa } = require('../utils/equipaTarefa');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });

async function login(u) {
  return (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
}

async function cenario({ extra = 1, staffNecessario = 2 } = {}) {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const substitutos = [];
  for (let i = 0; i < extra; i++) substitutos.push(await mk('Sub' + i, 'staff'));
  const fora = await mk('Fora', 'staff');
  const p = await Propriedade.create({
    nome: 'Casa Dupla', empresa_id: e._id, smoobu_id: String(++n), ativo: true,
    capacidade_hospedes: 6, tempo_limpeza_minutos: 60, staff_necessario: staffNecessario,
  });
  const tarefa = (dia, extraCampos = {}) =>
    Tarefa.create({
      empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id,
      equipa_atribuida: [ana._id, bia._id], data: new Date(`${dia}T10:00:00Z`),
      tempo_limpeza_minutos: 60, estado: 'atribuida', ...extraCampos,
    });
  return { e, g, ana, bia, substitutos, fora, p, tarefa, token: await login(g) };
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

describe('helper de equipa', () => {
  test('tarefa antiga com equipa vazia equivale a equipa só com utilizador_id', () => {
    expect(idsEquipa({ utilizador_id: 'a', equipa_atribuida: [] })).toEqual(['a']);
    expect(idsEquipa({ utilizador_id: 'a', equipa_atribuida: ['b', 'a', 'b'] })).toEqual(['a', 'b']);
    expect(normalizarEquipa(null, ['x', 'y']).utilizador_id.toString()).toBe('x');
  });

  test('o responsável é sempre membro quando a equipa existe (hook do modelo)', async () => {
    const { ana, bia, tarefa } = await cenario();
    const t = await tarefa('2035-01-10', { utilizador_id: bia._id, equipa_atribuida: [ana._id] });
    const d = await Tarefa.findById(t._id);
    expect(d.equipa_atribuida.map(String)).toEqual([String(bia._id), String(ana._id)]);
  });
});

describe('portal: o segundo membro vê e age; quem está fora não', () => {
  test('lista, detalhe e conclusão para o membro secundário; 404 para quem não é da equipa', async () => {
    const { bia, fora, tarefa } = await cenario();
    const hoje = new Date().toISOString().slice(0, 10);
    const t = await tarefa(hoje);
    const tokBia = await login(bia);
    const tokFora = await login(fora);

    const lista = await request(app).get('/api/auth/me/tarefas').set(auth(tokBia));
    expect(lista.body.tarefas.map((x) => String(x._id))).toContain(String(t._id));
    const listaFora = await request(app).get('/api/auth/me/tarefas').set(auth(tokFora));
    expect(listaFora.body.tarefas.map((x) => String(x._id))).not.toContain(String(t._id));

    expect((await request(app).get(`/api/auth/me/tarefas/${t._id}`).set(auth(tokBia))).status).toBe(200);
    expect((await request(app).get(`/api/auth/me/tarefas/${t._id}`).set(auth(tokFora))).status).toBe(404);

    const cal = await request(app).get('/api/auth/me/calendario').set(auth(tokBia));
    expect(cal.body.tarefas.map((x) => String(x._id))).toContain(String(t._id));

    // avaria, atraso e checklist também só para membros
    expect((await request(app).post(`/api/staff/tarefas/${t._id}/atraso`).set(auth(tokFora)).send({ minutos_atraso: 15 })).status).toBe(404);
    expect((await request(app).post(`/api/staff/tarefas/${t._id}/avaria`).set(auth(tokFora)).send({ descricao: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/staff/tarefas/${t._id}/avaria`).set(auth(tokBia)).send({ descricao: 'torneira' })).status).toBe(200);
    expect((await request(app).post(`/api/staff/tarefas/${t._id}/atraso`).set(auth(tokBia)).send({ minutos_atraso: 15 })).status).toBe(200);

    const semAcesso = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(tokFora)).send({ fotos_conclusao: ['data:image/jpeg;base64,AAAA'] });
    expect(semAcesso.status).toBe(404);
    const ok = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(tokBia)).send({ fotos_conclusao: ['data:image/jpeg;base64,AAAA'] });
    expect(ok.status).toBe(200);
    expect((await Tarefa.findById(t._id)).estado).toBe('concluida');
  });
});

describe('carga e conflitos contam para os dois', () => {
  test('carga diária do secundário inclui a tarefa de equipa', async () => {
    const { e, bia, tarefa } = await cenario();
    await tarefa('2035-02-10');
    const range = { start: new Date('2035-02-10T00:00:00Z'), end: new Date('2035-02-11T00:00:00Z') };
    expect(await calcularCargaLimpezaDia(e._id, bia._id, range)).toBe(60);
    expect(await calcularCargaDiaUtilizador(bia._id, new Date('2035-02-10T10:00:00Z'))).toBe(60);
  });
});

describe('ausência de um membro', () => {
  const baixa = (token, id, dia) =>
    request(app).post(`/api/gestor/equipa/${id}/baixa`).set(auth(token)).send({ data_inicio: dia, data_fim: dia, tipo: 'doenca' });

  test('responsável ausente com substituto: sai só ele, o secundário passa a responsável, entra o substituto', async () => {
    const { ana, bia, substitutos, token, tarefa } = await cenario({ extra: 1 });
    const t = await tarefa('2035-03-10');
    const r = await baixa(token, ana._id, '2035-03-10');
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(String(d.utilizador_id)).toBe(String(bia._id));
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(bia._id), String(substitutos[0]._id)].sort());
    expect(d.pessoas_em_falta).toBe(0);
    expect(d.equipa_atribuida.map(String)).not.toContain(String(ana._id));
  });

  test('secundário ausente com substituto: o responsável fica e entra o substituto', async () => {
    const { ana, bia, substitutos, token, tarefa } = await cenario({ extra: 1 });
    const t = await tarefa('2035-03-11');
    expect((await baixa(token, bia._id, '2035-03-11')).status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(String(d.utilizador_id)).toBe(String(ana._id));
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(ana._id), String(substitutos[0]._id)].sort());
    expect(d.pessoas_em_falta).toBe(0);
  });

  test('sem substituto: fica com os restantes, "falta 1 pessoa" na tarefa e aviso ao gestor', async () => {
    const { ana, bia, g, token, tarefa } = await cenario({ extra: 0 });
    // o "Fora" também está indisponível nesse dia
    const fora = await Utilizador.findOne({ nome: 'Fora', empresa_id: g.empresa_id });
    const Ausencia = require('../models/Ausencia');
    await Ausencia.create({ utilizador_id: fora._id, empresa_id: g.empresa_id, data_inicio: new Date('2035-03-12T00:00:00Z'), data_fim: new Date('2035-03-12T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const t = await tarefa('2035-03-12');
    expect((await baixa(token, bia._id, '2035-03-12')).status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.equipa_atribuida.map(String)).toEqual([String(ana._id)]);
    expect(String(d.utilizador_id)).toBe(String(ana._id));
    expect(d.pessoas_em_falta).toBe(1);
    const aviso = await Notificacao.find({ utilizador_id: g._id, mensagem: /falta 1 pessoa/ });
    expect(aviso.length).toBe(1);
  });

  test('os dois ausentes e ninguém disponível: por_atribuir, sem equipa', async () => {
    const { ana, bia, g, token, tarefa } = await cenario({ extra: 0 });
    const fora = await Utilizador.findOne({ nome: 'Fora', empresa_id: g.empresa_id });
    const Ausencia = require('../models/Ausencia');
    await Ausencia.create({ utilizador_id: fora._id, empresa_id: g.empresa_id, data_inicio: new Date('2035-03-13T00:00:00Z'), data_fim: new Date('2035-03-13T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const t = await tarefa('2035-03-13');
    await baixa(token, ana._id, '2035-03-13');
    await baixa(token, bia._id, '2035-03-13');
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('por_atribuir');
    expect(d.utilizador_id).toBeNull();
    expect(d.equipa_atribuida).toHaveLength(0);
    expect(d.motivo_nao_atribuicao).toMatch(/ausente, de folga/);
  });

  test('em curso: ninguém sai e o gestor é avisado', async () => {
    const { ana, bia, g, token, tarefa } = await cenario({ extra: 1 });
    const t = await tarefa('2035-03-14', { estado: 'em_curso' });
    const r = await baixa(token, bia._id, '2035-03-14');
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(ana._id), String(bia._id)].sort());
    expect(r.body.em_curso_mantidas).toBe(1);
    expect((await Notificacao.find({ utilizador_id: g._id, mensagem: /em curso/ })).length).toBeGreaterThan(0);
  });
});

describe('atribuição automática com staff_necessario 2', () => {
  test('auto-atribuir põe 2 pessoas distintas e notifica cada uma uma vez', async () => {
    const { token, tarefa } = await cenario({ extra: 1 });
    const t = await tarefa('2035-04-10', { estado: 'por_atribuir', utilizador_id: null, equipa_atribuida: [] });
    const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(token)).send({});
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.equipa_atribuida).toHaveLength(2);
    expect(new Set(d.equipa_atribuida.map(String)).size).toBe(2);
    expect(String(d.utilizador_id)).toBe(String(d.equipa_atribuida[0]));
  });

  test('há menos gente do que staff_necessario: fica com a equipa parcial e pessoas_em_falta > 0', async () => {
    const { token, tarefa } = await cenario({ extra: 0, staffNecessario: 5 });
    const t = await tarefa('2035-04-11', { estado: 'por_atribuir', utilizador_id: null, equipa_atribuida: [] });
    await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(token)).send({});
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.equipa_atribuida.length).toBe(3); // só existem 3 staff
    expect(d.pessoas_em_falta).toBe(2);
  });
});

describe('atribuição manual do gestor', () => {
  test('escolher uma pessoa substitui o responsável e MANTÉM os outros membros', async () => {
    const { ana, bia, fora, token, tarefa } = await cenario();
    const t = await tarefa('2035-05-10');
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(token)).send({ utilizador_id: String(fora._id) });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(String(d.utilizador_id)).toBe(String(fora._id));
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(fora._id), String(bia._id)].sort());
    expect(d.equipa_atribuida.map(String)).not.toContain(String(ana._id));
  });

  test('equipa_atribuida explícita define a equipa completa', async () => {
    const { ana, bia, fora, token, tarefa } = await cenario();
    const t = await tarefa('2035-05-11');
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(token))
      .send({ utilizador_id: String(fora._id), equipa_atribuida: [String(fora._id), String(ana._id)] });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(fora._id), String(ana._id)].sort());
    expect(d.equipa_atribuida.map(String)).not.toContain(String(bia._id));
  });

  test('tarefa antiga (equipa vazia) com uma pessoa continua a funcionar como antes', async () => {
    const { ana, fora, token, tarefa } = await cenario();
    const t = await tarefa('2035-05-12', { equipa_atribuida: [] });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(token)).send({ utilizador_id: String(fora._id) });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(String(d.utilizador_id)).toBe(String(fora._id));
    expect(d.equipa_atribuida).toHaveLength(0);
    expect(idsEquipa(d)).toEqual([String(fora._id)]);
    expect(idsEquipa(d)).not.toContain(String(ana._id));
  });
});
