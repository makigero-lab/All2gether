/**
 * Testes de regressão de SEGURANÇA (auditoria @AdvogadoDiabo).
 *  - C1: GET /api/gestor/setup removido (não cria contas com password fixa)
 *  - C2: GET /api/cleanup-final removido
 *  - A2: GET /api/gestor/webhooks isolado por empresa
 *  - A5: relatórios (incl. ai-summary) restritos a admin/gestor
 *  - Auth: token sem expiração/algoritmo errado e sem vazamento de detalhe
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const WebhookLog = require('../models/WebhookLog');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');

let mongod;
let empresaA;
let empresaB;
let gestorToken;
let staffToken;
const PASSWORD = 'teste123';

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  empresaA = await Empresa.create({ nome: 'Empresa A' });
  empresaB = await Empresa.create({ nome: 'Empresa B' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  await Utilizador.create({
    nome: 'Gestor A', email: 'gestor@a.pt', password_hash: hash,
    empresa_id: empresaA._id, role: 'gestor', ativo: true,
  });
  await Utilizador.create({
    nome: 'Staff A', email: 'staff@a.pt', password_hash: hash,
    empresa_id: empresaA._id, role: 'staff', ativo: true,
  });
  gestorToken = await login('gestor@a.pt');
  staffToken = await login('staff@a.pt');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Rotas públicas perigosas removidas', () => {
  it('GET /api/gestor/setup devolve 404 e não cria utilizadores', async () => {
    const antes = await Utilizador.countDocuments();
    const res = await request(app).get('/api/gestor/setup');
    expect(res.status).toBe(404);
    expect(await Utilizador.countDocuments()).toBe(antes);
    expect(await Utilizador.findOne({ email: 'admin@all2gether.pt' })).toBeNull();
  });

  it('GET /api/cleanup-final devolve 404', async () => {
    const res = await request(app).get('/api/cleanup-final');
    expect(res.status).toBe(404);
  });
});

describe('Relatórios restritos a gestor/admin', () => {
  it('staff recebe 403 em ai-summary', async () => {
    const res = await request(app)
      .post('/api/gestor/relatorios/ai-summary')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ dados: {} });
    expect(res.status).toBe(403);
  });

  it('staff recebe 403 em produtividade', async () => {
    const res = await request(app)
      .get('/api/gestor/relatorios/produtividade')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });

  it('gestor continua a aceder a produtividade', async () => {
    const res = await request(app)
      .get('/api/gestor/relatorios/produtividade')
      .set('Authorization', `Bearer ${gestorToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/gestor/webhooks — isolamento por empresa', () => {
  it('só devolve logs da empresa do token', async () => {
    await WebhookLog.create({ payload: { x: 'A' }, status: 'processado', empresa_id: empresaA._id });
    await WebhookLog.create({ payload: { x: 'B' }, status: 'processado', empresa_id: empresaB._id });
    await WebhookLog.create({ payload: { x: 'sem-empresa' }, status: 'erro' });

    const res = await request(app)
      .get('/api/gestor/webhooks')
      .set('Authorization', `Bearer ${gestorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.webhooks[0].payload.x).toBe('A');
  });

  it('ignora empresa_id passado na query', async () => {
    const res = await request(app)
      .get(`/api/gestor/webhooks?empresa_id=${empresaB._id}`)
      .set('Authorization', `Bearer ${gestorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.webhooks.every((w) => String(w.empresa_id) === String(empresaA._id))).toBe(true);
  });
});

describe('Autenticação JWT', () => {
  it('rejeita token com algoritmo "none"', async () => {
    const payload = Buffer.from(
      JSON.stringify({ id: 'x', role: 'admin', empresa_id: String(empresaA._id) })
    ).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const res = await request(app)
      .get('/api/gestor/dashboard')
      .set('Authorization', `Bearer ${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it('rejeita token assinado com outro segredo e não vaza detalhe', async () => {
    const falso = jwt.sign({ id: 'x', role: 'admin', empresa_id: String(empresaA._id) }, 'outro-segredo');
    const res = await request(app)
      .get('/api/gestor/dashboard')
      .set('Authorization', `Bearer ${falso}`);
    expect(res.status).toBe(401);
    expect(res.body.detalhe).toBeUndefined();
  });
});

describe('Webhook Smoobu — isolamento por empresa (A1)', () => {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  let propA;
  let propB;

  beforeAll(async () => {
    await Empresa.updateOne(
      { _id: empresaA._id },
      { $set: { 'integracoes.smoobu': { api_key: 'chave-empresa-a', ativo: true } } }
    );
    propA = await Propriedade.create({ nome: 'Casa A', empresa_id: empresaA._id, smoobu_id: '111', ativo: true });
    propB = await Propriedade.create({ nome: 'Casa B', empresa_id: empresaB._id, smoobu_id: '999', ativo: true });
  });

  const payload = (aptId, resId) => ({
    action: 'newReservation',
    data: {
      id: resId,
      apartment: { id: aptId },
      arrival: '2030-05-10',
      departure: '2030-05-12',
      'guest-name': 'Hospede Teste',
      adults: 2,
    },
  });

  it('chave da empresa A NÃO cria tarefas em propriedade da empresa B', async () => {
    const res = await request(app)
      .post('/api/smoobu/webhook')
      .set('X-Smoobu-Api-Key', 'chave-empresa-a')
      .send(payload(999, 7001));
    expect(res.status).toBe(200);
    await esperar(800);
    expect(await Tarefa.countDocuments({ propriedade_id: propB._id })).toBe(0);
    expect(await Tarefa.countDocuments({ empresa_id: empresaB._id })).toBe(0);
  });

  it('chave inválida é rejeitada com 401 (há empresa com chave configurada)', async () => {
    const res = await request(app)
      .post('/api/smoobu/webhook')
      .set('X-Smoobu-Api-Key', 'chave-errada')
      .send(payload(111, 7002));
    expect(res.status).toBe(401);
  });

  it('chave da empresa A cria tarefa na sua própria propriedade (controlo positivo)', async () => {
    const res = await request(app)
      .post('/api/smoobu/webhook')
      .set('X-Smoobu-Api-Key', 'chave-empresa-a')
      .send(payload(111, 7003));
    expect(res.status).toBe(200);
    await esperar(800);
    expect(await Tarefa.countDocuments({ propriedade_id: propA._id })).toBeGreaterThan(0);
  });
});

describe('A4 — token de utilizador desativado/eliminado', () => {
  it('perde acesso imediatamente ao ser desativado, apesar do token válido', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const u = await Utilizador.create({
      nome: 'Gestor Temp', email: 'temp@a.pt', password_hash: hash,
      empresa_id: empresaA._id, role: 'gestor', ativo: true,
    });
    const token = await login('temp@a.pt');
    const ok = await request(app).get('/api/gestor/dashboard').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    await Utilizador.updateOne({ _id: u._id }, { $set: { ativo: false } });
    const bloqueado = await request(app).get('/api/gestor/dashboard').set('Authorization', `Bearer ${token}`);
    expect(bloqueado.status).toBe(401);
  });

  it('perde acesso se for eliminado', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const u = await Utilizador.create({
      nome: 'Gestor Elim', email: 'elim@a.pt', password_hash: hash,
      empresa_id: empresaA._id, role: 'gestor', ativo: true,
    });
    const token = await login('elim@a.pt');
    await Utilizador.updateOne({ _id: u._id }, { $set: { eliminado_em: new Date() } });
    const res = await request(app).get('/api/gestor/dashboard').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('Rate-limit de login por conta', () => {
  beforeAll(() => { process.env.TEST_LOGIN_LIMIT = '1'; });
  afterAll(() => { delete process.env.TEST_LOGIN_LIMIT; });

  it('bloqueia a conta após 10 falhas (429) mas outra conta não é afetada', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/api/auth/login').send({ email: 'gestor@a.pt', password: 'errada' });
      expect(r.status).toBe(401);
    }
    const bloqueada = await request(app).post('/api/auth/login').send({ email: 'gestor@a.pt', password: PASSWORD });
    expect(bloqueada.status).toBe(429);
    const outra = await request(app).post('/api/auth/login').send({ email: 'staff@a.pt', password: PASSWORD });
    expect(outra.status).toBe(200);
  });
});

describe('SSO Autocell — validação do token', () => {
  const SEGREDO = 'segredo-sso-de-teste-com-mais-de-32-caracteres';
  let adminEmail = 'admin-sso@a.pt';
  const sso = (token) => request(app).get(`/api/auth/sso?json=true&token=${encodeURIComponent(token)}`);

  beforeAll(async () => {
    process.env.AUTOCELL_SSO_SECRET = SEGREDO;
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({
      nome: 'Admin SSO', email: adminEmail, password_hash: hash,
      empresa_id: empresaA._id, role: 'admin', ativo: true,
    });
  });
  afterAll(() => { delete process.env.AUTOCELL_SSO_SECRET; });

  it('aceita um token válido (como o emitido pelo Autocell) e rejeita a reutilização', async () => {
    const token = jwt.sign({ email: adminEmail, sub: adminEmail }, SEGREDO, { expiresIn: '5m' });
    const ok = await sso(token);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const replay = await sso(token);
    expect(replay.status).toBe(401);
  });

  it('rejeita segredo errado, token expirado, sem iat e algoritmo diferente', async () => {
    expect((await sso(jwt.sign({ email: adminEmail }, 'outro-segredo', { expiresIn: '5m' }))).status).toBe(401);
    expect((await sso(jwt.sign({ email: adminEmail, jti: 'x1' }, SEGREDO, { expiresIn: -10 }))).status).toBe(401);
    expect((await sso(jwt.sign({ email: adminEmail, jti: 'x2' }, SEGREDO, { noTimestamp: true, expiresIn: '5m' }))).status).toBe(401);
    expect((await sso(jwt.sign({ email: adminEmail, jti: 'x3' }, SEGREDO, { algorithm: 'HS512', expiresIn: '5m' }))).status).toBe(401);
  });

  it('um utilizador que não é admin nunca entra via SSO', async () => {
    const token = jwt.sign({ email: 'gestor@a.pt', sub: 'gestor@a.pt', jti: 'x4' }, SEGREDO, { expiresIn: '5m' });
    expect((await sso(token)).status).toBe(401);
  });
});
