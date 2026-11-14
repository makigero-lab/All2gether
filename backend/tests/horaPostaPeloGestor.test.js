/**
 * «O automático não muda a hora que o gestor escolheu»: o campo `data_ajustada_gestor` só se marca quando o gestor
 * envia uma hora DIFERENTE da atual (atribuir, reatribuir ou mudar dia/hora). Sem hora, ou igual: não marca nada e a
 * hora continua automática. Com a marca, o motor, as vagas, o job e os scripts não lhe mudam a hora.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));
jest.mock('../utils/distancia', () => {
  const real = jest.requireActual('../utils/distancia');
  return { ...real, calcularTempoViagemReal: jest.fn(async () => ({ minutos: 0, origem: 'haversine', distanciaKm: 0 })) };
});

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario, auth } = require('./helpersLote');
const { planear } = require('../scripts/reatribuir-futuras');
const { reagendarHorarios } = require('../scripts/reagendar-horarios');
const { atribuirTarefaEmFalta } = require('../utils/atribuicaoAutomatica');
const H = require('../utils/horario');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let n = 0;
const casa = (c) => Propriedade.create({ nome: 'H' + ++n, empresa_id: c.e._id, smoobu_id: 'h' + ++n, ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 } });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa ? pessoa._id : null, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: pessoa ? 'atribuida' : 'por_atribuir', ...ex });
const hora = (t) => H.hhmm(H.minutosLocais(t.data));
const patch = (c, t, acao, body) => request(app).patch(`/api/gestor/tarefas/${t._id}/${acao}`).set(auth(c.token)).send(body);

describe('atribuir / reatribuir', () => {
  test('atribuir sem hora: não marca nada (a hora continua automática)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, null, '2036-02-10', '00:00:00');
    const r = await patch(c, t, 'atribuir', { utilizador_id: String(c.ana._id) });
    expect(r.status).toBe(200);
    const dep = await Tarefa.findById(t._id);
    expect(dep.data_ajustada_gestor).toBe(false);
    expect(hora(dep)).toBe('10:00');
  });

  test('atribuir com a MESMA hora que a limpeza já tem: não marca', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, null, '2036-02-11', '11:00:00');
    const r = await patch(c, t, 'atribuir', { utilizador_id: String(c.ana._id), hora: '11:00' });
    expect(r.status).toBe(200);
    expect((await Tarefa.findById(t._id)).data_ajustada_gestor).toBe(false);
  });

  test('atribuir com uma hora DIFERENTE: grava e marca como posta pelo gestor (com aviso se for fora do horário)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, null, '2036-02-12', '11:00:00');
    const r = await patch(c, t, 'atribuir', { utilizador_id: String(c.ana._id), hora: '08:30' });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toMatch(/começa antes das 10:00/);
    const dep = await Tarefa.findById(t._id);
    expect(dep.data_ajustada_gestor).toBe(true);
    expect(hora(dep)).toBe('08:30');
  });

  test('hora inválida: 400', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, null, '2036-02-13', '11:00:00');
    const r = await patch(c, t, 'atribuir', { utilizador_id: String(c.ana._id), hora: '25:99' });
    expect(r.status).toBe(400);
  });

  test('reatribuir sem hora: não marca e recalcula como antes', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, c.ana, '2036-02-14', '15:00:00');
    const r = await patch(c, t, 'reatribuir', { utilizador_id: String(c.bia._id) });
    expect(r.status).toBe(200);
    const dep = await Tarefa.findById(t._id);
    expect(dep.data_ajustada_gestor).toBe(false);
    expect(hora(dep)).toBe('10:00'); // recalculada: a primeira hora livre da Bia
  });

  test('reatribuir com hora diferente marca; uma nova reatribuição sem hora mantém essa hora (não recalcula)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, c.ana, '2036-02-17', '10:00:00');
    const r1 = await patch(c, t, 'reatribuir', { utilizador_id: String(c.bia._id), hora: '14:30' });
    expect(r1.status).toBe(200);
    let dep = await Tarefa.findById(t._id);
    expect(dep.data_ajustada_gestor).toBe(true);
    expect(hora(dep)).toBe('14:30');
    const r2 = await patch(c, t, 'reatribuir', { utilizador_id: String(c.ana._id) });
    expect(r2.status).toBe(200);
    dep = await Tarefa.findById(t._id);
    expect(String(dep.utilizador_id)).toBe(String(c.ana._id));
    expect(hora(dep)).toBe('14:30');
    expect(dep.data_ajustada_gestor).toBe(true);
  });

  test('reatribuir a uma pessoa que não cabe à hora fixada: mantém a hora e avisa (o gestor nunca é bloqueado)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const t = await tar(c, p, c.ana, '2036-02-18', '11:00:00', { data_ajustada_gestor: true });
    await tar(c, p, c.bia, '2036-02-18', '11:00:00'); // a Bia já está ocupada a essa hora
    const r = await patch(c, t, 'reatribuir', { utilizador_id: String(c.bia._id) });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toMatch(/hora que o gestor fixou/);
    expect(hora(await Tarefa.findById(t._id))).toBe('11:00');
  });
});

describe('automação respeita a hora posta pelo gestor', () => {
  test('motor sem pessoa (vagas/job): a pessoa tem de caber à hora fixada; a hora nunca muda', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const fixa = await tar(c, p, null, '2036-02-19', '11:00:00', { data_ajustada_gestor: true });
    await tar(c, p, c.ana, '2036-02-19', '11:00:00'); // Ana ocupada às 11:00
    const lean = await Tarefa.findById(fixa._id).populate('propriedade_id').lean();
    const r = await atribuirTarefaEmFalta(lean, new Date('2036-02-19T00:00:00Z'));
    // O motor escolhe a Bia (livre) e a hora mantém-se; se escolhesse a Ana ficaria por atribuir.
    const dep = await Tarefa.findById(fixa._id);
    expect(hora(dep)).toBe('11:00');
    if (r.resultado === 'atribuida') expect(String(dep.utilizador_id)).toBe(String(c.bia._id));
    else expect(['por_atribuir', 'nao_atribuida']).toContain(dep.estado);
  });

  test('motor: sem ninguém que caiba à hora fixada, fica por atribuir com o motivo e a hora intacta', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const fixa = await tar(c, p, null, '2036-02-20', '11:00:00', { data_ajustada_gestor: true });
    await tar(c, p, c.ana, '2036-02-20', '11:00:00');
    await tar(c, p, c.bia, '2036-02-20', '11:00:00');
    const lean = await Tarefa.findById(fixa._id).populate('propriedade_id').lean();
    const r = await atribuirTarefaEmFalta(lean, new Date('2036-02-20T00:00:00Z'));
    expect(r.resultado).toBe('orfa');
    const dep = await Tarefa.findById(fixa._id);
    expect(hora(dep)).toBe('11:00');
    expect(dep.utilizador_id).toBeNull();
    expect(dep.motivo_nao_atribuicao).toMatch(/hora que o gestor fixou/);
  });

  test('reatribuir-futuras (planear) e reagendar-horarios não mexem numa limpeza com a hora posta pelo gestor', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const fixa = await tar(c, p, c.ana, '2036-02-21', '08:00:00', { data_ajustada_gestor: true, smoobu_reserva_id: 'HX1', origem: 'smoobu' });
    const auto = await tar(c, p, c.bia, '2036-02-21', '09:00:00', { smoobu_reserva_id: 'HX2', origem: 'smoobu' });
    const info = {};
    await planear(new Date('2036-02-20T00:00:00Z'), info);
    expect(info.porOrigem.smoobu).toEqual({ total: 2, fixadas_pelo_gestor: 1, recalculadas: 1, mudam: 0 });
    expect(hora(await Tarefa.findById(fixa._id))).toBe('08:00');
    expect(H.minutosLocais((await Tarefa.findById(auto._id)).data)).toBeGreaterThanOrEqual(H.HORARIO.INICIO_DIA);
    // reagendar-horarios: só a automática (09:00) é afetada.
    await Tarefa.updateOne({ _id: auto._id }, { $set: { data: new Date('2036-02-21T09:00:00Z') } });
    const r = await reagendarHorarios({ aplicar: true, agora: new Date('2036-02-01T12:00:00Z'), empresaId: c.e._id });
    expect(r.total).toBe(1);
    expect(hora(await Tarefa.findById(fixa._id))).toBe('08:00');
  });
});
