/**
 * Testes das reservas do parceiro: criar com campos extra, editar e eliminar.
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
const ReservaManual = require('../models/ReservaManual');

const PASSWORD = 'teste123';
let mongod;
let token;
let outroToken;
let casa;

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function criar(extra = {}) {
  const res = await request(app)
    .post('/api/parceiro/reservas')
    .set(auth(token))
    .send({
      propriedade_id: String(casa._id),
      check_in: '2030-06-08',
      check_out: '2030-06-10',
      hospedes: 2,
      nome_hospede: 'Maria',
      plataforma: 'Airbnb',
      hora_checkin: '18:00',
      horario_preferido: '11h - 14h',
      ...extra,
    });
  return res;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const empresa = await Empresa.create({ nome: 'Empresa PR' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true });
  const parceiro = await mk('Parceiro', 'p@x.pt', 'parceiro');
  await mk('Outro', 'o@x.pt', 'parceiro');
  casa = await Propriedade.create({
    nome: 'Casa P', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 5, parceiro_id: parceiro._id,
  });
  token = await login('p@x.pt');
  outroToken = await login('o@x.pt');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Reservas do parceiro', () => {
  it('cria reserva com campos extra e reflete-os na tarefa', async () => {
    const res = await criar();
    expect(res.status).toBe(201);
    expect(res.body.reserva.nome_hospede).toBe('Maria');
    expect(res.body.reserva.horario_preferido).toBe('11h - 14h');
    const t = await Tarefa.findById(res.body.tarefa._id).lean();
    expect(t.detalhes_reserva.nome_hospede).toBe('Maria');
    expect(t.detalhes_reserva.horario_preferido).toBe('11h - 14h');
    expect(t.detalhes_reserva.hora_checkin).toBe('18:00');
  });

  it('rejeita check-out anterior ao check-in e datas inválidas', async () => {
    expect((await criar({ check_in: '2030-06-10', check_out: '2030-06-08' })).status).toBe(400);
    expect((await criar({ check_in: 'xx', check_out: 'yy' })).status).toBe(400);
  });

  it('edita hóspedes/notas e atualiza a mesma tarefa (datas iguais)', async () => {
    const { body } = await criar({ check_in: '2030-07-01', check_out: '2030-07-03' });
    const res = await request(app)
      .put(`/api/parceiro/reservas/${body.reserva._id}`)
      .set(auth(token))
      .send({ hospedes: 4, observacoes: 'berço', horario_preferido: 'depois das 11h' });
    expect(res.status).toBe(200);
    expect(res.body.reserva.hospedes).toBe(4);
    expect(String(res.body.reserva.tarefa_gerada_id._id)).toBe(String(body.tarefa._id));
    const t = await Tarefa.findById(body.tarefa._id).lean();
    expect(t.hospedes).toBe(4);
    expect(t.observacoes).toBe('berço');
    expect(t.detalhes_reserva.horario_preferido).toBe('depois das 11h');
  });

  it('ao mudar o check-out cancela a tarefa antiga e cria uma nova', async () => {
    const { body } = await criar({ check_in: '2030-08-01', check_out: '2030-08-03' });
    const res = await request(app)
      .put(`/api/parceiro/reservas/${body.reserva._id}`)
      .set(auth(token))
      .send({ check_out: '2030-08-05' });
    expect(res.status).toBe(200);
    const antiga = await Tarefa.findById(body.tarefa._id).lean();
    expect(antiga.estado).toBe('cancelada');
    const nova = await Tarefa.findById(res.body.reserva.tarefa_gerada_id._id).lean();
    expect(String(nova._id)).not.toBe(String(body.tarefa._id));
    expect(nova.estado).not.toBe('cancelada');
    expect(nova.detalhes_reserva.checkout).toBe('2030-08-05');
    expect(nova.detalhes_reserva.nome_hospede).toBe('Maria');
  });

  it('bloqueia edição e eliminação quando a limpeza já começou (409)', async () => {
    const { body } = await criar({ check_in: '2030-09-01', check_out: '2030-09-03' });
    await Tarefa.updateOne({ _id: body.tarefa._id }, { estado: 'em_curso' });
    const put = await request(app)
      .put(`/api/parceiro/reservas/${body.reserva._id}`)
      .set(auth(token))
      .send({ hospedes: 3 });
    expect(put.status).toBe(409);
    const del = await request(app).delete(`/api/parceiro/reservas/${body.reserva._id}`).set(auth(token));
    expect(del.status).toBe(409);
    expect(await ReservaManual.findById(body.reserva._id)).not.toBeNull();
  });

  it('elimina a reserva e cancela a tarefa (mantém histórico)', async () => {
    const { body } = await criar({ check_in: '2030-10-01', check_out: '2030-10-03' });
    const del = await request(app).delete(`/api/parceiro/reservas/${body.reserva._id}`).set(auth(token));
    expect(del.status).toBe(200);
    expect(await ReservaManual.findById(body.reserva._id)).toBeNull();
    const t = await Tarefa.findById(body.tarefa._id).lean();
    expect(t.estado).toBe('cancelada');
  });

  it('outro parceiro não consegue editar nem eliminar (404)', async () => {
    const { body } = await criar({ check_in: '2030-11-01', check_out: '2030-11-03' });
    const put = await request(app)
      .put(`/api/parceiro/reservas/${body.reserva._id}`)
      .set(auth(outroToken))
      .send({ hospedes: 1 });
    expect(put.status).toBe(404);
    const del = await request(app).delete(`/api/parceiro/reservas/${body.reserva._id}`).set(auth(outroToken));
    expect(del.status).toBe(404);
    expect(await ReservaManual.findById(body.reserva._id)).not.toBeNull();
  });
});
