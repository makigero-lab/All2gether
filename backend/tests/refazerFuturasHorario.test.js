/**
 * Refazer as limpezas futuras com o horário novo (início às 10:00):
 *  - scripts/reatribuir-futuras.js (planear) recalcula hora e pessoa de TODAS as futuras automáticas a partir de
 *    amanhã, por origem (smoobu, parceiro, gestor em nome do parceiro, ical, avulsa), e respeita as que o gestor fixou;
 *  - caracteriza o que faz hoje o DELETE /api/gestor/tarefas/futuras (para o plano de produção).
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
const ReservaManual = require('../models/ReservaManual');
const { cenario, login } = require('./helpersLote');
const { planear } = require('../scripts/reatribuir-futuras');
const { origemDaLimpeza, fixadaPeloGestor } = require('../utils/origemLimpeza');
const H = require('../utils/horario');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let n = 0;
const casa = (c, ex = {}) => Propriedade.create({ nome: 'F' + ++n, empresa_id: c.e._id, smoobu_id: 'f' + ++n, ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 }, ...ex });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa ? pessoa._id : null, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: pessoa ? 'atribuida' : 'por_atribuir', ...ex });
const reserva = (c, p, tarefa, ex = {}) =>
  ReservaManual.create({ propriedade_id: p._id, parceiro_id: c.g._id, empresa_id: c.e._id, check_in: new Date('2036-05-01T00:00:00Z'), check_out: new Date('2036-05-03T00:00:00Z'), tarefa_gerada_id: tarefa._id, ...ex });
const hora = (t) => H.hhmm(H.minutosLocais(t.data));
const DESDE = new Date('2036-01-21T00:00:00Z'); // «amanhã»

test('origemDaLimpeza e fixadaPeloGestor: as cinco origens e os sinais do gestor', () => {
  const t = (ex = {}) => ({ data: new Date('2036-01-22T10:00:00Z'), ...ex });
  expect(origemDaLimpeza(t({ smoobu_reserva_id: '123' }), null)).toBe('smoobu');
  expect(origemDaLimpeza(t(), { origem: 'ical' })).toBe('ical');
  expect(origemDaLimpeza(t(), { origem: 'manual', criada_pelo_gestor: true })).toBe('gestor_em_nome_do_parceiro');
  expect(origemDaLimpeza(t(), { origem: 'manual' })).toBe('parceiro');
  expect(origemDaLimpeza(t(), null)).toBe('avulsa');
  expect(fixadaPeloGestor(t({ smoobu_reserva_id: '1', data_ajustada_gestor: true }), null, H.temHoraReal)).toBe(true);
  expect(fixadaPeloGestor(t({ smoobu_reserva_id: '1', dia_mudado_pelo_gestor: { dia: '2036-01-22' } }), null, H.temHoraReal)).toBe(true);
  expect(fixadaPeloGestor(t(), { origem: 'manual', data_limpeza_ajustada: true }, H.temHoraReal)).toBe(true);
  expect(fixadaPeloGestor(t({ smoobu_reserva_id: '1' }), null, H.temHoraReal)).toBe(false);
  expect(fixadaPeloGestor(t(), { origem: 'ical' }, H.temHoraReal)).toBe(false);
  // avulsa: com hora real ou pessoa fica; sem hora nem pessoa passa pela reatribuição
  expect(fixadaPeloGestor(t(), null, H.temHoraReal)).toBe(true);
  expect(fixadaPeloGestor({ data: new Date('2036-01-22T00:00:00Z') }, null, H.temHoraReal)).toBe(false);
});

test('planear: recalcula as automáticas de todas as origens para as 10:00 e respeita as fixadas pelo gestor', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const dia = '2036-01-22';
  const pSm = await casa(c); const pPa = await casa(c); const pGe = await casa(c); const pIc = await casa(c); const pAv = await casa(c); const pFix = await casa(c);
  // Todas às 09:00 (horário antigo), cada uma de uma origem; a Ana tem tudo, por isso recalculam em cadeia.
  const tSm = await tar(c, pSm, c.ana, dia, '09:00:00', { smoobu_reserva_id: 'S1', origem: 'smoobu' });
  const tPa = await tar(c, pPa, c.ana, dia, '09:00:00', { origem_parceiro: true });
  const tGe = await tar(c, pGe, c.ana, dia, '09:00:00', { origem_parceiro: true });
  const tIc = await tar(c, pIc, c.ana, dia, '09:00:00', { origem_parceiro: true });
  const tAv = await tar(c, pAv, null, dia, '00:00:00', { origem: 'manual', estado: 'por_atribuir' }); // avulsa sem hora nem pessoa
  await reserva(c, pPa, tPa);
  await reserva(c, pGe, tGe, { criada_pelo_gestor: true, criada_por: c.g._id });
  await reserva(c, pIc, tIc, { origem: 'ical' });
  // Fixadas pelo gestor: smoobu com hora mudada à mão (08:00) e avulsa com hora e pessoa postas por ele (19:00).
  const tFix = await tar(c, pFix, c.bia, dia, '08:00:00', { smoobu_reserva_id: 'S2', origem: 'smoobu', data_ajustada_gestor: true });
  const tAvFix = await tar(c, pAv, c.bia, dia, '19:00:00', { origem: 'manual' });
  // De hoje (não entra: «amanhã em diante») e passada.
  const tHoje = await tar(c, pSm, c.ana, '2036-01-20', '09:00:00', { smoobu_reserva_id: 'S3', origem: 'smoobu' });

  const info = {};
  const plano = await planear(DESDE, info);
  expect(plano).toHaveLength(5); // 4 com reserva + a avulsa sem hora; as 2 fixadas e a de hoje ficam de fora
  expect(info.porOrigem.smoobu).toEqual({ total: 2, fixadas_pelo_gestor: 1, recalculadas: 1, mudam: 0 });
  expect(info.porOrigem.parceiro.recalculadas).toBe(1);
  expect(info.porOrigem.gestor_em_nome_do_parceiro.recalculadas).toBe(1);
  expect(info.porOrigem.ical.recalculadas).toBe(1);
  expect(info.porOrigem.avulsa).toEqual({ total: 2, fixadas_pelo_gestor: 1, recalculadas: 1, mudam: 0 });

  // Todas as recalculadas ficam atribuídas e a partir das 10:00 (nunca antes).
  for (const t of [tSm, tPa, tGe, tIc, tAv]) {
    const dep = await Tarefa.findById(t._id);
    expect(dep.estado).toBe('atribuida');
    expect(H.minutosLocais(dep.data)).toBeGreaterThanOrEqual(H.HORARIO.INICIO_DIA);
  }
  // O gestor manda: nem a hora nem a pessoa mudaram.
  expect(hora(await Tarefa.findById(tFix._id))).toBe('08:00');
  expect(hora(await Tarefa.findById(tAvFix._id))).toBe('19:00');
  expect(String((await Tarefa.findById(tAvFix._id)).utilizador_id)).toBe(String(c.bia._id));
  // De hoje: intocada.
  expect(hora(await Tarefa.findById(tHoje._id))).toBe('09:00');
});

describe('DELETE /api/gestor/tarefas/futuras (o que faz hoje)', () => {
  test('começa HOJE (não amanhã), poupa as ligadas a reservas de proprietários, apaga as avulsas, não apaga concluídas nem passadas', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c);
    const hoje = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const smoobuHoje = await tar(c, p, c.ana, hoje, '12:00:00', { smoobu_reserva_id: 'D1', origem: 'smoobu' });
    const smoobuAmanha = await tar(c, p, c.ana, amanha, '12:00:00', { smoobu_reserva_id: 'D2', origem: 'smoobu' });
    const avulsa = await tar(c, p, c.ana, amanha, '15:00:00', { origem: 'manual' });
    const doParceiro = await tar(c, p, c.ana, amanha, '16:00:00', { origem_parceiro: true });
    await reserva(c, p, doParceiro);
    const concluida = await tar(c, p, c.ana, amanha, '17:00:00', { estado: 'concluida' });
    const passada = await tar(c, p, c.ana, ontem, '12:00:00');

    const admin = await c.mk('Adm', 'admin');
    const r = await request(app).delete('/api/gestor/tarefas/futuras').set('Authorization', 'Bearer ' + (await login(app, admin)));
    expect(r.status).toBe(200);
    expect(r.body.poupadas).toBe(1);
    expect(await Tarefa.exists({ _id: smoobuHoje._id })).toBeNull(); // as de HOJE também vão
    expect(await Tarefa.exists({ _id: smoobuAmanha._id })).toBeNull();
    expect(await Tarefa.exists({ _id: avulsa._id })).toBeNull(); // as avulsas vão e nada as recria
    expect(await Tarefa.exists({ _id: doParceiro._id })).not.toBeNull();
    expect(await Tarefa.exists({ _id: concluida._id })).not.toBeNull();
    expect(await Tarefa.exists({ _id: passada._id })).not.toBeNull();
  });
});
