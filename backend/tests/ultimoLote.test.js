/**
 * Último lote antes do merge: vagas na resposta da falta/baixa, cão de guarda
 * (execução dupla e tarefas sem pessoa), duplicados do parceiro, mudar check-out,
 * reatribuir sem estado intermédio e heartbeat do lock.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Notificacao = require('../models/Notificacao');
const Utilizador = require('../models/Utilizador');
const { cenario, auth, hash, login } = require('./helpersLote');
const { autoAtribuicaoEmergencia } = require('../jobs/caoGuarda');
const { obterLock, renovarLock, LockEmpresa } = require('../utils/lockEmpresa');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const hoje = () => new Date().toISOString().slice(0, 10);
const amanha = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

describe('item 2: vagas na resposta da falta súbita e da baixa', () => {
  test('falta súbita em equipa de 2 sem substituto devolve as vagas (pelo fluxo normal)', async () => {
    const c = await cenario(app, { extra: 0 });
    await c.tarefa(hoje());
    const r = await request(app).post(`/api/gestor/equipa/${c.bia._id}/falta-subita`).set(auth(c.token)).send({});
    expect(r.status).toBe(200);
    expect(r.body.desatribuidas).toBe(0);
    expect(r.body.parciais).toBe(1);
    expect(r.body.reatribuicao.parciais).toBe(1);
    expect(r.body.reatribuicao.orfas).toBe(0);
    expect(r.body.reatribuicao.faltam).toEqual([expect.objectContaining({ faltam: 1 })]);
  });
  test('baixa em equipa de 2 sem substituto devolve as vagas', async () => {
    const c = await cenario(app, { extra: 0 });
    await c.tarefa('2036-05-10');
    const r = await request(app).post(`/api/gestor/equipa/${c.bia._id}/baixa`).set(auth(c.token))
      .send({ data_inicio: '2036-05-10', data_fim: '2036-05-10', tipo: 'doenca' });
    expect(r.status).toBe(200);
    expect(r.body.parciais).toBe(1);
    expect(r.body.reatribuicao.faltam[0].faltam).toBe(1);
  });
});

describe('item 3: cão de guarda com execução dupla', () => {
  test('duas execuções em simultâneo atribuem uma só vez', async () => {
    const c = await cenario(app, { extra: 1, sn: 1 });
    const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, data: new Date(`${amanha()}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir' });
    const [a, b] = await Promise.all([autoAtribuicaoEmergencia(), autoAtribuicaoEmergencia()]);
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
    expect(a.atribuidas + b.atribuidas).toBe(1);
    // execução seguinte (sequencial): nada para fazer, nada contado
    const c2 = await autoAtribuicaoEmergencia();
    expect(c2.atribuidas).toBe(0);
  });
});

describe('item 4: tarefas atribuida/em_curso sem pessoa', () => {
  const semPessoa = (c, estado, ex = {}) => Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: null, equipa_atribuida: [], data: new Date(`${amanha()}T10:00:00Z`), tempo_limpeza_minutos: 60, estado, ...ex });
  test('cão de guarda atribui a atribuida sem pessoa e a em_curso sem progresso; não mexe na em_curso com trabalho feito', async () => {
    const c = await cenario(app, { extra: 1, sn: 1 });
    const a = await semPessoa(c, 'atribuida');
    const e1 = await semPessoa(c, 'em_curso');
    const e2 = await semPessoa(c, 'em_curso', { fotos_conclusao: ['x'] });
    const r = await autoAtribuicaoEmergencia();
    expect(r.emCursoSemResponsavel).toBe(1);
    const [da, d1, d2] = await Promise.all([a, e1, e2].map((t) => Tarefa.findById(t._id).lean()));
    expect(da.estado).toBe('atribuida'); expect(da.utilizador_id).toBeTruthy();
    expect(d1.estado).toBe('atribuida'); expect(d1.utilizador_id).toBeTruthy();
    expect(d2.estado).toBe('em_curso'); expect(d2.utilizador_id).toBeNull();
  });
  test('auto-atribuir do gestor trata-as e o painel conta-as', async () => {
    const c = await cenario(app, { extra: 1, sn: 1 });
    await semPessoa(c, 'atribuida', { data: new Date(`${hoje()}T10:00:00Z`) });
    const antes = await request(app).get('/api/gestor/dashboard').set(auth(c.token));
    expect(antes.status).toBe(200);
    expect(antes.body.tarefasPorAtribuir).toBe(1);
    const r = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(c.token)).send({});
    expect(r.status).toBe(200);
    expect(r.body.reatribuidas).toBe(1);
    const depois = await request(app).get('/api/gestor/dashboard').set(auth(c.token));
    expect(depois.body.tarefasPorAtribuir).toBe(0);
  });
  test('reatribuirTarefa grava uma só vez, sem estado intermédio com responsável null', async () => {
    const c = await cenario(app, { extra: 1, sn: 2 });
    const t = await c.tarefa(amanha());
    const guardados = [];
    const orig = Tarefa.prototype.save;
    Tarefa.prototype.save = function (...a) { guardados.push(this.utilizador_id); return orig.apply(this, a); };
    try {
      const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/reatribuir`).set(auth(c.token)).send({ utilizador_id: String(c.subs[0]._id) });
      expect(r.status).toBe(200);
    } finally { Tarefa.prototype.save = orig; }
    expect(guardados).toHaveLength(1);
    expect(guardados[0]).toBeTruthy();
  });
});

describe('itens 5 e 6: duplicados do parceiro', () => {
  async function parceiro() {
    const c = await cenario(app, { extra: 2, sn: 1 });
    const pa = await Utilizador.create({ nome: 'Parc', email: `par${c.n()}@x.pt`, password_hash: hash, empresa_id: c.e._id, role: 'parceiro', ativo: true });
    const casa = await Propriedade.create({ nome: 'CasaP' + c.n(), empresa_id: c.e._id, parceiro_id: pa._id, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1 });
    return { c, casa, tp: await login(app, pa) };
  }
  const criar = (tp, casa, ci, co) => request(app).post('/api/parceiro/reservas').set(auth(tp)).send({ propriedade_id: String(casa._id), check_in: ci, check_out: co, hospedes: 2 });

  test('outra origem no mesmo dia não bloqueia e o gestor é avisado', async () => {
    const { c, casa, tp } = await parceiro();
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: casa._id, utilizador_id: null, data: new Date('2037-04-10T10:00:00Z'), tempo_limpeza_minutos: 60, estado: 'por_atribuir', tipo: 'limpeza', origem: 'manual' });
    const r = await criar(tp, casa, '2037-04-08', '2037-04-10');
    expect(r.status).toBe(201);
    const avisos = await Notificacao.find({ utilizador_id: c.g._id }).lean();
    expect(JSON.stringify(avisos)).toMatch(/Duas limpezas/);
  });
  test('dois check-outs de parceiro no mesmo dia: a 2.ª reserva grava e fica associada, com aviso dd/mm/aaaa', async () => {
    const { casa, tp } = await parceiro();
    const a = await criar(tp, casa, '2037-05-08', '2037-05-10');
    expect(a.status).toBe(201);
    const r = await criar(tp, casa, '2037-05-07', '2037-05-10');
    expect(r.status).toBe(201);
    expect(r.body.aviso).toMatch(/10\/05\/2037/);
    expect(String(r.body.reserva.tarefa_gerada_id)).toBe(String(a.body.tarefa._id));
  });
  test('mudar o check-out para um dia ocupado junta-se à limpeza existente (a antiga cancela-se); sem conflito muda', async () => {
    const { casa, tp } = await parceiro();
    const r1 = await criar(tp, casa, '2037-06-01', '2037-06-03');
    const r2 = await criar(tp, casa, '2037-06-04', '2037-06-06');
    const put = (id, co) => request(app).put(`/api/parceiro/reservas/${id}`).set(auth(tp)).send({ check_in: '2037-06-01', check_out: co });
    const junta = await put(r2.body.reserva._id, '2037-06-03');
    expect(junta.status).toBe(200);
    expect(junta.body.aviso).toMatch(/03\/06\/2037/);
    expect((await Tarefa.findById(r2.body.tarefa._id)).estado).toBe('cancelada');
    expect((await Tarefa.findById(r1.body.tarefa._id)).estado).not.toBe('cancelada');
    const ok = await put(r2.body.reserva._id, '2037-06-07');
    expect(ok.status).toBe(200);
    // r2 já não partilha a limpeza de r1: a de r1 fica; r2 ganha uma nova a 07/06
    expect((await Tarefa.findById(r1.body.tarefa._id)).estado).not.toBe('cancelada');
    const rr2 = await request(app).get('/api/parceiro/reservas').set(auth(tp));
    const nova = rr2.body.reservas.find((x) => x._id === r2.body.reserva._id);
    expect(String(nova.tarefa_gerada_id._id)).not.toBe(String(r1.body.tarefa._id));
  });
});

describe('item 13: heartbeat do lock', () => {
  test('renovarLock prolonga o lock do dono e recusa quem já não o tem', async () => {
    const dono = await obterLock('hb:1', { ttlMs: 200, esperaMs: 50 });
    expect(dono).toBeTruthy();
    expect(await renovarLock('hb:1', dono, 5000)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(await obterLock('hb:1', { ttlMs: 200, esperaMs: 50 })).toBeNull();
    expect(await renovarLock('hb:1', 'outro', 5000)).toBe(false);
    await LockEmpresa.deleteOne({ _id: 'hb:1' });
  });
});
