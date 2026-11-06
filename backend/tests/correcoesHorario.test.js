/**
 * Correções do horário de trabalho: aviso de «fora do horário» separado do conflito de agenda,
 * reatribuição com a equipa resultante, outra dupla quando a escolhida não tem hora comum e
 * aviso ao gestor no webhook do Smoobu (sem repetir em reenvios).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));
jest.mock('../utils/distancia', () => {
  const real = jest.requireActual('../utils/distancia');
  return {
    ...real,
    calcularTempoViagemReal: jest.fn(async (a, b) => {
      if (!a || !b || a.lat == null || b.lat == null) return { minutos: 30, origem: 'haversine', distanciaKm: 0 };
      return { minutos: a.lat === b.lat && a.lng === b.lng ? 0 : 20, origem: 'google_maps', distanciaKm: 5 };
    }),
  };
});
jest.mock('../utils/notificar', () => {
  const real = jest.requireActual('../utils/notificar');
  return { ...real, notificarUtilizador: jest.fn().mockResolvedValue(undefined), avisarGestores: jest.fn().mockResolvedValue(undefined) };
});

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const WebhookLog = require('../models/WebhookLog');
const { cenario, auth, hash } = require('./helpersLote');
const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
const { avisarGestores } = require('../utils/notificar');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let n = 0;
const casa = (c, lat, ex = {}) => Propriedade.create({ nome: 'K' + ++n, empresa_id: c.e._id, smoobu_id: 'k' + ++n, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat, lng: -9.1 }, ...ex });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa ? pessoa._id : null, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: 'atribuida', ...ex });
const ocupar = async (c, p, pessoa, dia) => {
  await tar(c, p, pessoa, dia, '09:00:00', { tempo_limpeza_minutos: 240 });
  await tar(c, p, pessoa, dia, '14:00:00', { tempo_limpeza_minutos: 240 });
};

describe('1. aviso de fora do horário não é conflito', () => {
  test('criar com hora fora do horário: aviso_horario próprio, sem warning nem conflito_horario', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const r = await request(app).post('/api/gestor/tarefas').set(auth(c.token))
      .send({ propriedade_id: String(p._id), data: '2036-02-03', hora: '07:00', utilizador_id: String(c.ana._id), tempo_limpeza_minutos: 60 });
    expect(r.status).toBe(201);
    expect(r.body.aviso_horario).toMatch(/fora do horário/);
    expect(r.body.warning).toBeUndefined();
    expect(r.body.conflito_horario).toBeUndefined();
  });

  test('conflito real de agenda: warning + conflito_horario = true', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    await tar(c, p, c.ana, '2036-02-04', '10:00:00');
    const r = await request(app).post('/api/gestor/tarefas').set(auth(c.token))
      .send({ propriedade_id: String(p._id), data: '2036-02-04', hora: '10:30', utilizador_id: String(c.ana._id), tempo_limpeza_minutos: 60 });
    expect(r.status).toBe(201);
    expect(r.body.conflito_horario).toBe(true);
    expect(r.body.warning).toMatch(/horário/);
  });

  test('atribuir fora do horário: aviso_horario, nunca warning', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const t = await tar(c, p, null, '2036-02-05', '07:00:00', { estado: 'por_atribuir' });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(c.token)).send({ utilizador_id: String(c.ana._id) });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toMatch(/fora do horário/);
    expect(r.body.warning || '').not.toMatch(/fora do horário/);
  });
});

describe('2. reatribuir calcula a hora para a equipa resultante', () => {
  test('o colega que fica está ocupado: aviso_horario da equipa', async () => {
    const c = await cenario(app, { sn: 2, extra: 1 });
    const [cris] = c.subs;
    const p = await casa(c, 38.7, { staff_necessario: 2 });
    await ocupar(c, p, c.bia, '2036-02-10'); // Bia (que fica) não tem hora
    const t = await tar(c, p, c.ana, '2036-02-10', '10:00:00', { equipa_atribuida: [c.ana._id, c.bia._id] });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(cris._id) });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toMatch(/equipa fica fora do horário/);
    const dep = await Tarefa.findById(t._id).lean();
    expect(dep.equipa_atribuida.map(String).sort()).toEqual([String(cris._id), String(c.bia._id)].sort());
  });

  test('equipa resultante livre: sem aviso', async () => {
    const c = await cenario(app, { sn: 2, extra: 1 });
    const [cris] = c.subs;
    const p = await casa(c, 38.7, { staff_necessario: 2 });
    const t = await tar(c, p, c.ana, '2036-02-11', '10:00:00', { equipa_atribuida: [c.ana._id, c.bia._id] });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(cris._id) });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toBeUndefined();
  });
});

describe('3. equipa de 2 sem hora comum tenta outra dupla', () => {
  // Ana só tem lugar de manhã, Bia só de tarde: cada uma cabe sozinha, juntas não.
  const dividir = async (c, p, dia) => {
    await tar(c, p, c.ana, dia, '12:30:00', { tempo_limpeza_minutos: 300 });
    await tar(c, p, c.bia, dia, '09:00:00', { tempo_limpeza_minutos: 240 });
  };

  test('a dupla escolhida não tem hora comum mas outra tem: atribui', async () => {
    const c = await cenario(app, { sn: 2, extra: 2 });
    const p = await casa(c, 38.7, { staff_necessario: 2 });
    await dividir(c, p, '2036-02-12');
    // Cris e Dani cabem juntos, mas começam mais tarde: o motor escolhe primeiro Ana e Bia.
    for (const u of c.subs) await tar(c, p, u, '2036-02-12', '09:00:00', { tempo_limpeza_minutos: 120 });
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-02-12T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('atribuida');
    // Não é a dupla Ana + Bia (sem hora comum): entrou alguém com quem há hora comum.
    expect(plano.equipa_atribuida.map(String).sort()).not.toEqual([String(c.ana._id), String(c.bia._id)].sort());
    expect(plano.data).toBeInstanceOf(Date);
  });

  test('nenhuma dupla serve: nao_atribuida com «sem hora comum para a equipa»', async () => {
    const c = await cenario(app, { sn: 2, extra: 0 });
    const p = await casa(c, 38.7, { staff_necessario: 2 });
    await dividir(c, p, '2036-02-13');
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-02-13T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('nao_atribuida');
    expect(plano.motivo_nao_atribuicao).toMatch(/sem hora comum para a equipa/i);
  });

  test('casa de 1 pessoa: comportamento igual (motivo de lotação)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c, 38.7);
    await ocupar(c, p, c.ana, '2036-02-14');
    await ocupar(c, p, c.bia, '2036-02-14');
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-02-14T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('nao_atribuida');
    expect(plano.motivo_nao_atribuicao).not.toMatch(/hora comum/i);
  });
});

describe('4. webhook do Smoobu avisa o gestor quando fica por atribuir', () => {
  const CHAVE = 'chave-smoobu-k4';
  let emp, prop;
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
    id, 'reference-id': `REF-${id}`, type: 'reservation', arrival: '2036-03-01', departure: '2036-03-03',
    'created-at': '2036-01-01 10:00:00', modifiedAt: '2036-01-01 10:00:00', apartment: { id: 4242, name: 'Casa K4' },
    channel: { id: 1, name: 'Airbnb' }, 'guest-name': 'Maria', adults: 2, children: 0, 'is-blocked-booking': false, ...extra,
  });
  beforeAll(async () => {
    emp = await Empresa.create({ nome: 'Empresa K4', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    await Utilizador.create({ nome: 'gestor', email: 'g@k4.pt', password_hash: hash, empresa_id: emp._id, role: 'gestor', ativo: true });
    const ana = await Utilizador.create({ nome: 'Ana', email: 'a@k4.pt', password_hash: hash, empresa_id: emp._id, role: 'staff', ativo: true, dias_folga: [] });
    prop = await Propriedade.create({ nome: 'Casa K4', empresa_id: emp._id, smoobu_id: '4242', ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 } });
    // Ana ocupada das 09:00 às 18:00 nos dias 03 e 10 de março.
    for (const d of ['2036-03-03', '2036-03-10']) {
      await Tarefa.create({ empresa_id: emp._id, propriedade_id: prop._id, utilizador_id: ana._id, data: new Date(`${d}T09:00:00Z`), tempo_limpeza_minutos: 240, estado: 'atribuida' });
      await Tarefa.create({ empresa_id: emp._id, propriedade_id: prop._id, utilizador_id: ana._id, data: new Date(`${d}T14:00:00Z`), tempo_limpeza_minutos: 240, estado: 'atribuida' });
    }
  });

  test('criar sem lugar: um aviso; reenvio do mesmo webhook não repete', async () => {
    avisarGestores.mockClear();
    await webhook('newReservation', reserva(5001));
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: '5001' }).lean();
    expect(['por_atribuir', 'nao_atribuida']).toContain(t.estado);
    expect(avisarGestores).toHaveBeenCalledTimes(1);
    expect(avisarGestores.mock.calls[0][1]).toMatch(/por atribuir/i);
    await webhook('newReservation', reserva(5001));
    await esperar();
    expect(avisarGestores).toHaveBeenCalledTimes(1);
  });

  test('mudar a data para um dia cheio: um aviso; reenvio da mesma alteração não repete', async () => {
    await webhook('newReservation', reserva(5002, { arrival: '2036-03-20', departure: '2036-03-22' }));
    await esperar();
    expect((await Tarefa.findOne({ smoobu_reserva_id: '5002' }).lean()).estado).toBe('atribuida');
    avisarGestores.mockClear();
    const alt = reserva(5002, { arrival: '2036-03-08', departure: '2036-03-10', modifiedAt: '2036-03-01 10:00:00' });
    await webhook('updateReservation', alt);
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: '5002' }).lean();
    expect(['por_atribuir', 'nao_atribuida']).toContain(t.estado);
    expect(avisarGestores).toHaveBeenCalledTimes(1);
    await webhook('updateReservation', alt);
    await esperar();
    expect(avisarGestores).toHaveBeenCalledTimes(1);
  });
});
