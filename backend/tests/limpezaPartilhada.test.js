/** Duas saídas no mesmo dia e casa: a 2.ª reserva associa-se à limpeza existente; ciclo de vida. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');

let mongod, token, casa;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const post = (b) => request(app).post('/api/parceiro/reservas').set(auth(token)).send({ propriedade_id: String(casa._id), ...b });
const put = (id, b) => request(app).put(`/api/parceiro/reservas/${id}`).set(auth(token)).send(b);
const del = (id) => request(app).delete(`/api/parceiro/reservas/${id}`).set(auth(token));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const e = await Empresa.create({ nome: 'Partilha' });
  const hash = await bcrypt.hash('teste123', 4);
  const p = await Utilizador.create({ nome: 'P', email: 'p@x.pt', password_hash: hash, empresa_id: e._id, role: 'parceiro', ativo: true });
  casa = await Propriedade.create({ nome: 'Casa P', empresa_id: e._id, ativo: true, capacidade_hospedes: 4, parceiro_id: p._id, tempo_limpeza_minutos: 60 });
  token = (await request(app).post('/api/auth/login').send({ email: 'p@x.pt', password: 'teste123' })).body.token;
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const ativas = (dia) => Tarefa.countDocuments({ propriedade_id: casa._id, estado: { $ne: 'cancelada' }, data: { $gte: new Date(`${dia}T00:00:00Z`), $lt: new Date(`${dia}T23:59:59Z`) } });

describe('limpeza partilhada por duas reservas', () => {
  it('2.ª saída no mesmo dia: 201, aviso, uma só limpeza', async () => {
    const a = await post({ check_in: '2071-01-01', check_out: '2071-01-05' });
    const b = await post({ check_in: '2071-01-02', check_out: '2071-01-05' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.aviso).toMatch(/Já havia uma limpeza/);
    expect(String(b.body.reserva.tarefa_gerada_id)).toBe(String(a.body.tarefa._id));
    expect(await ativas('2071-01-05')).toBe(1);
  });

  it('eliminar a 1.ª mantém a limpeza (passa à 2.ª); eliminar a última cancela', async () => {
    const a = await post({ check_in: '2071-02-01', check_out: '2071-02-05', nome_hospede: 'Um' });
    const b = await post({ check_in: '2071-02-02', check_out: '2071-02-05', nome_hospede: 'Dois' });
    expect((await del(a.body.reserva._id)).status).toBe(200);
    const t = await Tarefa.findById(a.body.tarefa._id);
    expect(t.estado).not.toBe('cancelada');
    expect(t.detalhes_reserva.nome_hospede).toBe('Dois');
    expect((await del(b.body.reserva._id)).status).toBe(200);
    expect((await Tarefa.findById(a.body.tarefa._id)).estado).toBe('cancelada');
  });

  it('mudar a data da 1.ª não cancela a limpeza que a 2.ª ainda usa', async () => {
    const a = await post({ check_in: '2071-03-01', check_out: '2071-03-05' });
    const b = await post({ check_in: '2071-03-02', check_out: '2071-03-05' });
    const u = await put(a.body.reserva._id, { check_out: '2071-03-08' });
    expect(u.status).toBe(200);
    expect((await Tarefa.findById(a.body.tarefa._id)).estado).not.toBe('cancelada');
    expect(String((await ReservaManual.findById(b.body.reserva._id)).tarefa_gerada_id)).toBe(String(a.body.tarefa._id));
    const ra = await ReservaManual.findById(a.body.reserva._id);
    expect(String(ra.tarefa_gerada_id)).not.toBe(String(a.body.tarefa._id));
    expect(await ativas('2071-03-05')).toBe(1);
    expect(await ativas('2071-03-08')).toBe(1);
  });

  it('mudar a data para um dia que já tem limpeza junta-se a ela (sem 409)', async () => {
    const a = await post({ check_in: '2071-04-01', check_out: '2071-04-05' });
    const b = await post({ check_in: '2071-04-02', check_out: '2071-04-09' });
    const u = await put(b.body.reserva._id, { check_out: '2071-04-05' });
    expect(u.status).toBe(200);
    expect(u.body.aviso).toMatch(/Já havia uma limpeza/);
    expect((await Tarefa.findById(b.body.tarefa._id)).estado).toBe('cancelada');
    expect(String((await ReservaManual.findById(b.body.reserva._id)).tarefa_gerada_id)).toBe(String(a.body.tarefa._id));
  });
});
