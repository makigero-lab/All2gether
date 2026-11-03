/**
 * Testes do webhook do Smoobu, com payloads no formato da documentação oficial
 * (docs.smoobu.com › Webhooks): { action, user, data: { ... } }.
 *
 *  - newReservation cria a tarefa e guarda os dados da reserva
 *  - cancelReservation / deleteReservation (nomes oficiais) cancelam a tarefa
 *  - updateReservation com type "cancellation" cancela a tarefa
 *  - ações sem impacto (newMessage, onlineCheckInUpdate, updateRates) não criam tarefas
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');

const CHAVE = 'chave-smoobu-de-teste';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod;
let empresa;
let casa;

const webhook = (action, data) =>
  request(app)
    .post('/api/smoobu/webhook')
    .set('X-Smoobu-Api-Key', CHAVE)
    .send({ action, user: 1, data });

const reserva = (id, extra = {}) => ({
  id,
  'reference-id': `REF-${id}`,
  type: 'reservation',
  arrival: '2031-03-10',
  departure: '2031-03-14',
  'created-at': '2031-01-01 10:00:00',
  modifiedAt: '2031-01-01 10:00:00',
  apartment: { id: 555, name: 'Casa Teste' },
  channel: { id: 1, name: 'Airbnb' },
  'guest-name': 'Maria Silva',
  firstname: 'Maria',
  lastname: 'Silva',
  email: 'maria@exemplo.pt',
  phone: '+351910000000',
  adults: 2,
  children: 1,
  'check-in': '15:00',
  'check-out': '11:00',
  notice: 'Chegada tardia',
  'is-blocked-booking': false,
  guestId: 77,
  ...extra,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  empresa = await Empresa.create({
    nome: 'Empresa Smoobu',
    integracoes: { smoobu: { api_key: CHAVE, ativo: true } },
  });
  casa = await Propriedade.create({
    nome: 'Casa Teste', empresa_id: empresa._id, smoobu_id: '555', ativo: true, capacidade_hospedes: 6,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const tarefaDaReserva = (id) => Tarefa.findOne({ smoobu_reserva_id: String(id) });

describe('Webhook Smoobu — criação', () => {
  it('newReservation cria a tarefa e guarda datas, hóspede e nº de pessoas', async () => {
    const res = await webhook('newReservation', reserva(9001));
    expect(res.status).toBe(200);
    await esperar(900);
    const t = await tarefaDaReserva(9001);
    expect(t).not.toBeNull();
    expect(t.estado).not.toBe('cancelada');
    expect(String(t.propriedade_id)).toBe(String(casa._id));
    expect(t.detalhes_reserva.checkin).toBe('2031-03-10');
    expect(t.detalhes_reserva.checkout).toBe('2031-03-14');
    expect(t.detalhes_reserva.pax).toBe(3); // adults + children
    expect(t.detalhes_reserva.nome_hospede).toBe('Maria Silva');
  });
});

describe('Webhook Smoobu — cancelamentos', () => {
  const cancelaCom = async (idReserva, action, extraData = {}) => {
    await webhook('newReservation', reserva(idReserva));
    await esperar(900);
    expect((await tarefaDaReserva(idReserva)).estado).not.toBe('cancelada');
    const res = await webhook(action, reserva(idReserva, extraData));
    expect(res.status).toBe(200);
    await esperar(900);
    return tarefaDaReserva(idReserva);
  };

  it('cancelReservation (nome oficial) cancela a tarefa', async () => {
    const t = await cancelaCom(9002, 'cancelReservation', { type: 'cancellation' });
    expect(t.estado).toBe('cancelada');
  });

  it('deleteReservation (nome oficial) cancela a tarefa', async () => {
    const t = await cancelaCom(9003, 'deleteReservation');
    expect(t.estado).toBe('cancelada');
  });

  it('updateReservation com type "cancellation" cancela a tarefa', async () => {
    const t = await cancelaCom(9004, 'updateReservation', { type: 'cancellation' });
    expect(t.estado).toBe('cancelada');
  });

  it('updateReservation normal NÃO cancela a tarefa', async () => {
    await webhook('newReservation', reserva(9005));
    await esperar(900);
    await webhook('updateReservation', reserva(9005, { type: 'modification of booking' }));
    await esperar(900);
    expect((await tarefaDaReserva(9005)).estado).not.toBe('cancelada');
  });
});

describe('Webhook Smoobu — ações sem impacto nas limpezas', () => {
  it('newMessage, onlineCheckInUpdate e updateRates respondem 200 e não criam tarefas', async () => {
    const antes = await Tarefa.countDocuments();
    expect((await webhook('newMessage', { id: 1, sender: 'guest', booking: { id: 9001 } })).status).toBe(200);
    expect((await webhook('onlineCheckInUpdate', { bookingId: 9001 })).status).toBe(200);
    expect((await webhook('updateRates', { 555: { '2031-04-01': { price: 100, min_length_of_stay: 2, available: 1 } } })).status).toBe(200);
    await esperar(600);
    expect(await Tarefa.countDocuments()).toBe(antes);
  });
});
