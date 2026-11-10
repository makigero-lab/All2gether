/**
 * Mudar o «Tempo base» ou as «Pessoas necessárias» de uma casa atualiza as limpezas
 * dessa casa que ainda não começaram (decisão do utilizador, 2026-11-09).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Notificacao = require('../models/Notificacao');
const { cenario, auth } = require('./helpersLote');
const { idsEquipa } = require('../utils/equipaTarefa');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const put = (c, corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);
const ler = (t) => Tarefa.findById(t._id).lean();
const ids = (t) => idsEquipa(t).sort();

test('tempo base novo: limpezas por começar que seguiam a casa passam ao tempo novo; as outras não mudam', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  const segue = await c.tarefa('2035-07-10');
  const aMao = await c.tarefa('2035-07-11', { tempo_limpeza_minutos: 75 });
  const emCurso = await c.tarefa('2035-07-12', { estado: 'em_curso', iniciada_em: new Date() });
  const concluida = await c.tarefa('2035-07-13', { estado: 'concluida' });
  const passada = await c.tarefa('2020-01-07');
  const profunda = await c.tarefa('2035-07-16', { tipo_limpeza: 'profunda', tempo_limpeza_minutos: 150 });
  await Propriedade.updateOne({ _id: c.p._id }, { $set: { 'tempos_limpeza_por_tipo.profunda': 150 } });

  const r = await put(c, { tempo_limpeza_minutos: 90, staff_necessario: 2 });
  expect(r.status).toBe(200);
  expect(r.body.limpezas.atualizadas).toBe(1);

  const s = await ler(segue);
  expect(s.tempo_limpeza_minutos).toBe(90);
  expect(ids(s)).toEqual([String(c.ana._id), String(c.bia._id)].sort());
  expect(s.data.toISOString()).toBe('2035-07-10T10:00:00.000Z');
  expect((await ler(aMao)).tempo_limpeza_minutos).toBe(75);
  expect((await ler(emCurso)).tempo_limpeza_minutos).toBe(60);
  expect((await ler(concluida)).tempo_limpeza_minutos).toBe(60);
  expect((await ler(passada)).tempo_limpeza_minutos).toBe(60);
  expect((await ler(profunda)).tempo_limpeza_minutos).toBe(150);
  // A equipa sabe que a limpeza mudou.
  const n = await Notificacao.find({ utilizador_id: c.ana._id }).lean();
  expect(n.some((x) => /passou a 90 min/.test(x.mensagem))).toBe(true);
});

test('menos pessoas: sai a última pessoa da equipa (o responsável fica) e é avisada', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  const t = await c.tarefa('2035-08-07');
  const r = await put(c, { staff_necessario: 1 });
  expect(r.status).toBe(200);
  const d = await ler(t);
  expect(ids(d)).toEqual([String(c.ana._id)]);
  expect(String(d.utilizador_id)).toBe(String(c.ana._id));
  expect(d.pessoas_em_falta).toBe(0);
  const n = await Notificacao.find({ utilizador_id: c.bia._id }).lean();
  expect(n.some((x) => /saíste da limpeza/.test(x.mensagem))).toBe(true);
});

test('mais pessoas: a vaga é preenchida por quem está livre, sem mudar a hora', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const t = await c.tarefa('2035-08-08', { equipa_atribuida: [c.ana._id] });
  const r = await put(c, { staff_necessario: 2 });
  expect(r.status).toBe(200);
  const d = await ler(t);
  expect(ids(d)).toEqual([String(c.ana._id), String(c.bia._id)].sort());
  expect(d.pessoas_em_falta).toBe(0);
  expect(d.data.toISOString()).toBe('2035-08-08T10:00:00.000Z');
});

test('tempo maior que já não cabe na hora: a equipa muda de hora sem sobrepor outra limpeza', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const dia = '2035-08-09';
  const t = await c.tarefa(dia, { equipa_atribuida: [c.ana._id] }, '09');
  // A Ana tem outra limpeza noutra casa logo a seguir (10:15 UTC, 60 min).
  const p2 = await Propriedade.create({ nome: 'Outra' + c.n(), empresa_id: c.e._id, smoobu_id: 'o' + c.n(), ativo: true, tempo_limpeza_minutos: 60, coordenadas: { lat: 38.7223, lng: -9.1393 } });
  const outra = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p2._id, utilizador_id: c.ana._id, data: new Date(`${dia}T10:15:00Z`), tempo_limpeza_minutos: 60, estado: 'atribuida' });

  const r = await put(c, { tempo_limpeza_minutos: 120 });
  expect(r.status).toBe(200);
  const d = await ler(t);
  expect(d.tempo_limpeza_minutos).toBe(120);
  expect(d.estado).toBe('atribuida');
  // A mesma pessoa, noutra hora, sem sobrepor a outra limpeza.
  expect(idsEquipa(d)).toEqual([String(c.ana._id)]);
  expect(d.data.toISOString()).not.toBe(`${dia}T09:00:00.000Z`);
  const o = await ler(outra);
  const ini = d.data.getTime();
  const fim = ini + 120 * 60000;
  const oi = o.data.getTime() - (o.tempo_viagem_minutos || 0) * 60000;
  const of = o.data.getTime() + 60 * 60000;
  expect(oi < fim && of > ini).toBe(false);
  const n = await Notificacao.find({ utilizador_id: c.ana._id }).lean();
  expect(n.some((x) => /passou a 120 min às/.test(x.mensagem))).toBe(true);
  expect((await ler(outra)).data.toISOString()).toBe(`${dia}T10:15:00.000Z`);
});

test('limpeza sem equipa volta a ser tentada com a nova configuração; desatribuída à mão fica', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  const semEquipa = await c.tarefa('2035-08-14', { utilizador_id: null, equipa_atribuida: [], estado: 'por_atribuir' });
  const aMao = await c.tarefa('2035-08-15', { utilizador_id: null, equipa_atribuida: [], estado: 'por_atribuir', desatribuida_manual: true });
  const r = await put(c, { staff_necessario: 1, tempo_limpeza_minutos: 50 });
  expect(r.status).toBe(200);
  const d = await ler(semEquipa);
  expect(d.estado).toBe('atribuida');
  expect(d.tempo_limpeza_minutos).toBe(50);
  expect(idsEquipa(d)).toHaveLength(1);
  const m = await ler(aMao);
  expect(m.estado).toBe('por_atribuir');
  expect(m.tempo_limpeza_minutos).toBe(50);
});

test('gravar sem mudar tempo nem pessoas não mexe nas limpezas', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  const t = await c.tarefa('2035-08-21');
  const antes = await ler(t);
  const r = await put(c, { nome: 'Casa renomeada', tempo_limpeza_minutos: 60, staff_necessario: 2 });
  expect(r.status).toBe(200);
  expect(r.body.limpezas).toBeUndefined();
  const d = await ler(t);
  expect(d.updatedAt?.getTime?.()).toBe(antes.updatedAt?.getTime?.());
});
