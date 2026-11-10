/**
 * scripts/reagendar-horarios.js em base em memória: só mostra sem --aplicar, só toca em
 * futuras `atribuida` fora do horário, passa a outra pessoa / por atribuir, é idempotente
 * e só avisa com --avisar (uma vez por pessoa).
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
const Notificacao = require('../models/Notificacao');
const { cenario } = require('./helpersLote');
const { reagendarHorarios } = require('../scripts/reagendar-horarios');
const H = require('../utils/horario');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let n = 0;
const casa = (c) => Propriedade.create({ nome: 'R' + ++n, empresa_id: c.e._id, smoobu_id: 'r' + ++n, ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 } });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa ? pessoa._id : null, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: 'atribuida', ...ex });
const AGORA = new Date('2036-03-01T12:00:00Z');
const hora = (t) => H.hhmm(H.minutosLocais(t.data));

test('Tâmara: a cadeia madrugada (00:00, 02:08, 03:42...) é reagendada pela ordem atual', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  const horas = ['00:00:00', '02:08:00', '03:42:00', '05:27:00'];
  const ts = [];
  for (const h of horas) ts.push(await tar(c, p, c.ana, '2036-03-08', h));

  // Sem --aplicar: nada muda.
  const seco = await reagendarHorarios({ aplicar: false, agora: AGORA, empresaId: c.e._id });
  expect(seco.total).toBe(4);
  expect(seco.reagendadas).toBe(4);
  expect(seco.linhas.map((l) => l.depois)).toEqual(['09:00', '10:00', '11:00', '13:00']);
  expect((await Tarefa.findById(ts[0]._id)).data.toISOString()).toBe('2036-03-08T00:00:00.000Z');
  expect(JSON.stringify(seco.linhas)).not.toMatch(/hospede|nome_hospede/i);

  // Aplicar.
  const r = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r.reagendadas).toBe(4);
  const depois = (await Tarefa.find({ _id: { $in: ts.map((t) => t._id) } }).sort({ data: 1 })).map(hora);
  expect(depois).toEqual(['09:00', '10:00', '11:00', '13:00']);

  // Idempotente.
  const outra = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(outra.total).toBe(0);
});

test('só toca em futuras atribuidas: nunca em_curso, concluida, cancelada nem passadas', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  const emCurso = await tar(c, p, c.ana, '2036-03-09', '02:00:00', { estado: 'em_curso' });
  const concl = await tar(c, p, c.ana, '2036-03-09', '03:00:00', { estado: 'concluida' });
  const canc = await tar(c, p, c.ana, '2036-03-09', '04:00:00', { estado: 'cancelada' });
  const passada = await tar(c, p, c.ana, '2036-02-20', '02:00:00');
  const r = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r.total).toBe(0);
  for (const t of [emCurso, concl, canc, passada]) {
    expect((await Tarefa.findById(t._id)).data.toISOString()).toBe(t.data.toISOString());
  }
});

test('a acabar depois das 18:00 também é corrigida; dentro do horário fica como está', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  const boa = await tar(c, p, c.ana, '2036-03-10', '10:00:00');
  const tarde = await tar(c, p, c.ana, '2036-03-10', '17:45:00');
  const r = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r.total).toBe(1);
  expect((await Tarefa.findById(boa._id)).data.toISOString()).toBe('2036-03-10T10:00:00.000Z');
  expect(hora(await Tarefa.findById(tarde._id))).toBe('09:00'); // cabe antes da das 10:00
});

test('o que não cabe à pessoa vai para outra; se ninguém puder fica por atribuir com motivo', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  // Ana tem o dia cheio (4 h + 4 h) e uma limpeza às 03:00.
  await tar(c, p, c.ana, '2036-03-11', '09:00:00', { tempo_limpeza_minutos: 240 });
  await tar(c, p, c.ana, '2036-03-11', '14:00:00', { tempo_limpeza_minutos: 240 });
  const t = await tar(c, p, c.ana, '2036-03-11', '03:00:00');
  const r1 = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r1.passadas).toBe(1);
  const dep = await Tarefa.findById(t._id);
  expect(String(dep.utilizador_id)).toBe(String(c.bia._id));
  expect(hora(dep)).toBe('09:00');

  // Agora a Bia também fica cheia: a próxima não tem ninguém.
  await tar(c, p, c.bia, '2036-03-12', '09:00:00', { tempo_limpeza_minutos: 240 });
  await tar(c, p, c.bia, '2036-03-12', '14:00:00', { tempo_limpeza_minutos: 240 });
  await tar(c, p, c.ana, '2036-03-12', '09:00:00', { tempo_limpeza_minutos: 240 });
  await tar(c, p, c.ana, '2036-03-12', '14:00:00', { tempo_limpeza_minutos: 240 });
  const t2 = await tar(c, p, c.ana, '2036-03-12', '03:00:00');
  const r2 = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r2.porAtribuir).toBe(1);
  const dep2 = await Tarefa.findById(t2._id);
  expect(dep2.utilizador_id).toBeNull();
  expect(dep2.estado).toBe('nao_atribuida');
  expect(dep2.motivo_nao_atribuicao).toMatch(/horário/);
});

test('avisos: por omissão nenhum; com --avisar um por pessoa que mudou', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  await tar(c, p, c.ana, '2036-03-13', '01:00:00');
  await tar(c, p, c.ana, '2036-03-14', '01:00:00');
  await Notificacao.deleteMany({});
  const sem = await reagendarHorarios({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(sem.avisos).toBe(0);
  expect(await Notificacao.countDocuments({})).toBe(0);

  await tar(c, p, c.ana, '2036-03-15', '01:00:00');
  await tar(c, p, c.ana, '2036-03-16', '01:00:00');
  const com = await reagendarHorarios({ aplicar: true, avisar: true, agora: AGORA, empresaId: c.e._id });
  expect(com.avisos).toBe(1);
  expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id })).toBe(1);
});
