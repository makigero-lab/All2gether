/** Cor do funcionário no calendário: PUT /api/gestor/equipa/:id {cor}. */
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

async function cenario() {
  const e = await Empresa.create({ nome: 'E-' + Math.random() });
  const mk = (role) => Utilizador.create({ nome: role, email: `${role}${Math.random()}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true });
  const gestor = await mk('gestor');
  const staff = await mk('staff');
  return { e, gestor, staff, token: await login(app, gestor) };
}
const put = (token, id, body) => request(app).put(`/api/gestor/equipa/${id}`).set(auth(token)).send(body);

describe('PUT /api/gestor/equipa/:id — cor', () => {
  test('aceita #rrggbb e normaliza para minúsculas', async () => {
    const { staff, token } = await cenario();
    const r = await put(token, staff._id, { cor: '#2563EB' });
    expect(r.status).toBe(200);
    expect((await Utilizador.findById(staff._id)).cor).toBe('#2563eb');
  });

  test('a lista da equipa devolve a cor', async () => {
    const { staff, token } = await cenario();
    await put(token, staff._id, { cor: '#16a34a' });
    const r = await request(app).get('/api/gestor/equipa').set(auth(token));
    const u = r.body.utilizadores.find((x) => String(x._id) === String(staff._id));
    expect(u.cor).toBe('#16a34a');
  });

  test.each([null, ''])('%j repõe a cor automática (null)', async (valor) => {
    const { staff, token } = await cenario();
    await put(token, staff._id, { cor: '#9333ea' });
    const r = await put(token, staff._id, { cor: valor });
    expect(r.status).toBe(200);
    expect((await Utilizador.findById(staff._id)).cor).toBeNull();
  });

  test.each(['azul', '#fff', '#12345', '#1234567', '2563eb', '#gggggg', 'rgb(1,2,3)', 5, true, {}, ['#2563eb']])('recusa %j com 400 e não grava', async (valor) => {
    const { staff, token } = await cenario();
    await put(token, staff._id, { cor: '#0891b2' });
    const r = await put(token, staff._id, { cor: valor });
    expect(r.status).toBe(400);
    expect((await Utilizador.findById(staff._id)).cor).toBe('#0891b2');
  });

  test('gestor de outra empresa não consegue mudar a cor', async () => {
    const a = await cenario();
    const b = await cenario();
    const r = await put(b.token, a.staff._id, { cor: '#db2777' });
    expect([403, 404]).toContain(r.status);
    expect((await Utilizador.findById(a.staff._id)).cor).toBeNull();
  });

  test('staff não pode mudar a cor de ninguém', async () => {
    const { staff, e } = await cenario();
    const tok = await login(app, staff);
    const r = await put(tok, staff._id, { cor: '#db2777' });
    expect(r.status).toBe(403);
    expect((await Utilizador.findById(staff._id)).cor).toBeNull();
    expect(e).toBeTruthy();
  });
});

describe('PUT /api/gestor/equipa/:id — corpo vazio', () => {
  test('a mensagem 400 menciona a cor', async () => {
    const { staff, token } = await cenario();
    const r = await put(token, staff._id, {});
    expect(r.status).toBe(400);
    expect(r.body.erro).toMatch(/cor/);
  });
});
