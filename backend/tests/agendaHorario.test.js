/**
 * Cálculo da hora de início com base de dados (scheduler + motor + caminhos do gestor):
 * cadeia sem meia-noite nem horas inválidas, outra pessoa, ninguém disponível,
 * equipa de 2, durações que não cabem e Google Maps SIMULADO (nunca chamadas reais).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));
// Maps simulado: 20 min entre coordenadas diferentes, 0 na mesma; conta as chamadas.
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

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario, auth } = require('./helpersLote');
const { calcularTempoViagemReal } = require('../utils/distancia');
const { calcularInicioTarefaUtilizador } = require('../utils/scheduler');
const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
const H = require('../utils/horario');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => calcularTempoViagemReal.mockClear());

const hhmmLocal = (d) => H.hhmm(H.minutosLocais(d));
let n = 0;
async function casa(c, lat, ex = {}) {
  return Propriedade.create({ nome: 'C' + ++n, empresa_id: c.e._id, smoobu_id: 'h' + ++n, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat, lng: -9.1 }, ...ex });
}
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa._id, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: 'atribuida', ...ex });

describe('hora de início: cadeia', () => {
  test('inverno: primeira limpeza às 09:00 (09:00 UTC); verão: 09:00 locais = 08:00 UTC', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const inv = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-13T00:00:00Z'), p.coordenadas, 60);
    expect(inv.data.toISOString()).toBe('2036-01-13T09:00:00.000Z');
    const ver = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-07-14T00:00:00Z'), p.coordenadas, 60);
    expect(ver.data.toISOString()).toBe('2036-07-14T08:00:00.000Z');
  });

  test('uma tarefa a 00:00 e outra a 02:08 (hora inválida) não servem de base à cadeia', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const q = await casa(c, 38.8);
    await tar(c, q, c.ana, '2036-01-14', '00:00:00');
    await tar(c, q, c.ana, '2036-01-14', '02:08:00');
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-14T00:00:00Z'), p.coordenadas, 60);
    expect(r.data.toISOString()).toBe('2036-01-14T09:00:00.000Z');
  });

  test('encadeia a partir da última real: 10:00 + 20 min de viagem (Maps simulado) = 10:20', async () => {
    const c = await cenario(app, { sn: 1 });
    const p1 = await casa(c, 38.7);
    const p2 = await casa(c, 38.9);
    await tar(c, p1, c.ana, '2036-01-15', '09:00:00');
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-15T00:00:00Z'), p2.coordenadas, 60);
    expect(hhmmLocal(r.data)).toBe('10:20');
    expect(r.tempoViagem).toBe(20);
    expect(r.origem).toBe('apos_ultima_tarefa');
  });

  test('domingo é um dia normal', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    expect(new Date('2036-01-13T00:00:00Z').getUTCDay()).toBe(0);
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-13T00:00:00Z'), p.coordenadas, 60);
    expect(r.cabe).toBe(true);
  });

  test('uma limpeza de 480 min não encrava: cabe=false, sem hora e com motivo claro', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-16T00:00:00Z'), p.coordenadas, 480);
    expect(r.cabe).toBe(false);
    expect(r.data).toBeNull();
    expect(r.motivo).toMatch(/demasiado longa/);
  });
});

describe('Google Maps simulado', () => {
  test('cada par de coordenadas distinto calcula-se uma vez por planeamento (sem repetir por tarefa)', async () => {
    const c = await cenario(app, { sn: 1 });
    const p1 = await casa(c, 38.7);
    const p2 = await casa(c, 38.9);
    for (const h of ['09:00:00', '10:30:00', '12:00:00']) await tar(c, p1, c.ana, '2036-01-17', h, { tempo_limpeza_minutos: 30 });
    await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-17T00:00:00Z'), p2.coordenadas, 30);
    expect(calcularTempoViagemReal).toHaveBeenCalledTimes(1); // 3 tarefas na mesma casa -> 1 par
  });

  test('sem coordenadas o fallback mantém 30 min', async () => {
    const c = await cenario(app, { sn: 1 });
    const p1 = await casa(c, 38.7);
    const semCoord = await Propriedade.create({ nome: 'Sem' + ++n, empresa_id: c.e._id, smoobu_id: 's' + ++n, ativo: true, tempo_limpeza_minutos: 60 });
    await tar(c, p1, c.ana, '2036-01-18', '09:00:00');
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-01-18T00:00:00Z'), semCoord.coordenadas, 60);
    expect(r.tempoViagem).toBe(30);
    expect(hhmmLocal(r.data)).toBe('10:30');
  });
});

describe('motor: outra pessoa, ninguém e equipa', () => {
  test('quando a primeira pessoa não tem lugar, o motor escolhe outra', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c, 38.7);
    // Ana ocupada das 09:00 às 18:00 (com almoço): 4 h + almoço + 4 h
    await tar(c, p, c.ana, '2036-01-20', '09:00:00', { tempo_limpeza_minutos: 240 });
    await tar(c, p, c.ana, '2036-01-20', '14:00:00', { tempo_limpeza_minutos: 240 });
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-01-20T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('atribuida');
    expect(String(plano.utilizador_id)).toBe(String(c.bia._id));
    expect(hhmmLocal(plano.data)).toBe('09:00');
  });

  test('ninguém cabe: fica nao_atribuida com o motivo real', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c, 38.7);
    for (const u of [c.ana, c.bia]) {
      await tar(c, p, u, '2036-01-21', '09:00:00', { tempo_limpeza_minutos: 240 });
      await tar(c, p, u, '2036-01-21', '14:00:00', { tempo_limpeza_minutos: 240 });
    }
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-01-21T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('nao_atribuida');
    expect(plano.motivo_nao_atribuicao).toMatch(/horário/);
    expect(plano.utilizador_id).toBeNull();
  });

  test('480 min: fica por atribuir com motivo de limpeza demasiado longa (não encrava)', async () => {
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c, 38.7);
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-01-22T00:00:00Z'), tempoLimpeza: 480 });
    expect(plano.estado).toBe('nao_atribuida');
    expect(plano.motivo_nao_atribuicao).toMatch(/demasiado longa/);
  });

  test('equipa de 2: começa quando os dois conseguem', async () => {
    const c = await cenario(app, { sn: 2, extra: 0 });
    const p = await casa(c, 38.7, { staff_necessario: 2 });
    const q = await casa(c, 38.7);
    await tar(c, q, c.bia, '2036-01-23', '09:00:00', { tempo_limpeza_minutos: 120 }); // Bia livre às 11:00
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-01-23T00:00:00Z'), tempoLimpeza: 60 });
    expect(plano.estado).toBe('atribuida');
    expect(plano.equipa_atribuida).toHaveLength(2);
    expect(hhmmLocal(plano.data)).toBe('11:00');
  });

  test('a pessoa ausente nunca recebe tarefas', async () => {
    const Ausencia = require('../models/Ausencia');
    const c = await cenario(app, { sn: 1, extra: 0 });
    const p = await casa(c, 38.7);
    await Ausencia.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, data_inicio: new Date('2036-01-24T00:00:00Z'), data_fim: new Date('2036-01-24T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const plano = await planearAtribuicao({ empresaId: c.e._id, propriedade: p.toObject(), dia: new Date('2036-01-24T00:00:00Z'), tempoLimpeza: 60 });
    expect(String(plano.utilizador_id)).toBe(String(c.bia._id));
  });
});

describe('caminho do gestor (à mão): nunca fica à meia-noite e só avisa', () => {
  test('criar tarefa atribuída só com data: recebe uma hora calculada, não 00:00', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const r = await request(app).post('/api/gestor/tarefas').set(auth(c.token))
      .send({ propriedade_id: String(p._id), data: '2036-07-15', utilizador_id: String(c.ana._id), tempo_limpeza_minutos: 60 });
    expect(r.status).toBe(201);
    expect(new Date(r.body.tarefa.data).toISOString()).toBe('2036-07-15T08:00:00.000Z'); // 09:00 de verão
  });

  test('criar atribuída com hora explícita fora do horário: respeita e avisa (sem bloquear)', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const r = await request(app).post('/api/gestor/tarefas').set(auth(c.token))
      .send({ propriedade_id: String(p._id), data: '2036-01-25', hora: '07:00', utilizador_id: String(c.ana._id), tempo_limpeza_minutos: 60 });
    expect(r.status).toBe(201);
    expect(r.body.aviso_horario).toMatch(/fora do horário/);
    expect(r.body.conflito_horario).toBeUndefined();
    expect(r.body.warning).toBeUndefined();
  });

  test('atribuir à mão uma tarefa sem hora real (00:00) calcula a hora', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, data: new Date('2036-01-26T00:00:00Z'), tempo_limpeza_minutos: 60, estado: 'por_atribuir' });
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(c.token)).send({ utilizador_id: String(c.ana._id) });
    expect(r.status).toBe(200);
    expect(new Date(r.body.tarefa.data).toISOString()).toBe('2036-01-26T09:00:00.000Z');
  });

  test('reatribuir já não dá 409 por capacidade: atribui e avisa que fica fora do horário', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    await tar(c, p, c.bia, '2036-01-27', '09:00:00', { tempo_limpeza_minutos: 240 });
    await tar(c, p, c.bia, '2036-01-27', '14:00:00', { tempo_limpeza_minutos: 240 });
    const t = await tar(c, p, c.ana, '2036-01-27', '10:00:00');
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(c.bia._id) });
    expect(r.status).toBe(200);
    expect(r.body.aviso_horario).toMatch(/fora do horário/);
    expect(String(r.body.tarefa.utilizador_id)).toBe(String(c.bia._id));
  });
});

describe('Smoobu: alteração de data recalcula a hora', () => {
  test('o utilitário de dia novo nunca devolve meia-noite nem a hora do dia antigo', async () => {
    const c = await cenario(app, { sn: 1 });
    const p = await casa(c, 38.7);
    await tar(c, p, c.ana, '2036-02-03', '09:00:00', { tempo_limpeza_minutos: 90 });
    const r = await calcularInicioTarefaUtilizador(c.ana._id, new Date('2036-02-03T00:00:00Z'), p.coordenadas, 60, null, p._id);
    expect(hhmmLocal(r.data)).toBe('10:30'); // mesma casa: sem viagem
  });
});
