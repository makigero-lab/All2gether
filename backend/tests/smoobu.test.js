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
const Utilizador = require('../models/Utilizador');
const WebhookLog = require('../models/WebhookLog');
const ContactoHospede = require('../models/ContactoHospede');
const bcrypt = require('bcryptjs');

const CHAVE = 'chave-smoobu-de-teste';
// Aguarda o processamento assíncrono dos webhooks: espera até não haver logs "recebido"
// (cada log passa a "processado" ou "erro" quando termina). O argumento é ignorado.
const esperar = async () => {
  await new Promise((r) => setTimeout(r, 150));
  const limite = Date.now() + 10000;
  while (Date.now() < limite) {
    if ((await WebhookLog.countDocuments({ status: 'recebido' })) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

let mongod;
let empresa;
let casa;
const tokens = {};

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
  const hash = await bcrypt.hash('password-de-teste-1', 10);
  for (const [nome, email, role] of [
    ['Admin', 'admin@s.pt', 'admin'],
    ['Gestor', 'gestor@s.pt', 'gestor'],
    ['Staff', 'staff@s.pt', 'staff'],
  ]) {
    await Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true });
  }
  for (const k of ['admin', 'gestor', 'staff']) {
    const r = await request(app).post('/api/auth/login').send({ email: `${k}@s.pt`, password: 'password-de-teste-1' });
    tokens[k] = r.body.token;
  }
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

describe('Webhook Smoobu — campos adicionais da reserva', () => {
  it('guarda horas, adultos/crianças, notas e tipo da reserva', async () => {
    await webhook('newReservation', reserva(9101, { notice: 'Chegada tardia, 22h' }));
    await esperar(900);
    const d = (await tarefaDaReserva(9101)).detalhes_reserva;
    expect(d.hora_checkin).toBe('15:00');
    expect(d.hora_checkout).toBe('11:00');
    expect(d.adultos).toBe(2);
    expect(d.criancas).toBe(1);
    expect(d.notas_hospede).toBe('Chegada tardia, 22h');
    expect(d.tipo_reserva).toBe('reservation');
  });

  it('um updateReservation sem notas não apaga as notas já guardadas', async () => {
    await webhook('newReservation', reserva(9102, { notice: 'Berço extra' }));
    await esperar(900);
    const { notice, ...semNotas } = reserva(9102, { type: 'modification of booking' });
    await webhook('updateReservation', semNotas);
    await esperar(900);
    const d = (await tarefaDaReserva(9102)).detalhes_reserva;
    expect(d.notas_hospede).toBe('Berço extra');
    expect(d.tipo_reserva).toBe('modification of booking');
  });
});

describe('Email e telefone do hóspede — só admin', () => {
  let tarefaId;
  beforeAll(async () => {
    await webhook('newReservation', reserva(9201));
    await esperar(900);
    tarefaId = String((await tarefaDaReserva(9201))._id);
  });

  it('ficam em coleção separada e NÃO dentro da tarefa', async () => {
    const t = await Tarefa.findById(tarefaId).lean();
    expect(JSON.stringify(t)).not.toContain('maria@exemplo.pt');
    expect(JSON.stringify(t)).not.toContain('910000000');
    const c = await ContactoHospede.findOne({ tarefa_id: tarefaId }).lean();
    expect(c.email).toBe('maria@exemplo.pt');
    expect(c.telefone).toBe('+351910000000');
  });

  it('nenhuma listagem de tarefas devolve o email/telefone (gestor)', async () => {
    const res = await request(app)
      .get('/api/gestor/tarefas?inicio=2031-01-01&fim=2031-12-31')
      .set('Authorization', `Bearer ${tokens.gestor}`);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(res.body);
    expect(texto).toContain('Maria Silva'); // o nome continua visível
    expect(texto).not.toContain('maria@exemplo.pt');
    expect(texto).not.toContain('910000000');
  });

  it('o admin lê o contacto; gestor e staff recebem 403', async () => {
    const url = `/api/gestor/tarefas/${tarefaId}/contacto-hospede`;
    const admin = await request(app).get(url).set('Authorization', `Bearer ${tokens.admin}`);
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ email: 'maria@exemplo.pt', telefone: '+351910000000' });
    expect((await request(app).get(url).set('Authorization', `Bearer ${tokens.gestor}`)).status).toBe(403);
    expect((await request(app).get(url).set('Authorization', `Bearer ${tokens.staff}`)).status).toBe(403);
  });

  it('o contacto expira 30 dias depois do check-out', async () => {
    const c = await ContactoHospede.findOne({ tarefa_id: tarefaId }).lean();
    const esperado = new Date('2031-03-14').getTime() + 30 * 24 * 3600 * 1000;
    expect(Math.abs(new Date(c.expira_em).getTime() - esperado)).toBeLessThan(24 * 3600 * 1000);
  });

  it('os logs de webhooks escondem email/telefone ao gestor e mostram ao admin', async () => {
    const gestor = await request(app).get('/api/gestor/webhooks?limit=200').set('Authorization', `Bearer ${tokens.gestor}`);
    expect(gestor.status).toBe(200);
    expect(JSON.stringify(gestor.body)).not.toContain('maria@exemplo.pt');
    expect(JSON.stringify(gestor.body)).toContain('[oculto]');
    const admin = await request(app).get('/api/gestor/webhooks?limit=200').set('Authorization', `Bearer ${tokens.admin}`);
    expect(JSON.stringify(admin.body)).toContain('maria@exemplo.pt');
  });
});

