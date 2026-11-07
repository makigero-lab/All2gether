/**
 * PATCH /api/gestor/tarefas/:id/data («Mudar dia»): o sistema propõe, o gestor ajusta.
 * Recalcula hora e pessoa; recusa em_curso/concluida/cancelada e duplicados; avisa; fica marcado
 * como ajustado (o proprietário mexer em notas não o recalcula; mudar datas/tipo recalcula e avisa o gestor).
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
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;

async function cenario({ sn = 1 } = {}) {
  const e = await Empresa.create({ nome: 'D' + ++n });
  const mk = (nome, role) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const parceiro = await mk('parceiro', 'parceiro');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: sn, parceiro_id: parceiro._id });
  return { e, g, parceiro, ana, bia, p, token: await login(g), tokenP: await login(parceiro) };
}
const reservar = (c, corpo) => request(app).post('/api/parceiro/reservas').set(auth(c.tokenP)).send({ propriedade_id: String(c.p._id), hospedes: 2, ...corpo });
const mudar = (c, id, corpo) => request(app).patch(`/api/gestor/tarefas/${id}/data`).set(auth(c.token)).send(corpo);
const ausente = (c, u, dia) => Ausencia.create({ utilizador_id: u._id, empresa_id: c.e._id, data_inicio: new Date(`${dia}T00:00:00Z`), data_fim: new Date(`${dia}T00:00:00Z`), tipo: 'ferias', estado: 'aprovada' });
const dia = (d) => new Date(d).toISOString().slice(0, 10);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('mudar o dia de uma limpeza', () => {
  test('muda o dia, recalcula a hora, marca como ajustada e avisa o proprietário', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-03-01', check_out: '2070-03-05' });
    expect(r.status).toBe(201);
    const tid = r.body.tarefa._id;
    const u = await mudar(c, tid, { data: '2070-03-07' });
    expect(u.status).toBe(200);
    const t = await Tarefa.findById(tid).lean();
    expect(dia(t.data)).toBe('2070-03-07');
    expect(t.estado).toBe('atribuida');
    expect(t.utilizador_id).toBeTruthy();
    expect(Number(new Date(t.data).getUTCHours())).toBeGreaterThanOrEqual(9); // hora de trabalho, nunca a meia-noite
    expect(t.data_ajustada_gestor).toBe(true);
    const rm = await ReservaManual.findOne({ tarefa_gerada_id: tid }).lean();
    expect([dia(rm.data_limpeza), rm.data_limpeza_ajustada]).toEqual(['2070-03-07', true]);
    const aviso = await Notificacao.findOne({ utilizador_id: c.parceiro._id, chave: new RegExp('^limpeza_alterada:' + tid) });
    expect(aviso).toBeTruthy();
  });

  test('hora pedida: respeita-a se couber (14:00 de Lisboa = 13:00Z no verão)', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-04-01', check_out: '2070-04-05' });
    const u = await mudar(c, r.body.tarefa._id, { data: '2070-04-06', hora: '14:00' });
    expect(u.status).toBe(200);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(new Date(t.data).toISOString()).toBe('2070-04-06T13:00:00.000Z');
  });

  test('a pessoa atual está ausente nesse dia: passa a outra; quem sai é avisado', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-05-01', check_out: '2070-05-05' });
    const tid = r.body.tarefa._id;
    const antes = await Tarefa.findById(tid).lean();
    const quemEra = String(antes.utilizador_id);
    const ausentes = quemEra === String(c.ana._id) ? c.ana : c.bia;
    const outro = ausentes === c.ana ? c.bia : c.ana;
    await ausente(c, ausentes, '2070-05-08');
    const u = await mudar(c, tid, { data: '2070-05-08' });
    expect(u.status).toBe(200);
    expect(u.body.equipa_mudou).toBe(true);
    const t = await Tarefa.findById(tid).lean();
    expect(String(t.utilizador_id)).toBe(String(outro._id));
    expect(await Notificacao.countDocuments({ utilizador_id: ausentes._id, mensagem: /mudada para/ })).toBe(1);
  });

  test('ninguém disponível: fica por atribuir com o motivo, e os gestores são avisados', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-06-01', check_out: '2070-06-05' });
    await ausente(c, c.ana, '2070-06-09');
    await ausente(c, c.bia, '2070-06-09');
    const u = await mudar(c, r.body.tarefa._id, { data: '2070-06-09' });
    expect(u.status).toBe(200);
    expect(u.body.aviso).toMatch(/Ninguém disponível/);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.estado).toBe('por_atribuir');
    expect(t.utilizador_id).toBeNull();
    expect(t.motivo_nao_atribuicao).toMatch(/ausente|folga/i);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /por atribuir|ausente/i })).toBeGreaterThan(0);
  });

  test('recusas: em curso, concluída, cancelada, dia inválido, mesmo dia, duplicado, staff e outra empresa', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-07-01', check_out: '2070-07-05' });
    const tid = r.body.tarefa._id;
    expect((await mudar(c, tid, { data: '2070-07-xx' })).status).toBe(400);
    expect((await mudar(c, tid, { data: '2070-07-05' })).status).toBe(400);
    expect((await mudar(c, tid, { data: '2070-07-07', hora: '25:00' })).status).toBe(400);
    // duplicado: outra reserva já tem limpeza a 12/07
    const o = await reservar(c, { check_in: '2070-07-08', check_out: '2070-07-12' });
    expect(o.status).toBe(201);
    const dup = await mudar(c, tid, { data: '2070-07-12' });
    expect(dup.status).toBe(409);
    expect(dup.body.codigo).toBe('RESERVA_DUPLICADA');
    expect(dia((await Tarefa.findById(tid)).data)).toBe('2070-07-05');
    for (const estado of ['em_curso', 'concluida', 'cancelada']) {
      await Tarefa.updateOne({ _id: tid }, { $set: { estado } });
      const x = await mudar(c, tid, { data: '2070-07-20' });
      expect([estado, x.status]).toEqual([estado, 409]);
    }
    expect((await request(app).patch(`/api/gestor/tarefas/${tid}/data`).set(auth(await login(c.ana))).send({ data: '2070-07-20' })).status).toBe(403);
    const outro = await cenario();
    expect((await mudar(outro, tid, { data: '2070-07-20' })).status).toBe(404);
  });

  test('o proprietário só muda notas: o dia ajustado mantém-se; muda as datas: recalcula e avisa o gestor', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-08-01', check_out: '2070-08-05' });
    const tid = r.body.tarefa._id;
    expect((await mudar(c, tid, { data: '2070-08-07' })).status).toBe(200);
    const notas = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokenP)).send({ observacoes: 'só notas' });
    expect(notas.status).toBe(200);
    expect(String(notas.body.reserva.tarefa_gerada_id._id)).toBe(String(tid));
    expect(dia((await Tarefa.findById(tid)).data)).toBe('2070-08-07');
    const datas = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokenP)).send({ check_out: '2070-08-10' });
    expect(datas.status).toBe(200);
    const nova = await Tarefa.findById(datas.body.reserva.tarefa_gerada_id._id).lean();
    expect(dia(nova.data)).toBe('2070-08-10'); // recalculado: volta ao check-out
    expect((await Tarefa.findById(tid)).estado).toBe('cancelada');
    const rm = await ReservaManual.findById(r.body.reserva._id).lean();
    expect(rm.data_limpeza_ajustada).toBe(false);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /recalculado/ })).toBe(1);
  });

  test('intermédia ajustada pelo gestor mantém o dia quando o proprietário muda notas', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: '2070-09-01', check_out: '2070-09-09', tipo_limpeza: 'intermedia' });
    expect(dia(r.body.tarefa.data)).toBe('2070-09-05');
    expect((await mudar(c, r.body.tarefa._id, { data: '2070-09-03' })).status).toBe(200);
    const notas = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokenP)).send({ observacoes: 'x' });
    expect(String(notas.body.reserva.tarefa_gerada_id._id)).toBe(String(r.body.tarefa._id));
    expect(dia((await Tarefa.findById(r.body.tarefa._id)).data)).toBe('2070-09-03');
  });
});
