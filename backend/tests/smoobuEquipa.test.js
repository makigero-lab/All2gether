/** C1: caminho Smoobu com staff_necessario = 2 (criação e mudança de data). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const WebhookLog = require('../models/WebhookLog');

const CHAVE = 'chave-smoobu-equipa';
let mongod, empresa, casa, ana, bia, cris;

const esperar = async () => {
  await new Promise((r) => setTimeout(r, 150));
  const limite = Date.now() + 10000;
  while (Date.now() < limite) {
    if ((await WebhookLog.countDocuments({ status: 'recebido' })) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const webhook = (action, data) => request(app).post('/api/smoobu/webhook').set('X-Smoobu-Api-Key', CHAVE).send({ action, user: 1, data });
const reserva = (id, extra = {}) => ({
  id, 'reference-id': `REF-${id}`, type: 'reservation', arrival: '2033-03-10', departure: '2033-03-14',
  'created-at': '2033-01-01 10:00:00', modifiedAt: '2033-01-01 10:00:00', apartment: { id: 777, name: 'Casa Dupla' },
  channel: { id: 1, name: 'Airbnb' }, 'guest-name': 'Maria', adults: 2, children: 0, 'is-blocked-booking': false, ...extra,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  empresa = await Empresa.create({ nome: 'Empresa Equipa', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
  const hash = await bcrypt.hash('x-teste-123', 4);
  const mk = (nome, role = 'staff') => Utilizador.create({ nome, email: `${nome}@eq.pt`, password_hash: hash, empresa_id: empresa._id, role, ativo: true, dias_folga: [] });
  await mk('gestor', 'gestor');
  ana = await mk('Ana'); bia = await mk('Bia'); cris = await mk('Cris');
  casa = await Propriedade.create({ nome: 'Casa Dupla', empresa_id: empresa._id, smoobu_id: '777', ativo: true, capacidade_hospedes: 6, tempo_limpeza_minutos: 60, staff_necessario: 2 });
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const tarefaDe = (id) => Tarefa.findOne({ smoobu_reserva_id: String(id) }).lean();

test('criação com staff_necessario = 2 atribui equipa de 2 e vaga 0', async () => {
  await webhook('newReservation', reserva(1001));
  await esperar();
  const t = await tarefaDe(1001);
  expect(t.estado).toBe('atribuida');
  expect(t.equipa_atribuida).toHaveLength(2);
  expect(t.pessoas_em_falta).toBe(0);
});

test('criação com staff exclusivo e staff_necessario = 2 completa a equipa', async () => {
  await Propriedade.updateOne({ _id: casa._id }, { funcionario_preferencial_id: ana._id });
  await webhook('newReservation', reserva(1002, { arrival: '2033-04-10', departure: '2033-04-12' }));
  await esperar();
  const t = await tarefaDe(1002);
  expect(String(t.utilizador_id)).toBe(String(ana._id));
  expect(t.equipa_atribuida).toHaveLength(2);
  expect(t.pessoas_em_falta).toBe(0);
  await Propriedade.updateOne({ _id: casa._id }, { $unset: { funcionario_preferencial_id: 1 } });
});

test('só 1 pessoa disponível: equipa parcial com pessoas_em_falta = 1 (não nao_atribuida)', async () => {
  const dia = '2033-05-12';
  await Ausencia.create({ utilizador_id: bia._id, empresa_id: empresa._id, data_inicio: new Date(dia + 'T00:00:00Z'), data_fim: new Date(dia + 'T23:59:00Z'), tipo: 'ferias', estado: 'aprovada' });
  await Ausencia.create({ utilizador_id: cris._id, empresa_id: empresa._id, data_inicio: new Date(dia + 'T00:00:00Z'), data_fim: new Date(dia + 'T23:59:00Z'), tipo: 'ferias', estado: 'aprovada' });
  await webhook('newReservation', reserva(1003, { arrival: '2033-05-10', departure: dia }));
  await esperar();
  const t = await tarefaDe(1003);
  expect(t.estado).toBe('atribuida');
  expect(t.equipa_atribuida).toHaveLength(1);
  expect(t.pessoas_em_falta).toBe(1);
});

test('ninguém disponível: estado e motivo reais (ausência => por_atribuir)', async () => {
  const dia = '2033-06-12';
  for (const u of [ana, bia, cris]) {
    await Ausencia.create({ utilizador_id: u._id, empresa_id: empresa._id, data_inicio: new Date(dia + 'T00:00:00Z'), data_fim: new Date(dia + 'T23:59:00Z'), tipo: 'ferias', estado: 'aprovada' });
  }
  await webhook('newReservation', reserva(1004, { arrival: '2033-06-10', departure: dia }));
  await esperar();
  const t = await tarefaDe(1004);
  expect(t.estado).toBe('por_atribuir');
  expect(t.motivo_nao_atribuicao).toMatch(/ausente|folga/i);
});

test('mudança de data valida TODOS os membros: quem não pode sai e entra substituto', async () => {
  await webhook('newReservation', reserva(1005, { arrival: '2033-07-01', departure: '2033-07-03' }));
  await esperar();
  const antes = await tarefaDe(1005);
  expect(antes.equipa_atribuida).toHaveLength(2);
  // o 2.º membro (não responsável) fica de férias no novo dia; o 3.º elemento está livre
  const segundo = antes.equipa_atribuida.map(String).find((i) => i !== String(antes.utilizador_id));
  const novoDia = '2033-07-08';
  await Ausencia.create({ utilizador_id: segundo, empresa_id: empresa._id, data_inicio: new Date(novoDia + 'T00:00:00Z'), data_fim: new Date(novoDia + 'T23:59:00Z'), tipo: 'ferias', estado: 'aprovada' });
  await webhook('updateReservation', reserva(1005, { arrival: '2033-07-06', departure: novoDia, type: 'modification of booking', modifiedAt: '2033-02-01 10:00:00' }));
  await esperar();
  const depois = await tarefaDe(1005);
  expect(depois.data.toISOString().slice(0, 10)).toBe(novoDia);
  expect(depois.equipa_atribuida.map(String)).not.toContain(segundo);
  expect(depois.equipa_atribuida).toHaveLength(2); // substituto encontrado para a vaga
  expect(depois.pessoas_em_falta).toBe(0);
});