describe('Reservas bloqueadas (is-blocked-booking)', () => {
  it('um bloqueio de calendário não cria tarefa de limpeza', async () => {
    const res = await webhook('newReservation', reserva(9301, { 'is-blocked-booking': true, 'guest-name': '' }));
    expect(res.status).toBe(200);
    await esperar(900);
    expect(await tarefaDaReserva(9301)).toBeNull();
  });

  it('se uma reserva com tarefa passa a bloqueio, a tarefa é cancelada', async () => {
    await webhook('newReservation', reserva(9302));
    await esperar(900);
    expect((await tarefaDaReserva(9302)).estado).not.toBe('cancelada');
    await webhook('updateReservation', reserva(9302, { 'is-blocked-booking': true }));
    await esperar(900);
    expect((await tarefaDaReserva(9302)).estado).toBe('cancelada');
  });
});

describe('Retenção RGPD dos logs de webhooks (90 dias após o check-out)', () => {
  it('cada log novo expira 90 dias depois do departure', async () => {
    await webhook('newReservation', reserva(9401, { departure: '2032-06-20' }));
    await esperar(300);
    const log = await WebhookLog.findOne({ 'payload.data.id': 9401 }).lean();
    const esperado = new Date('2032-06-20').getTime() + 30 * 24 * 3600 * 1000;
    expect(Math.abs(new Date(log.expira_em).getTime() - esperado)).toBeLessThan(24 * 3600 * 1000);
  });

  it('migração: remove o índice TTL antigo (createdAt) e calcula expira_em nos logs antigos', async () => {
    await WebhookLog.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: 'createdAt_1' });
    const criado = new Date(Date.now() - 100 * 24 * 3600 * 1000); // recebido há 100 dias
    await WebhookLog.collection.insertOne({
      payload: { data: { id: 9501, departure: '2032-09-01' } }, status: 'processado', createdAt: criado, updatedAt: criado,
    });
    await WebhookLog.collection.insertOne({
      payload: { x: 1 }, status: 'processado', createdAt: criado, updatedAt: criado,
    });

    const r = await WebhookLog.migrarRetencao();
    expect(r.indiceAntigoRemovido).toBe(true);
    const indices = await WebhookLog.collection.indexes();
    expect(indices.some((i) => i.key.createdAt === 1 && i.expireAfterSeconds !== undefined)).toBe(false);

    // reserva futura: expira 90 dias depois do departure (e não 90 dias após a receção)
    const futuro = await WebhookLog.findOne({ 'payload.data.id': 9501 }).lean();
    const esperado = new Date('2032-09-01').getTime() + 30 * 24 * 3600 * 1000;
    expect(Math.abs(new Date(futuro.expira_em).getTime() - esperado)).toBeLessThan(24 * 3600 * 1000);
    // sem departure: createdAt + 90 dias
    const semDep = await WebhookLog.findOne({ 'payload.x': 1 }).lean();
    expect(Math.abs(new Date(semDep.expira_em).getTime() - (criado.getTime() + 30 * 24 * 3600 * 1000))).toBeLessThan(24 * 3600 * 1000);
    // idempotente
    expect((await WebhookLog.migrarRetencao()).atualizados).toBe(0);
  });

  it('o modelo tem índice TTL sobre expira_em', async () => {
    await WebhookLog.init();
    const idx = (await WebhookLog.collection.indexes()).find((i) => i.key.expira_em === 1);
    expect(idx).toBeDefined();
    expect(idx.expireAfterSeconds).toBe(0);
  });
});

