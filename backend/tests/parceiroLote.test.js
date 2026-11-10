/** B1 (idempotência), B3 (notificações agregadas) do parceiro. */
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
const Notificacao = require('../models/Notificacao');
const { enviarPendentesAgora } = require('../utils/notificarAgregado');

const PASSWORD = 'teste123';
let mongod, token, casa, casa2, staff = [];
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const post = (body) => request(app).post('/api/parceiro/reservas').set(auth(token)).send(body);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ReservaManual.init();
  const empresa = await Empresa.create({ nome: 'Empresa B1' });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const mk = (nome, email, role) => Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true, dias_folga: [] });
  const parceiro = await mk('Parceiro', 'p@x.pt', 'parceiro');
  staff = [await mk('Ana', 'a@x.pt', 'staff'), await mk('Bia', 'b@x.pt', 'staff')];
  casa = await Propriedade.create({ nome: 'Casa B1', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 5, parceiro_id: parceiro._id, tempo_limpeza_minutos: 60, staff_necessario: 2 });
  casa2 = await Propriedade.create({ nome: 'Casa B2', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 5, parceiro_id: parceiro._id, tempo_limpeza_minutos: 60, staff_necessario: 1 });
  token = (await request(app).post('/api/auth/login').send({ email: 'p@x.pt', password: PASSWORD })).body.token;
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('B1 idempotência', () => {
  const base = () => ({ propriedade_id: String(casa._id), check_in: '2031-03-01', check_out: '2031-03-03', chave_idempotencia: 'nova-1' });

  it('o mesmo tmp reenviado não cria segunda reserva nem limpeza', async () => {
    const a = await post(base());
    expect(a.status).toBe(201);
    const b = await post(base());
    expect(b.status).toBe(200);
    expect(b.body.repetida).toBe(true);
    expect(String(b.body.reserva._id)).toBe(String(a.body.reserva._id));
    expect(await ReservaManual.countDocuments({ chave_idempotencia: 'nova-1' })).toBe(1);
    expect(await Tarefa.countDocuments({ propriedade_id: casa._id, data: { $gte: new Date('2031-03-03T00:00:00Z'), $lt: new Date('2031-03-04T00:00:00Z') } })).toBe(1);
  });

  it('pedidos simultâneos com a mesma chave criam só uma', async () => {
    const corpo = { ...base(), check_in: '2031-04-01', check_out: '2031-04-03', chave_idempotencia: 'nova-par' };
    const rs = await Promise.all([post(corpo), post(corpo), post(corpo)]);
    expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await ReservaManual.countDocuments({ chave_idempotencia: 'nova-par' })).toBe(1);
    expect(await Tarefa.countDocuments({ propriedade_id: casa._id, data: { $gte: new Date('2031-04-03T00:00:00Z'), $lt: new Date('2031-04-04T00:00:00Z') }, estado: { $ne: 'cancelada' } })).toBe(1);
  });

  it('chave diferente mas mesma casa e dia de check-out: grava e associa à limpeza existente, com aviso', async () => {
    const r = await post({ ...base(), chave_idempotencia: 'outra-chave' });
    expect(r.status).toBe(201);
    expect(r.body.associada_a_existente).toBe(true);
    expect(r.body.aviso).toMatch(/Já havia uma limpeza/);
    const primeira = await ReservaManual.findOne({ chave_idempotencia: 'nova-1' }).lean();
    expect(String(r.body.reserva.tarefa_gerada_id)).toBe(String(primeira.tarefa_gerada_id));
    expect(await ReservaManual.countDocuments({ chave_idempotencia: 'outra-chave' })).toBe(1);
    // reenvio com a mesma chave continua idempotente
    const again = await post({ ...base(), chave_idempotencia: 'outra-chave' });
    expect(again.status).toBe(200);
    expect(again.body.repetida).toBe(true);
    expect(await Tarefa.countDocuments({ propriedade_id: casa._id, estado: { $ne: 'cancelada' }, data: { $gte: new Date('2031-03-03T00:00:00Z'), $lt: new Date('2031-03-04T00:00:00Z') } })).toBe(1);
  });

  it('casos legítimos passam: outra casa no mesmo dia e saída/entrada no mesmo dia', async () => {
    const outraCasa = await post({ ...base(), propriedade_id: String(casa2._id), chave_idempotencia: 'k-casa2' });
    expect(outraCasa.status).toBe(201);
    // a reserva seguinte entra no dia em que a anterior sai (check-out noutro dia)
    const seguinte = await post({ ...base(), check_in: '2031-03-03', check_out: '2031-03-06', chave_idempotencia: 'k-seg' });
    expect(seguinte.status).toBe(201);
  });
});

describe('B3 notificações ao gravar', () => {
  beforeEach(async () => { await enviarPendentesAgora(); await Notificacao.deleteMany({}); });

  it('criação: cada membro recebe UMA notificação mesmo com várias linhas', async () => {
    const r1 = await post({ propriedade_id: String(casa._id), check_in: '2032-05-01', check_out: '2032-05-02', chave_idempotencia: 'n1' });
    const r2 = await post({ propriedade_id: String(casa._id), check_in: '2032-05-03', check_out: '2032-05-04', chave_idempotencia: 'n2' });
    expect(r1.status).toBe(201); expect(r2.status).toBe(201);
    await enviarPendentesAgora();
    for (const s of staff) {
      const ns = await Notificacao.find({ utilizador_id: s._id });
      expect(ns).toHaveLength(1);
      expect(ns[0].mensagem).toMatch(/2 alterações/);
    }
  });

  it('alteração de datas: avisa quem saiu da limpeza cancelada e quem entrou na nova', async () => {
    const r = await post({ propriedade_id: String(casa._id), check_in: '2032-06-01', check_out: '2032-06-02', chave_idempotencia: 'm1' });
    await enviarPendentesAgora();
    await Notificacao.deleteMany({});
    const antes = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(antes.equipa_atribuida.length).toBe(2);
    const put = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(token)).send({ check_out: '2032-06-05' });
    expect(put.status).toBe(200);
    await enviarPendentesAgora();
    const velha = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(velha.estado).toBe('cancelada');
    for (const s of staff) {
      const ns = await Notificacao.find({ utilizador_id: s._id }).lean();
      expect(ns.map((n) => n.tipo).sort()).toEqual(['tarefa_atribuida', 'tarefa_cancelada']);
    }
  });
});
