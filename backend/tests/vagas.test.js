/** B5, B6, B7, B8, B12, B13, C6: vagas de equipa, substitutos sem sobreposição, job. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Notificacao = require('../models/Notificacao');
const { cenario, login, auth } = require('./helpersLote');
const { autoAtribuicaoEmergencia, retomarAtribuicoesPresas } = require('../jobs/caoGuarda');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const amanha = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

test('B6 substituto parcial com outra limpeza à mesma hora NÃO é escalado; o gestor é avisado', async () => {
  const c = await cenario(app, { extra: 1 });
  const dia = '2035-07-10';
  const t = await c.tarefa(dia);
  const p2 = await Propriedade.create({ nome: 'Outra', empresa_id: c.e._id, smoobu_id: 'zz' + c.n(), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const t2 = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p2._id, utilizador_id: c.subs[0]._id, data: new Date(`${dia}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'atribuida' });
  const r = await request(app).post(`/api/gestor/equipa/${c.bia._id}/baixa`).set(auth(c.token)).send({ data_inicio: dia, data_fim: dia, tipo: 'doenca' });
  expect(r.status).toBe(200);
  const d = await Tarefa.findById(t._id).lean();
  expect(d.equipa_atribuida.map(String)).toEqual([String(c.ana._id)]);
  expect(d.pessoas_em_falta).toBe(1);
  expect((await Tarefa.findById(t2._id)).data.toISOString()).toBe(`${dia}T10:00:00.000Z`);
  const aviso = await Notificacao.find({ utilizador_id: c.g._id }).lean();
  expect(aviso.some((n) => /Equipa incompleta/.test(n.mensagem))).toBe(true);
});

test('B6 substituto parcial livre à hora da tarefa é escalado, sem mudar a hora', async () => {
  const c = await cenario(app, { extra: 1 });
  const dia = '2035-07-11';
  const t = await c.tarefa(dia);
  const r = await request(app).post(`/api/gestor/equipa/${c.bia._id}/baixa`).set(auth(c.token)).send({ data_inicio: dia, data_fim: dia, tipo: 'doenca' });
  expect(r.status).toBe(200);
  const d = await Tarefa.findById(t._id).lean();
  expect(d.equipa_atribuida.map(String).sort()).toEqual([String(c.ana._id), String(c.subs[0]._id)].sort());
  expect(d.pessoas_em_falta).toBe(0);
  expect(d.data.toISOString()).toBe(`${dia}T10:00:00.000Z`);
});

test('B5 auto-atribuir preenche só a vaga de uma equipa incompleta', async () => {
  const c = await cenario(app, { extra: 1 });
  const dia = amanha();
  const t = await c.tarefa(dia, { equipa_atribuida: [c.ana._id], pessoas_em_falta: 1 });
  const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(c.token)).send({});
  expect(r.status).toBe(200);
  const d = await Tarefa.findById(t._id).lean();
  expect(String(d.utilizador_id)).toBe(String(c.ana._id));
  expect(d.equipa_atribuida).toHaveLength(2);
  expect(d.pessoas_em_falta).toBe(0);
  expect(d.data.toISOString()).toBe(`${dia}T10:00:00.000Z`);
});

test('C6 staff_necessario a baixar não põe mais pessoas (vaga antiga limpa)', async () => {
  const c = await cenario(app, { extra: 1, sn: 1 });
  const dia = '2035-08-01';
  // contador antigo: pedia 2 pessoas, a casa agora pede 1 e a equipa tem 1
  const t = await c.tarefa(dia, { equipa_atribuida: [c.ana._id], pessoas_em_falta: 1 });
  const { reatribuirTarefasPeriodo } = require('../controllers/ausenciaController');
  await reatribuirTarefasPeriodo(c.e._id, c.bia._id, new Date(`${dia}T00:00:00Z`), new Date(`${dia}T00:00:00Z`));
  const d = await Tarefa.findById(t._id).lean();
  expect(d.equipa_atribuida).toHaveLength(1);
  expect(d.pessoas_em_falta).toBe(0);
});

test('B12 caoGuarda respeita staff_necessario (equipa de 2)', async () => {
  const c = await cenario(app, { extra: 1, sn: 2 });
  const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, data: new Date(`${amanha()}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir' });
  await autoAtribuicaoEmergencia();
  const d = await Tarefa.findById(t._id).lean();
  expect(d.estado).toBe('atribuida');
  expect(d.equipa_atribuida).toHaveLength(2);
  expect(d.pessoas_em_falta).toBe(0);
});

test('B13 tarefa presa em "Atribuição automática em curso" é retomada depois de N minutos', async () => {
  const c = await cenario(app, { extra: 1, sn: 1 });
  const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, data: new Date(`${amanha()}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir', motivo_nao_atribuicao: 'Atribuição automática em curso' });
  // recente: não mexe
  expect((await retomarAtribuicoesPresas(15)).encontradas).toBe(0);
  await Tarefa.collection.updateOne({ _id: t._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 60000) } });
  const r = await retomarAtribuicoesPresas(15);
  expect(r.atribuidas).toBe(1);
  const d = await Tarefa.findById(t._id).lean();
  expect(d.estado).toBe('atribuida');
  expect(d.motivo_nao_atribuicao).toBeNull();
});

test('B13 sem staff: o motivo passa a ser o real (já não fica "em curso")', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  await mongoose.model('Utilizador').updateMany({ empresa_id: c.e._id, role: 'staff' }, { ativo: false });
  const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, data: new Date(`${amanha()}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir', motivo_nao_atribuicao: 'Atribuição automática em curso' });
  await Tarefa.collection.updateOne({ _id: t._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 60000) } });
  await retomarAtribuicoesPresas(15);
  const d = await Tarefa.findById(t._id).lean();
  expect(d.motivo_nao_atribuicao).not.toBe('Atribuição automática em curso');
  expect(d.motivo_nao_atribuicao).toBeTruthy();
});

test('B8 atraso em equipa: avisa o gestor e procura substituto para a vaga', async () => {
  const c = await cenario(app, { extra: 1 });
  const dia = new Date().toISOString().slice(0, 10);
  await c.tarefa(dia, {}, '08');
  const p2 = await Propriedade.create({ nome: 'P2', empresa_id: c.e._id, smoobu_id: 'q' + c.n(), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 2 });
  const t2 = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p2._id, utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id, c.bia._id], data: new Date(`${dia}T15:00:00Z`), tempo_limpeza_minutos: 60, estado: 'atribuida' });
  const t1 = await Tarefa.findOne({ propriedade_id: c.p._id });
  const ta = await login(app, c.ana);
  const r = await request(app).post(`/api/staff/tarefas/${t1._id}/atraso`).set(auth(ta)).send({ minutos_atraso: 400 });
  expect(r.status).toBe(200);
  expect(r.body.cascata_desatribuida).toBe(true);
  const d = await Tarefa.findById(t2._id).lean();
  // Ana saiu; Bia passa a responsável; o substituto (Sub0) preenche a vaga
  expect(d.equipa_atribuida.map(String)).not.toContain(String(c.ana._id));
  expect(d.equipa_atribuida.map(String)).toContain(String(c.subs[0]._id));
  expect(d.pessoas_em_falta).toBe(0);
  const ng = await Notificacao.find({ utilizador_id: c.g._id }).lean();
  expect(ng.some((n) => /atraso/.test(n.mensagem))).toBe(true);
});

test('B7 reatribuir recalcula pessoas_em_falta e mantém o resto da equipa', async () => {
  const c = await cenario(app, { extra: 1 });
  const t = await c.tarefa('2035-08-10');
  // reatribuir para um membro que já está na equipa: a equipa encolhe, a vaga reaparece
  const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(c.bia._id) });
  expect(r.status).toBe(200);
  const d = await Tarefa.findById(t._id).lean();
  expect(d.equipa_atribuida.length).toBe(1);
  expect(d.pessoas_em_falta).toBe(1);
  // para uma pessoa nova: equipa de 2, sem vaga
  const t2 = await c.tarefa('2035-08-11');
  const r2 = await request(app).patch(`/api/gestor/tarefas/${t2._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(c.subs[0]._id) });
  expect(r2.status).toBe(200);
  const d2 = await Tarefa.findById(t2._id).lean();
  expect(d2.equipa_atribuida).toHaveLength(2);
  expect(d2.pessoas_em_falta).toBe(0);
});

test('C2 o staff vê com quem trabalha (equipa_nomes) na lista e no detalhe; colegas avisados com substituto', async () => {
  const c = await cenario(app, { extra: 1 });
  const dia = amanha();
  const t = await c.tarefa(dia);
  const tok = await login(app, c.bia);
  const lista = await request(app).get('/api/auth/me/tarefas').set(auth(tok));
  const item = lista.body.tarefas.find((x) => String(x._id) === String(t._id));
  expect(item.equipa_nomes.map((m) => m.nome)).toEqual(['Ana', 'Bia']);
  expect(item.equipa_nomes[0].responsavel).toBe(true);
  expect(item.equipa_nomes[0]).not.toHaveProperty('email');
  const det = await request(app).get(`/api/auth/me/tarefas/${t._id}`).set(auth(tok));
  expect(det.body.tarefa.equipa_nomes).toHaveLength(2);
});

test('C5 exportação do gestor: coluna Equipa com todos os membros', async () => {
  const ExcelJS = require('exceljs');
  const c = await cenario(app);
  await c.tarefa(amanha());
  const r = await request(app).get('/api/gestor/reservas/exportar-excel').set(auth(c.token)).buffer(true).parse((res, cb) => { const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
  const ws = wb.worksheets[0];
  const cab = ws.getRow(1).values; const col = cab.indexOf('Equipa');
  expect(col).toBeGreaterThan(0);
  expect(ws.getRow(2).values[col]).toBe('Ana, Bia');
});