describe('Ações do Smoobu sem impacto nas limpezas deixam de ser "erro"', () => {
  it('newMessage, onlineCheckInUpdate e updateRates ficam "processado" (não "erro")', async () => {
    await webhook('newMessage', { id: 5001, sender: 'guest', booking: { id: 9001 } });
    await webhook('onlineCheckInUpdate', { bookingId: 5002 });
    await webhook('updateRates', { 555: { '2031-05-01': { price: 90, min_length_of_stay: 1, available: 1 } } });
    await esperar(900);
    const logs = await WebhookLog.find({ 'payload.action': { $in: ['newMessage', 'onlineCheckInUpdate', 'updateRates'] } }).lean();
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((l) => l.status === 'processado')).toBe(true);
    expect(logs.some((l) => /sem datas/i.test(l.erro_msg || ''))).toBe(false);
  });
});

describe('Reconciliação de cancelamentos antigos (admin)', () => {
  const URL = '/api/gestor/smoobu/reconciliar-cancelamentos';
  const post = (token, body = {}) =>
    request(app).post(URL).set('Authorization', `Bearer ${token}`).send(body);

  // Simula um webhook que foi IGNORADO no passado: grava só o log (sem processar).
  const logAntigo = (action, id, extraData = {}, quando = new Date()) =>
    WebhookLog.collection.insertOne({
      payload: { action, user: 1, data: { id, ...extraData } },
      status: 'processado',
      createdAt: quando,
      updatedAt: quando,
      expira_em: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    });

  let idCancelada;
  let idReativada;
  let idEmCurso;
  let idNormal;

  beforeAll(async () => {
    idCancelada = 9601; idReativada = 9602; idEmCurso = 9603; idNormal = 9604;
    for (const id of [idCancelada, idReativada, idEmCurso, idNormal]) {
      await webhook('newReservation', reserva(id));
    }
    await esperar(1500);
    await Tarefa.updateOne({ smoobu_reserva_id: String(idEmCurso) }, { $set: { estado: 'em_curso' } });

    const t0 = Date.now();
    // cancelada: último webhook é cancelReservation (ignorado no passado)
    await logAntigo('cancelReservation', idCancelada, { type: 'cancellation' }, new Date(t0 + 1000));
    // reativada: cancelou mas depois voltou a ser reserva ativa -> NÃO é candidata
    await logAntigo('cancelReservation', idReativada, { type: 'cancellation' }, new Date(t0 + 1000));
    await logAntigo('updateReservation', idReativada, { type: 'modification of booking' }, new Date(t0 + 2000));
    // em curso: cancelada mas a limpeza já está a decorrer -> revisão manual
    await logAntigo('deleteReservation', idEmCurso, {}, new Date(t0 + 1000));
  });

  it('só o admin pode usar (gestor e staff recebem 403)', async () => {
    expect((await post(tokens.gestor)).status).toBe(403);
    expect((await post(tokens.staff)).status).toBe(403);
  });

  it('por defeito só lista (dry-run) e não altera nada', async () => {
    const res = await post(tokens.admin);
    expect(res.status).toBe(200);
    expect(res.body.aplicado).toBe(false);
    expect(res.body.canceladas).toBe(0);
    const ids = res.body.candidatas.map((c) => c.reserva_id);
    expect(ids).toContain(String(idCancelada));
    expect(ids).not.toContain(String(idReativada)); // voltou a ser reserva ativa
    expect(ids).not.toContain(String(idNormal));     // nunca foi cancelada
    expect(res.body.revisao_manual.map((c) => c.reserva_id)).toContain(String(idEmCurso));
    expect((await tarefaDaReserva(idCancelada)).estado).not.toBe('cancelada');
  });

  it('com aplicar=true cancela as limpezas por fazer e deixa a "em_curso" para revisão', async () => {
    const res = await post(tokens.admin, { aplicar: true });
    expect(res.status).toBe(200);
    expect(res.body.canceladas).toBeGreaterThanOrEqual(1);
    expect((await tarefaDaReserva(idCancelada)).estado).toBe('cancelada');
    expect((await tarefaDaReserva(idReativada)).estado).not.toBe('cancelada');
    expect((await tarefaDaReserva(idNormal)).estado).not.toBe('cancelada');
    expect((await tarefaDaReserva(idEmCurso)).estado).toBe('em_curso');
  });

  it('é idempotente: uma segunda execução não cancela mais nada', async () => {
    const res = await post(tokens.admin, { aplicar: true });
    expect(res.body.canceladas).toBe(0);
  });

  it('um cancelamento tardio nunca reescreve uma limpeza já concluída', async () => {
    await webhook('newReservation', reserva(9605));
    await esperar(900);
    await Tarefa.updateOne({ smoobu_reserva_id: '9605' }, { $set: { estado: 'concluida' } });
    await webhook('cancelReservation', reserva(9605, { type: 'cancellation' }));
    await esperar(900);
    expect((await tarefaDaReserva(9605)).estado).toBe('concluida');
  });
});
