/**
 * Quando uma ausência deixa de valer (cancelada ou rejeitada), a vaga é preenchida
 * NA HORA, sem clique: motor partilhado, só de hoje em diante, só tarefas sem pessoa
 * ou com vaga, falha do motor nunca parte a operação, outra empresa intocada.
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
const Notificacao = require('../models/Notificacao');
const Ausencia = require('../models/Ausencia');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const dia = (s) => new Date(`${s}T00:00:00Z`);

async function cenario({ staffNecessario = 1, comBia = false } = {}) {
  const e = await Empresa.create({ nome: 'F' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = comBia ? await mk('Bia', 'staff') : null;
  const p = await Propriedade.create({
    nome: 'Casa Azul', empresa_id: e._id, smoobu_id: String(++n), ativo: true,
    capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: staffNecessario,
  });
  const token = (await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' })).body.token;
  const aus = (user, ini, fim, estado = 'aprovada') =>
    Ausencia.create({ utilizador_id: user._id, empresa_id: e._id, data_inicio: dia(ini), data_fim: dia(fim), tipo: 'ferias', estado });
  const livre = (d, estado = 'por_atribuir', extra = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date(`${d}T10:00:00Z`), estado, ...extra });
  const cancelar = (a) => request(app).patch(`/api/gestor/ausencias/${a._id}/cancelar`).set(auth(token));
  const rejeitar = (a) => request(app).patch(`/api/gestor/ausencias/${a._id}/estado`).set(auth(token)).send({ estado: 'rejeitada' });
  return { e, g, ana, bia, p, token, aus, livre, cancelar, rejeitar };
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
afterEach(() => jest.restoreAllMocks());

describe('fim de ausência preenche vagas na hora', () => {
  test('cancelar ausência aprovada preenche a tarefa por atribuir e avisa quem recebe', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2035-03-10', '2035-03-12');
    const t = await livre('2035-03-11');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1, orfas: 0 });
    expect(r.body.reatribuicaoAviso).toMatch(/1 tarefa\(s\) preenchida/);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(String(d.utilizador_id)).toBe(String(ana._id));
    expect(await Notificacao.countDocuments({ utilizador_id: ana._id, tipo: 'tarefa_reatribuida' })).toBe(1);
  });

  test('o motor escolhe a melhor pessoa, não tem de ser a que voltou; a outra também ausente não recebe', async () => {
    const { ana, bia, e, aus, livre, cancelar } = await cenario({ comBia: true });
    await aus(bia, '2035-04-10', '2035-04-10');
    const a = await aus(ana, '2035-04-10', '2035-04-10');
    const t = await livre('2035-04-10');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(String((await Tarefa.findById(t._id)).utilizador_id)).toBe(String(ana._id));
    expect(await Notificacao.countDocuments({ utilizador_id: bia._id, tipo: 'tarefa_reatribuida' })).toBe(0);
    expect(e).toBeTruthy();
  });

  test('cancelar ausência pendente não faz nada (não bloqueava ninguém)', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2035-05-10', '2035-05-10', 'pendente');
    const t = await livre('2035-05-10');
    const spy = jest.spyOn(Tarefa, 'find');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toBeNull();
    expect(r.body.reatribuicaoAviso).toBeNull();
    // o motor nem sequer foi chamado (nenhuma pesquisa de tarefas em falta)
    expect(spy.mock.calls.some(([f]) => f && f.$or)).toBe(false);
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
  });

  test('outra ausência ativa da mesma pessoa continua a bloqueá-la', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2035-06-10', '2035-06-10');
    await aus(ana, '2035-06-09', '2035-06-11'); // segunda ausência aprovada sobreposta
    const t = await livre('2035-06-10');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 0, orfas: 1 });
    const d = await Tarefa.findById(t._id);
    expect(d.utilizador_id).toBeNull();
    expect(d.estado).toBe('por_atribuir');
    expect(await Notificacao.countDocuments({ utilizador_id: ana._id, tipo: 'tarefa_reatribuida' })).toBe(0);
  });

  test('equipa de 2 com uma vaga: quem volta ocupa a vaga e o colega mantém-se', async () => {
    const { ana, bia, e, p, aus, cancelar } = await cenario({ staffNecessario: 2, comBia: true });
    const a = await aus(bia, '2035-07-10', '2035-07-10');
    const t = await Tarefa.create({
      empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, equipa_atribuida: [ana._id],
      pessoas_em_falta: 1, data: new Date('2035-07-10T10:00:00Z'), estado: 'atribuida',
    });
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1 });
    const d = await Tarefa.findById(t._id);
    expect(d.pessoas_em_falta).toBe(0);
    expect(d.equipa_atribuida.map(String).sort()).toEqual([String(ana._id), String(bia._id)].sort());
    expect(String(d.utilizador_id)).toBe(String(ana._id));
  });

  test('tarefas passadas são ignoradas; as futuras do mesmo período são preenchidas', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2020-01-01', '2035-12-31');
    const passada = await livre('2020-03-10');
    const futura = await livre('2035-08-10');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect((await Tarefa.findById(passada._id)).estado).toBe('por_atribuir');
    expect((await Tarefa.findById(futura._id)).estado).toBe('atribuida');
  });

  test('em_curso com trabalho feito, concluída e cancelada não são mexidas', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2035-09-10', '2035-09-10');
    const emCurso = await livre('2035-09-10', 'em_curso');
    await Tarefa.updateOne({ _id: emCurso._id }, { $set: { fotos_conclusao: ['f.jpg'] } });
    const conc = await livre('2035-09-10', 'concluida');
    const canc = await livre('2035-09-10', 'cancelada');
    const r = await cancelar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ total: 1, atribuidas: 0, orfas: 1 });
    for (const [t, est] of [[emCurso, 'em_curso'], [conc, 'concluida'], [canc, 'cancelada']]) {
      const d = await Tarefa.findById(t._id);
      expect(d.estado).toBe(est);
      expect(d.utilizador_id).toBeNull();
    }
  });

  test('falha do motor não parte o cancelamento', async () => {
    const { ana, aus, livre, cancelar } = await cenario();
    const a = await aus(ana, '2035-10-10', '2035-10-10');
    const t = await livre('2035-10-10');
    jest.spyOn(Tarefa, 'find').mockImplementation(() => { throw new Error('falha simulada'); });
    const r = await cancelar(a);
    jest.restoreAllMocks();
    expect(r.status).toBe(200);
    expect(r.body.preenchimento.erro).toMatch(/falha simulada/);
    expect(r.body.reatribuicaoAviso).toMatch(/Auto-Atribuir Pendentes/);
    expect((await Ausencia.findById(a._id)).estado).toBe('cancelada');
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
  });

  test('outra empresa não é afetada', async () => {
    const c1 = await cenario();
    const c2 = await cenario();
    const a = await c1.aus(c1.ana, '2035-11-10', '2035-11-10');
    const t1 = await c1.livre('2035-11-10');
    const t2 = await c2.livre('2035-11-10');
    const r = await c1.cancelar(a);
    expect(r.status).toBe(200);
    expect((await Tarefa.findById(t1._id)).estado).toBe('atribuida');
    const d2 = await Tarefa.findById(t2._id);
    expect(d2.estado).toBe('por_atribuir');
    expect(d2.utilizador_id).toBeNull();
  });

  test('duas execuções em simultâneo não duplicam atribuição nem aviso', async () => {
    const { e, ana, aus, livre } = await cenario();
    const a = await aus(ana, '2035-12-10', '2035-12-10');
    await livre('2035-12-10');
    await a.updateOne({ $set: { estado: 'cancelada' } });
    const { preencherVagasPeriodo } = require('../utils/atribuicaoAutomatica');
    const rs = await Promise.all([
      preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim),
      preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim),
    ]);
    expect(rs.reduce((s, x) => s + x.atribuidas, 0)).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: ana._id, tipo: 'tarefa_reatribuida' })).toBe(1);
  });

  test('rejeitar ausência aprovada preenche; rejeitar pendente não faz nada', async () => {
    const { ana, aus, livre, rejeitar } = await cenario();
    const a = await aus(ana, '2036-01-10', '2036-01-10');
    const t = await livre('2036-01-10');
    const r = await rejeitar(a);
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1 });
    expect(r.body.mensagem).toMatch(/preenchida/);
    expect(String((await Tarefa.findById(t._id)).utilizador_id)).toBe(String(ana._id));

    const c = await cenario();
    const p = await c.aus(c.ana, '2036-02-10', '2036-02-10', 'pendente');
    const t2 = await c.livre('2036-02-10');
    const r2 = await c.rejeitar(p);
    expect(r2.status).toBe(200);
    expect(r2.body.preenchimento).toBeNull();
    // o motor atribuiria a Ana (pendente não bloqueia), mas a rejeição não dispara nada
    expect((await Tarefa.findById(t2._id)).estado).toBe('por_atribuir');
  });
});

describe('outros caminhos em que a ausência deixa de bloquear', () => {
  const tokenDe = async (u) =>
    (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;

  test('gestor elimina ausência aprovada: preenche depois de apagar; pendente não dispara', async () => {
    const { ana, aus, livre, token } = await cenario();
    const a = await aus(ana, '2036-04-10', '2036-04-10');
    const t = await livre('2036-04-10');
    const r = await request(app).delete(`/api/gestor/ausencias/${a._id}`).set(auth(token));
    expect(r.status).toBe(200);
    expect(await Ausencia.countDocuments({ _id: a._id })).toBe(0);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1 });
    expect(String((await Tarefa.findById(t._id)).utilizador_id)).toBe(String(ana._id));

    const c = await cenario();
    const p = await c.aus(c.ana, '2036-04-11', '2036-04-11', 'pendente');
    const t2 = await c.livre('2036-04-11');
    const r2 = await request(app).delete(`/api/gestor/ausencias/${p._id}`).set(auth(c.token));
    expect(r2.status).toBe(200);
    expect(r2.body.preenchimento).toBeNull();
    expect((await Tarefa.findById(t2._id)).estado).toBe('por_atribuir');
  });

  test('staff cancela a própria ausência aprovada (PATCH /staff/ausencias/:id/cancelar): preenche', async () => {
    const { ana, aus, livre } = await cenario();
    const a = await aus(ana, '2036-05-10', '2036-05-10');
    const t = await livre('2036-05-10');
    const r = await request(app).patch(`/api/staff/ausencias/${a._id}/cancelar`).set(auth(await tokenDe(ana)));
    expect(r.status).toBe(200);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1 });
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
  });

  test('staff apaga pendente_emergencia (DELETE legado): preenche; pendente não', async () => {
    const { ana, aus, livre } = await cenario();
    const a = await aus(ana, '2036-06-10', '2036-06-10', 'pendente_emergencia');
    const t = await livre('2036-06-10');
    const r = await request(app).delete(`/api/staff/ausencias/${a._id}`).set(auth(await tokenDe(ana)));
    expect(r.status).toBe(200);
    expect(await Ausencia.countDocuments({ _id: a._id })).toBe(0);
    expect(r.body.preenchimento).toMatchObject({ atribuidas: 1 });
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');

    const c = await cenario();
    const p = await c.aus(c.ana, '2036-06-11', '2036-06-11', 'pendente');
    const t2 = await c.livre('2036-06-11');
    const r2 = await request(app).delete(`/api/staff/ausencias/${p._id}`).set(auth(await tokenDe(c.ana)));
    expect(r2.status).toBe(200);
    expect(r2.body.preenchimento).toBeNull();
    expect((await Tarefa.findById(t2._id)).estado).toBe('por_atribuir');
  });

  test('falha a avisar uma pessoa não impede o aviso às outras', async () => {
    const { e, ana, bia, p, aus } = await cenario({ staffNecessario: 2, comBia: true });
    const a = await aus(ana, '2036-07-10', '2036-07-10');
    await Tarefa.create({
      empresa_id: e._id, propriedade_id: p._id, utilizador_id: null,
      data: new Date('2036-07-10T10:00:00Z'), estado: 'por_atribuir',
    });
    await a.updateOne({ $set: { estado: 'cancelada' } });
    const notificar = require('../utils/notificar');
    const spy = jest.spyOn(notificar, 'notificarUtilizador').mockRejectedValueOnce(new Error('push caiu'));
    const { preencherVagasPeriodo } = require('../utils/atribuicaoAutomatica');
    const r = await preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim);
    const chamados = spy.mock.calls.map((c) => String(c[0]));
    expect(r.atribuidas).toBe(1);
    expect(r.erro).toBeUndefined();
    expect(chamados.sort()).toEqual([String(ana._id), String(bia._id)].sort());
  });

  test('ciclo longo renova o lock (heartbeat)', async () => {
    const { e, ana, p, aus } = await cenario();
    const a = await aus(ana, '2036-08-10', '2036-08-10');
    a.estado = 'cancelada';
    await a.save();
    for (let i = 0; i < 45; i++) {
      await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date('2036-08-10T10:00:00Z'), estado: 'por_atribuir' });
    }
    const lock = require('../utils/lockEmpresa');
    const spy = jest.spyOn(lock, 'renovarLock');
    const { preencherVagasPeriodo } = require('../utils/atribuicaoAutomatica');
    const r = await preencherVagasPeriodo(e._id, a.data_inicio, a.data_fim);
    expect(r.total).toBe(45);
    expect(spy).toHaveBeenCalledTimes(2); // nas tarefas 20 e 40
  });
});
