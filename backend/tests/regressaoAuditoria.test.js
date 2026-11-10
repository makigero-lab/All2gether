/**
 * Regressão da auditoria @Tester: cada teste falhava antes da correção correspondente.
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
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const WebhookLog = require('../models/WebhookLog');
const LB = require('../utils/loadBalancer');
const { obterRangeDia } = require('../utils/scheduler');
const { executarArquivista } = require('../jobs/arquivista');
const { executarGeradorRotinas } = require('../jobs/geradorRotinas');

process.env.SMOOBU_WEBHOOK_AUTH_DISABLED = 'true';

let mongod;
let n = 5000;
const nid = () => String(++n);
const hash = bcrypt.hashSync('p-de-teste-123', 4);

const esperar = async () => {
  await new Promise((r) => setTimeout(r, 150));
  const limite = Date.now() + 10000;
  while (Date.now() < limite) {
    if ((await WebhookLog.countDocuments({ status: 'recebido' })) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const wh = async (action, data) => {
  await request(app).post('/api/smoobu/webhook').send({ action, user: 1, data });
  await esperar();
};
const reserva = (id, apt, extra = {}) => ({
  id: Number(id),
  type: 'reservation',
  arrival: '2031-01-10',
  departure: '2031-01-14',
  apartment: { id: Number(apt) },
  'guest-name': 'M',
  adults: 2,
  children: 0,
  ...extra,
});

async function cenario() {
  const e = await Empresa.create({ nome: 'E' + nid() });
  const mk = (nome, role, x = {}) =>
    Utilizador.create({ nome, email: nome + nid() + '@x.pt', password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const mkP = (x = {}) => {
    const s = nid();
    return Propriedade.create({ nome: 'P' + s, empresa_id: e._id, smoobu_id: s, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, ...x });
  };
  const login = async (u) =>
    (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
  return { e, mk, mkP, login };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Load balancer / Smoobu', () => {
  test('folga rotativa é respeitada pelo load balancer', async () => {
    const { e, mk, mkP } = await cenario();
    const dia = new Date('2031-05-06T00:00:00Z');
    await mk('a', 'staff', { folgas_rotativas: [{ data: dia, motivo: 'x' }] });
    const p = await mkP();
    expect(await LB.determinarUtilizadorAtribuido(e._id, obterRangeDia(dia), null, 45, p._id)).toBeNull();
  });

  test('VIP com férias aprovadas não recebe a tarefa (Smoobu)', async () => {
    const { e, mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    const p = await mkP({ funcionario_preferencial_id: a._id });
    const dia = new Date('2031-05-06T00:00:00Z');
    await Ausencia.create({ utilizador_id: a._id, empresa_id: e._id, data_inicio: dia, data_fim: dia, tipo: 'ferias', estado: 'aprovada' });
    await wh('newReservation', reserva(nid(), p.smoobu_id, { departure: '2031-05-06' }));
    const t = await Tarefa.findOne({ propriedade_id: p._id });
    expect(String(t.utilizador_id || '')).not.toBe(String(a._id));
  });

  test('staff_necessario=2 grava a equipa completa', async () => {
    const { mk, mkP } = await cenario();
    await mk('a', 'staff');
    await mk('b', 'staff');
    const p = await mkP({ staff_necessario: 2 });
    await wh('newReservation', reserva(nid(), p.smoobu_id, { departure: '2031-05-08' }));
    const t = await Tarefa.findOne({ propriedade_id: p._id });
    expect(t.equipa_atribuida).toHaveLength(2);
  });

  test('tarefa a 00:00 não contamina o scheduler', async () => {
    const { e, mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    const p = await mkP({ funcionario_preferencial_id: a._id });
    const p2 = await mkP();
    await Tarefa.create({ empresa_id: e._id, propriedade_id: p2._id, utilizador_id: a._id, data: new Date('2031-05-07T00:00:00Z'), estado: 'atribuida', tipo: 'manutencao' });
    await wh('newReservation', reserva(nid(), p.smoobu_id, { departure: '2031-05-07' }));
    const t = await Tarefa.findOne({ propriedade_id: p._id });
    expect(t.data.toISOString()).toBe('2031-05-07T08:00:00.000Z'); // 09:00 de Lisboa (verão); a de 00:00 não conta
  });

  test('VIP sobrecarregado só liberta tarefa do mesmo dia e nunca em_curso', async () => {
    const { e, mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    await mk('b', 'staff');
    const px = await mkP({ equipa_preferencial: [a._id] });
    const py = await mkP();
    await Tarefa.create({ empresa_id: e._id, propriedade_id: py._id, utilizador_id: a._id, data: new Date('2031-06-10T10:00:00Z'), estado: 'atribuida', tempo_limpeza_minutos: 450 });
    const longe = await Tarefa.create({ empresa_id: e._id, propriedade_id: py._id, utilizador_id: a._id, data: new Date('2031-06-25T10:00:00Z'), estado: 'em_curso', tempo_limpeza_minutos: 60 });
    await LB.determinarUtilizadorAtribuido(e._id, obterRangeDia(new Date('2031-06-10')), null, 60, px._id);
    const l = await Tarefa.findById(longe._id);
    expect(l.estado).toBe('em_curso');
    expect(String(l.utilizador_id)).toBe(String(a._id));
  });

  test('reativar reserva cancelada via newReservation atualiza data e reatribui', async () => {
    const { mk, mkP } = await cenario();
    await mk('a', 'staff');
    const p = await mkP();
    const id = nid();
    await wh('newReservation', reserva(id, p.smoobu_id, { departure: '2031-07-20' }));
    await wh('cancelReservation', { id: Number(id), type: 'cancellation', apartment: { id: Number(p.smoobu_id) } });
    await wh('newReservation', reserva(id, p.smoobu_id, { departure: '2031-07-25' }));
    const t = await Tarefa.findOne({ smoobu_reserva_id: id });
    expect(t.data.toISOString().slice(0, 10)).toBe('2031-07-25');
    expect(t.estado).toBe('atribuida');
  });

  test('update de reserva não repõe a hora a 00:00 nem mexe na tarefa em curso', async () => {
    const { mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    const p = await mkP({ funcionario_preferencial_id: a._id });
    const id = nid();
    await wh('newReservation', reserva(id, p.smoobu_id, { departure: '2031-11-17' }));
    await Tarefa.updateOne({ smoobu_reserva_id: id }, { $set: { estado: 'em_curso' } });
    await wh('updateReservation', reserva(id, p.smoobu_id, { departure: '2031-11-17', notice: 'nota' }));
    const t = await Tarefa.findOne({ smoobu_reserva_id: id });
    expect(t.data.toISOString().slice(11, 16)).not.toBe('00:00');
    expect(t.estado).toBe('em_curso');
  });

  test('cancelar tarefa limpa a equipa', async () => {
    const { e, mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    const b = await mk('b', 'staff');
    const p = await mkP();
    const id = nid();
    await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, smoobu_reserva_id: id, utilizador_id: a._id, equipa_atribuida: [a._id, b._id], data: new Date('2031-07-14T10:00:00Z'), estado: 'atribuida' });
    await wh('cancelReservation', { id: Number(id), type: 'cancellation', apartment: { id: Number(p.smoobu_id) } });
    expect((await Tarefa.findOne({ smoobu_reserva_id: id })).equipa_atribuida).toHaveLength(0);
  });
});

describe('Arquivista', () => {
  test('arquiva tarefas com avarias e preserva os campos', async () => {
    const { e, mk, mkP } = await cenario();
    const a = await mk('a', 'staff');
    const p = await mkP();
    const rid = nid();
    await Tarefa.create({
      empresa_id: e._id, propriedade_id: p._id, utilizador_id: a._id, smoobu_reserva_id: rid, hospedes: 4,
      data: new Date('2020-01-14T10:00:00Z'), estado: 'concluida', fotos_conclusao: ['x'],
      avarias: [{ descricao: 'torneira' }],
    });
    const r = await executarArquivista();
    expect(r.erro).toBeUndefined();
    const d = await TarefaArquivo.findOne({ smoobu_reserva_id: rid }).lean();
    expect(d).toBeTruthy();
    expect(d.hospedes).toBe(4);
    expect(d.fotos_conclusao).toEqual(['x']);
    expect(d.avarias[0].descricao).toBe('torneira');
    expect(d.tarefa_original_id).toBeTruthy();
    expect(await Tarefa.countDocuments({ smoobu_reserva_id: rid })).toBe(0);
  });

  test('webhook depois do arquivo não recria a limpeza', async () => {
    const { mkP } = await cenario();
    const p = await mkP();
    const rid = nid();
    await TarefaArquivo.create({ empresa_id: p.empresa_id, propriedade_id: p._id, smoobu_reserva_id: rid, data: new Date('2020-01-14T10:00:00Z'), estado: 'concluida' });
    await wh('updateReservation', reserva(rid, p.smoobu_id, { departure: '2020-01-14' }));
    expect(await Tarefa.countDocuments({ smoobu_reserva_id: rid })).toBe(0);
  });
});

describe('Ausências e estados', () => {
  test('falta de hoje reatribui as tarefas de hoje a quem está disponível e passa a aceitar após ausência cancelada', async () => {
    const { e, mk, mkP, login } = await cenario();
    const a = await mk('a', 'staff');
    const b = await mk('b', 'staff');
    const p = await mkP();
    const h = new Date();
    const hoje = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: a._id, data: new Date(hoje.getTime() + 10 * 3600000), estado: 'atribuida' });
    const r = await request(app).post('/api/staff/falta-hoje').set('Authorization', 'Bearer ' + (await login(a))).send({});
    expect(r.status).toBe(201);
    // Reatribuição automática: a faltosa nunca fica com a tarefa; vai para b (única staff disponível).
    const depois = await Tarefa.findById(t._id);
    expect(String(depois.utilizador_id)).toBe(String(b._id));
    expect(depois.estado).toBe('atribuida');
    await Ausencia.create({ utilizador_id: b._id, empresa_id: e._id, data_inicio: hoje, data_fim: hoje, tipo: 'ferias', estado: 'cancelada' });
    const r2 = await request(app).post('/api/staff/falta-hoje').set('Authorization', 'Bearer ' + (await login(b))).send({});
    expect(r2.status).toBe(201);
  });

  test('atribuir tarefa concluída/cancelada é recusado; estado "atribuida" exige staff', async () => {
    const { e, mk, mkP, login } = await cenario();
    const a = await mk('a', 'staff');
    const g = await mk('g', 'gestor');
    const p = await mkP();
    const tk = await login(g);
    for (const s of ['concluida', 'cancelada']) {
      const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date('2031-08-10T10:00:00Z'), estado: s });
      const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set('Authorization', 'Bearer ' + tk).send({ utilizador_id: String(a._id) });
      expect(r.status).toBe(409);
      expect((await Tarefa.findById(t._id)).estado).toBe(s);
    }
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date('2031-08-10T10:00:00Z'), estado: 'por_atribuir' });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set('Authorization', 'Bearer ' + tk).send({ estado: 'atribuida' });
    expect(r.status).toBe(400);
    const r2 = await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set('Authorization', 'Bearer ' + tk).send({ estado: 'concluida' });
    expect(r2.status).toBe(200);
    expect((await Tarefa.findById(t._id)).data_conclusao).toBeTruthy();
  });

  test('atribuição manual recusa staff com falta de emergência hoje', async () => {
    const { e, mk, mkP, login } = await cenario();
    const a = await mk('a', 'staff');
    const g = await mk('g', 'gestor');
    const p = await mkP();
    const h = new Date();
    const hoje = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
    await Ausencia.create({ utilizador_id: a._id, empresa_id: e._id, data_inicio: hoje, data_fim: hoje, tipo: 'doenca', estado: 'pendente_emergencia' });
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date(hoje.getTime() + 36000000), estado: 'por_atribuir' });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set('Authorization', 'Bearer ' + (await login(g))).send({ utilizador_id: String(a._id) });
    expect(r.status).toBe(409);
  });

  test('baixa com tipo inválido é recusada sem alterar tarefas; aprovar ausência cancelada é recusado', async () => {
    const { e, mk, mkP, login } = await cenario();
    const b = await mk('b', 'staff');
    const g = await mk('g', 'gestor');
    const p = await mkP();
    const tk = await login(g);
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: b._id, data: new Date('2031-09-10T10:00:00Z'), estado: 'atribuida' });
    const r = await request(app).post(`/api/gestor/equipa/${b._id}/baixa`).set('Authorization', 'Bearer ' + tk).send({ data_inicio: '2031-09-10', data_fim: '2031-09-12', tipo: 'banana' });
    expect(r.status).toBe(400);
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
    const au = await Ausencia.create({ utilizador_id: b._id, empresa_id: e._id, data_inicio: new Date('2031-11-01'), data_fim: new Date('2031-11-02'), tipo: 'ferias', estado: 'cancelada' });
    const r2 = await request(app).patch(`/api/gestor/ausencias/${au._id}/estado`).set('Authorization', 'Bearer ' + tk).send({ estado: 'aprovada' });
    expect(r2.status).toBe(400);
  });

  test('baixa NÃO desatribui tarefas em curso (ficam com a pessoa e a resposta avisa)', async () => {
    const { e, mk, mkP, login } = await cenario();
    const b = await mk('b', 'staff');
    const g = await mk('g', 'gestor');
    const p = await mkP();
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: b._id, data: new Date('2031-10-10T10:00:00Z'), estado: 'em_curso' });
    const r = await request(app).post(`/api/gestor/equipa/${b._id}/baixa`).set('Authorization', 'Bearer ' + (await login(g))).send({ data_inicio: '2031-10-10', data_fim: '2031-10-10', tipo: 'doenca' });
    const depois = await Tarefa.findById(t._id);
    expect(String(depois.utilizador_id)).toBe(String(b._id));
    expect(depois.estado).toBe('em_curso');
    expect(r.body.em_curso_mantidas).toBe(1);
  });

  test('auto-atribuir volta a tentar tarefas nao_atribuida', async () => {
    const { e, mk, mkP, login } = await cenario();
    const g = await mk('g', 'gestor');
    const p = await mkP();
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date('2031-12-10T10:00:00Z'), estado: 'nao_atribuida' });
    await mk('novo', 'staff');
    await request(app).post('/api/gestor/tarefas/auto-atribuir').set('Authorization', 'Bearer ' + (await login(g))).send({});
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
  });
});

describe('Associações e jobs', () => {
  test('eliminar utilizador limpa tarefas futuras e referências nas propriedades', async () => {
    const { e, mk, mkP, login } = await cenario();
    const a = await mk('a', 'staff');
    const g = await mk('g', 'gestor');
    const f = await mk('f', 'fornecedor');
    const pa = await mk('pa', 'parceiro');
    const p = await mkP({ equipa_preferencial: [a._id], funcionario_preferencial_id: a._id, fornecedor_id: f._id, parceiro_id: pa._id });
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: a._id, data: new Date('2031-08-10T10:00:00Z'), estado: 'atribuida' });
    const tk = await login(g);
    for (const u of [a, f, pa]) await request(app).delete(`/api/gestor/equipa/${u._id}`).set('Authorization', 'Bearer ' + tk);
    const p2 = await Propriedade.findById(p._id).lean();
    expect(p2.equipa_preferencial).toHaveLength(0);
    expect(p2.funcionario_preferencial_id).toBeNull();
    expect(p2.fornecedor_id).toBeNull();
    expect(p2.parceiro_id).toBeNull();
    const t2 = await Tarefa.findById(t._id);
    expect(t2.utilizador_id).toBeNull();
    expect(t2.estado).toBe('por_atribuir');
  });

  test('fornecedor que muda de role deixa de estar associado às propriedades', async () => {
    const { mk, mkP, login } = await cenario();
    const g = await mk('g', 'gestor');
    const f = await mk('f', 'fornecedor');
    const p = await mkP({ fornecedor_id: f._id });
    await request(app).put(`/api/gestor/equipa/${f._id}`).set('Authorization', 'Bearer ' + (await login(g))).send({ role: 'staff' });
    expect((await Propriedade.findById(p._id)).fornecedor_id).toBeNull();
  });

  test('gerador de rotinas não duplica em execuções simultâneas', async () => {
    await Tarefa.deleteMany({});
    await Propriedade.updateMany({}, { $set: { dias_fixos_limpeza: [] } });
    const { mkP } = await cenario();
    const todos = [0, 1, 2, 3, 4, 5, 6];
    await mkP({ dias_fixos_limpeza: todos });
    await mkP({ dias_fixos_limpeza: todos });
    await Promise.all([executarGeradorRotinas(), executarGeradorRotinas()]);
    expect(await Tarefa.countDocuments({})).toBe(2);
  });

  test('sincronização usa departureFrom e atualiza reservas já existentes', async () => {
    const { e, mk, mkP, login } = await cenario();
    const ad = await mk('ad', 'admin');
    const p = await mkP();
    const id = nid();
    await wh('newReservation', reserva(id, p.smoobu_id, { arrival: '2031-10-01', departure: '2031-10-05' }));
    const urls = [];
    const antigo = global.fetch;
    global.fetch = async (u) => {
      urls.push(u);
      return { ok: true, json: async () => ({ page_count: 1, bookings: [{ id: Number(id), arrival: '2031-10-01', departure: '2031-10-09', apartment: { id: Number(p.smoobu_id) }, 'guest-name': 'M', adults: 1, children: 0 }] }) };
    };
    process.env.SMOOBU_API_KEY = 'fake';
    try {
      const r = await request(app).post('/api/gestor/smoobu/sincronizar').set('Authorization', 'Bearer ' + (await login(ad))).send({});
      expect(r.status).toBe(200);
    } finally {
      global.fetch = antigo;
    }
    expect(urls[0]).toContain('departureFrom=');
    expect((await Tarefa.findOne({ smoobu_reserva_id: id })).data.toISOString().slice(0, 10)).toBe('2031-10-09');
    expect(e).toBeTruthy();
  });
});
