/** /api/auth/me devolve o telefone do próprio e PATCH /api/auth/me guarda-o (todos os perfis). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const { login, auth, hash } = require('./helpersLote');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function criar(role, telefone, empresa) {
  const e = empresa || (await Empresa.create({ nome: 'E-' + Math.random() }));
  const u = await Utilizador.create({ nome: role, email: `${role}${Math.random()}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, telefone });
  return { e, u, token: await login(app, u) };
}

describe('GET /api/auth/me — telefone', () => {
  test.each(['parceiro', 'fornecedor', 'staff', 'gestor'])('%s recebe o seu telefone', async (role) => {
    const { token } = await criar(role, '900 000 001');
    const r = await request(app).get('/api/auth/me').set(auth(token));
    expect(r.status).toBe(200);
    expect(r.body.utilizador.telefone).toBe('900 000 001');
  });

  test('sem telefone guardado devolve string vazia', async () => {
    const { token } = await criar('parceiro', undefined);
    const r = await request(app).get('/api/auth/me').set(auth(token));
    expect(r.body.utilizador.telefone).toBe('');
  });

  test('só devolve o do próprio, nunca o de outro da mesma empresa', async () => {
    const a = await criar('parceiro', '900 000 002');
    const b = await criar('fornecedor', '900 000 003', a.e);
    const r = await request(app).get('/api/auth/me').set(auth(b.token));
    expect(r.body.utilizador.telefone).toBe('900 000 003');
    expect(JSON.stringify(r.body)).not.toContain('900 000 002');
  });
});

describe('PATCH /api/auth/me — guardar telefone', () => {
  test('proprietário guarda e o /me devolve', async () => {
    const { u, token } = await criar('parceiro', '');
    const p = await request(app).patch('/api/auth/me').set(auth(token)).send({ telefone: '  900 000 009 ' });
    expect(p.status).toBe(200);
    expect(p.body.telefone).toBe('900 000 009');
    expect((await Utilizador.findById(u._id)).telefone).toBe('900 000 009');
    const r = await request(app).get('/api/auth/me').set(auth(token));
    expect(r.body.utilizador.telefone).toBe('900 000 009');
  });

  test('não altera o de outra pessoa e rejeita valores inválidos', async () => {
    const a = await criar('parceiro', '900 000 010');
    const b = await criar('fornecedor', '900 000 011', a.e);
    await request(app).patch('/api/auth/me').set(auth(b.token)).send({ telefone: '900 000 012' });
    expect((await Utilizador.findById(a.u._id)).telefone).toBe('900 000 010');
    for (const t of [undefined, null, 5, 'x'.repeat(31), '<b>1</b>']) {
      const r = await request(app).patch('/api/auth/me').set(auth(b.token)).send({ telefone: t });
      expect(r.status).toBe(400);
    }
  });

  test('só aceita números, espaços e + - ( )', async () => {
    const { token } = await criar('parceiro', '');
    for (const t of ['abc', 'javascript:1', '9\n1', '900"1', '900\u00001']) {
      const r = await request(app).patch('/api/auth/me').set(auth(token)).send({ telefone: t });
      expect(r.status).toBe(400);
    }
    const ok = await request(app).patch('/api/auth/me').set(auth(token)).send({ telefone: '+351 (21) 900-000' });
    expect(ok.status).toBe(200);
    const vazio = await request(app).patch('/api/auth/me').set(auth(token)).send({ telefone: '' });
    expect(vazio.status).toBe(200);
  });

  test('sessão de suporte (impersonação) não altera o telefone', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    const { u, e } = await criar('gestor', '900 000 020');
    const token = jwt.sign({ id: String(u._id), role: 'gestor', empresa_id: String(e._id), imp: String(new mongoose.Types.ObjectId()) }, JWT_SECRET, { expiresIn: '1h' });
    const r = await request(app).patch('/api/auth/me').set(auth(token)).send({ telefone: '999' });
    expect(r.status).toBe(403);
    expect((await Utilizador.findById(u._id)).telefone).toBe('900 000 020');
  });

  test('sem sessão é recusado', async () => {
    const r = await request(app).patch('/api/auth/me').send({ telefone: '900' });
    expect(r.status).toBe(401);
  });
});
