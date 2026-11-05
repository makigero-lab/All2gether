/**
 * Alterar as datas de uma reserva do parceiro: a limpeza antiga deixa de estar
 * ativa e a da nova data é gerada e atribuída com staff_necessario.
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
let token;
let casaDupla;
let staffIds;

const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const empresa = await Empresa.create({ nome: 'Empresa Datas' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true });
  const parceiro = await mk('Parceiro', 'p@datas.pt', 'parceiro');
  const a = await mk('Ana', 'a@datas.pt', 'staff');
  const b = await mk('Bruno', 'b@datas.pt', 'staff');
  await mk('Carla', 'c@datas.pt', 'staff');
  staffIds = [a, b].map((u) => String(u._id));
  casaDupla = await Propriedade.create({
    nome: 'Casa Dupla', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 6,
    parceiro_id: parceiro._id, staff_necessario: 2, tempo_limpeza_minutos: 60,
  });
  const res = await request(app).post('/api/auth/login').send({ email: 'p@datas.pt', password: PASSWORD });
  token = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('parceiro altera as datas da reserva', () => {
  it('cancela a limpeza antiga e atribui a da nova data a 2 pessoas distintas', async () => {
    const criada = await request(app).post('/api/parceiro/reservas').set(auth(token)).send({
      propriedade_id: String(casaDupla._id), check_in: '2031-03-01', check_out: '2031-03-03', hospedes: 4,
    });
    expect(criada.status).toBe(201);
    const antiga = await Tarefa.findById(criada.body.tarefa._id).lean();
    expect(antiga.estado).toBe('atribuida');
    expect(antiga.equipa_atribuida).toHaveLength(2);

    const res = await request(app)
      .put(`/api/parceiro/reservas/${criada.body.reserva._id}`)
      .set(auth(token))
      .send({ check_in: '2031-03-08', check_out: '2031-03-10' });
    expect(res.status).toBe(200);

    const antigaDepois = await Tarefa.findById(antiga._id).lean();
    expect(antigaDepois.estado).toBe('cancelada');
    expect(antigaDepois.utilizador_id).toBeNull();

    const ativas = await Tarefa.find({ propriedade_id: casaDupla._id, estado: { $ne: 'cancelada' } }).lean();
    expect(ativas).toHaveLength(1);
    const nova = ativas[0];
    expect(nova.detalhes_reserva.checkout).toBe('2031-03-10');
    expect(new Date(nova.data).toISOString().slice(0, 10)).toBe('2031-03-10');
    expect(nova.estado).toBe('atribuida');
    expect(nova.equipa_atribuida).toHaveLength(2);
    expect(new Set(nova.equipa_atribuida.map(String)).size).toBe(2);
    expect(String(nova.utilizador_id)).toBe(String(nova.equipa_atribuida[0]));
  });
});
