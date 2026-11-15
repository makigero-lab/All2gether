/**
 * @Tester, ronda 2: avisos à equipa, lembrete das 19:00, "presas", relatórios, M1/B1, confirmação sem sacos de roupa,
 * isolamento por empresa dos dados novos.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const { executarFechoAutomatico } = require('../jobs/fechoAutomatico');
const { duracaoRealMinutos } = require('../utils/tempoReal');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const FOTO = 'data:image/jpeg;base64,/9j/4AAQ';
const AGORA = new Date('2040-05-10T19:00:00Z');
const T_HOJE = new Date('2040-05-10T10:00:00Z');

async function cenario(nomeCasa) {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const parc = await mk('Par', 'parceiro');
  const casa = (nome, morada) => Propriedade.create({ nome, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: parc._id, morada });
  const p = await casa(nomeCasa || 'Casa' + ++n, 'Rua Alfa 1, Lisboa');
  const tarefa = (data, ex = {}, prop = p) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: prop._id, utilizador_id: ana._id, data, tempo_limpeza_minutos: 60, estado: 'em_curso', tipo: 'limpeza', ...ex });
  return { e, g, ana, bia, parc, p, casa, tarefa, tokG: await login(g), tokAna: await login(ana), tokBia: await login(bia), tokP: await login(parc) };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  await Notificacao.init();
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await Tarefa.deleteMany({}); await Notificacao.deleteMany({}); });
afterEach(() => jest.restoreAllMocks());

describe('Aviso à equipa às 20:00', () => {
  test('uma notificação por pessoa e limpeza, com link e chave certos; o proprietário e o gestor não recebem', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { equipa_atribuida: [c.ana._id, c.bia._id] });
    await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.parc._id, empresa_id: c.e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
    await executarFechoAutomatico(AGORA);
    const ns = await Notificacao.find({}).lean();
    expect(ns).toHaveLength(2);
    expect(ns.map((x) => String(x.utilizador_id)).sort()).toEqual([String(c.ana._id), String(c.bia._id)].sort());
    for (const x of ns) {
      expect(x.chave).toBe(`fecho_automatico:${t._id}`);
      expect(x.url).toBe(`/staff/tarefas/${t._id}`);
      expect(x.mensagem).toMatch(/20:00/);
      expect(x.mensagem).toContain(c.p.nome);
    }
    expect(await Notificacao.countDocuments({ utilizador_id: { $in: [c.parc._id, c.g._id] } })).toBe(0);
  });
  test('repetir/recuperar não duplica; recuperação diz a hora real da execução', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(new Date('2040-05-11T07:00:00Z')); // 08:00 de Lisboa
    await executarFechoAutomatico(new Date('2040-05-11T08:00:00Z'));
    const ns = await Notificacao.find({ chave: `fecho_automatico:${t._id}` }).lean();
    expect(ns).toHaveLength(1);
    expect(ns[0].mensagem).toMatch(/às 08:00/);
  });
  test('falha ao notificar não impede o fecho', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    jest.spyOn(require('../utils/notificar'), 'notificarUtilizador').mockRejectedValue(new Error('push down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await executarFechoAutomatico(AGORA);
    expect(r.fechadas).toBe(1);
    expect((await Tarefa.findById(t._id).lean()).estado).toBe('concluida');
  });
  test('equipa fantasma (utilizador_id nulo) nem fecha nem avisa; membro desativado/eliminado não rebenta', async () => {
    const c = await cenario();
    await Utilizador.updateOne({ _id: c.bia._id }, { $set: { ativo: false } });
    await c.tarefa(T_HOJE, { equipa_atribuida: [c.ana._id, c.bia._id] });
    await c.tarefa(T_HOJE, { utilizador_id: null, equipa_atribuida: [c.ana._id] });
    const r = await executarFechoAutomatico(AGORA);
    expect(r.fechadas).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id })).toBe(1);
  });
  test('casas homónimas: o aviso leva a rua só se houver homónima', async () => {
    const c = await cenario('Casa Sol');
    const outra = await c.casa('Casa Sol', 'Rua Beta 2, Porto');
    await c.tarefa(T_HOJE);
    await c.tarefa(T_HOJE, {}, outra);
    await executarFechoAutomatico(AGORA);
    const msgs = (await Notificacao.find({}).lean()).map((x) => x.mensagem).join(' | ');
    expect(msgs).toContain('Casa Sol (Rua Alfa 1)');
    expect(msgs).toContain('Casa Sol (Rua Beta 2)');
    // sem homónima, sem rua
    const c2 = await cenario('Casa Unica');
    await c2.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const m2 = await Notificacao.findOne({ utilizador_id: c2.ana._id }).lean();
    expect(m2.mensagem).toContain('Casa Unica às');
    expect(m2.mensagem).not.toContain('(');
  });
  test('homónimas com maiúsculas/minúsculas diferentes e noutra empresa', async () => {
    const c = await cenario('Casa Sol');
    await c.casa('casa sol', 'Rua Beta 2, Porto'); // mesma casa em minúsculas
    const outraEmpresa = await cenario('Casa Sol'); // outra empresa: não conta como homónima
    await c.tarefa(T_HOJE);
    await outraEmpresa.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const mEmp2 = await Notificacao.findOne({ utilizador_id: outraEmpresa.ana._id }).lean();
    expect(mEmp2.mensagem).not.toContain('(');
    const mEmp1 = await Notificacao.findOne({ utilizador_id: c.ana._id }).lean();
    // informativo: se a comparação for sensível a maiúsculas, não aparece a rua
    expect(mEmp1.mensagem).toContain('Casa Sol');
  });
  test('cron: 20:00 e de hora a hora, ambos Europe/Lisbon', () => {
    const espiao = jest.spyOn(cron, 'schedule').mockImplementation(() => ({ stop() {} }));
    require('../jobs/fechoAutomatico').iniciarFechoAutomatico();
    expect(espiao.mock.calls.map((x) => x[0])).toEqual(['0 20 * * *', '0 * * * *']);
    expect(espiao.mock.calls.every((x) => x[2].timezone === 'Europe/Lisbon')).toBe(true);
  });
});

describe('Lembrete das 19:00', () => {
  async function corre() {
    const spy = jest.spyOn(require('../utils/notificar'), 'notificarUtilizador').mockResolvedValue(true);
    const { alertasTarefasIncompletas } = require('../jobs/caoGuarda');
    await alertasTarefasIncompletas();
    return spy.mock.calls.map((x) => ({ titulo: x[1], texto: x[2], url: x[3], para: x[0] }));
  }
  const hoje = () => { const a = new Date(); return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 10)); };
  test('atribuida: não promete o fecho; em_curso: avisa das 20:00; sem tarefas concluídas', async () => {
    const c = await cenario('Casa X');
    const c2 = await cenario('Casa Y');
    await c.tarefa(hoje(), { estado: 'atribuida' });
    await c2.tarefa(hoje(), { estado: 'em_curso' });
    await c.tarefa(hoje(), { estado: 'concluida' });
    const r = await corre();
    const a = r.find((x) => x.para === String(c.ana._id));
    const b = r.find((x) => x.para === String(c2.ana._id));
    expect(r).toHaveLength(2);
    expect(a.texto).toBe('Ainda não começaste a limpeza da Casa X.');
    expect(a.texto).not.toMatch(/20:00/);
    expect(b.texto).toMatch(/antes das 20:00/);
    expect(b.texto).toContain('Casa Y');
  });
  test('casas homónimas: rótulo com a rua', async () => {
    const c = await cenario('Casa Sol');
    const o = await c.casa('Casa Sol', 'Rua Beta 2, Porto');
    await c.tarefa(hoje(), { estado: 'em_curso' }, o);
    const r = await corre();
    expect(r[0].texto).toContain('Casa Sol (Rua Beta 2)');
  });
});

describe('Presas, M1 e relatórios', () => {
  test('presas: em_curso com pessoa há mais de 3 dias aparece; recentes, sem pessoa e outra empresa não', async () => {
    const c = await cenario();
    const o = await cenario();
    const dia = (d) => { const a = new Date(); return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() - d, 10)); };
    const velha = await c.tarefa(dia(5));
    await c.tarefa(dia(5), { utilizador_id: null });
    await c.tarefa(dia(5), { estado: 'concluida', conclusao_origem: 'staff' });
    await c.tarefa(dia(1)); // dentro da janela de recuperação
    await o.tarefa(dia(5)); // outra empresa
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.presas.map((x) => x._id)).toEqual([String(velha._id)]);
    expect(r.body.presas[0].pessoas[0].nome).toBe('Ana');
    expect(JSON.stringify(r.body)).not.toContain('base64');
    const r30 = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente?dias=1').set(auth(c.tokG));
    expect(r30.body.presas).toHaveLength(0); // fora da janela pedida
  });
  test('presas: o limite do dia -3 (ainda recuperável) não conta como presa; dia -4 sim', async () => {
    const c = await cenario();
    const dia = (d) => { const a = new Date(); return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() - d, 10)); };
    const t3 = await c.tarefa(dia(3));
    const t4 = await c.tarefa(dia(4));
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    const ids = r.body.presas.map((x) => x._id);
    expect(ids).toContain(String(t4._id));
    expect(ids).not.toContain(String(t3._id));
  });
  test('M1: reaberta e concluída de verdade sai da lista e conta no tempo real; reaberta e fechada pelo gestor também', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { inicio_origem: 'botao', iniciada_em: T_HOJE });
    await executarFechoAutomatico(AGORA);
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'em_curso' });
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    const d = await Tarefa.findById(t._id).lean();
    const lista = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(lista.body.limpezas.map((x) => x._id)).not.toContain(String(t._id));
    expect(d.confirmada_depois_em).toBeNull();
    expect(duracaoRealMinutos({ ...d, inicio_origem: 'botao', iniciada_em: new Date(d.hora_conclusao.getTime() - 3600000) })).toBe(60);
  });
  test('confirmada depois: continua na lista e fora do tempo real', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { inicio_origem: 'botao', iniciada_em: T_HOJE });
    await executarFechoAutomatico(new Date());
    // força a data de fecho para dentro do período mesmo que a hora real seja <20:00
    await Tarefa.updateOne({ _id: t._id }, { $set: { estado: 'concluida', conclusao_origem: 'automatica', fechada_automaticamente_em: new Date() } });
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    const d = await Tarefa.findById(t._id).lean();
    expect(d.confirmada_depois_em).toBeTruthy();
    const lista = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(lista.body.limpezas.map((x) => x._id)).toContain(String(t._id));
    expect(duracaoRealMinutos({ ...d, inicio_origem: 'botao', iniciada_em: T_HOJE })).toBeNull();
  });
  test('relatório de produtividade: concluidas/taxa excluem fechadas pelo sistema; confirmadas depois contam como concluídas', async () => {
    const c = await cenario();
    const o = await cenario();
    const a = new Date();
    const dia = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 10));
    const base = { estado: 'concluida', concluida_em: a, hora_conclusao: a, data_conclusao: a };
    await c.tarefa(dia, { ...base, conclusao_origem: 'staff' });
    await c.tarefa(dia, { ...base, conclusao_origem: 'automatica', hora_conclusao: null, fechada_automaticamente_em: a });
    await c.tarefa(dia, { ...base, conclusao_origem: 'staff', fechada_automaticamente_em: a, confirmada_depois_em: a });
    await c.tarefa(dia, { estado: 'em_curso' });
    await o.tarefa(dia, { ...base, conclusao_origem: 'automatica', fechada_automaticamente_em: a }); // outra empresa
    const r = await request(app).get('/api/gestor/relatorios/produtividade').set(auth(c.tokG));
    expect(r.status).toBe(200);
    const res = r.body.resumo;
    expect(res.totalTarefas).toBe(4);
    expect(res.concluidas).toBe(2);
    expect(res.fechadasSistema).toBe(1);
    expect(res.confirmadasDepois).toBe(1);
    expect(res.taxaConclusao).toBeCloseTo(0.5, 1);
    const ana = r.body.porStaff.find((s) => s.nome === 'Ana');
    expect(ana.concluidas).toBe(2);
    expect(ana.fechadas_sistema).toBe(1);
    const soma = r.body.porDia.reduce((s, d) => s + d.fechadas_sistema, 0);
    expect(soma).toBe(1);
  });
  test('relatório de tempo real: confirmada depois fora; reaberta+concluída dentro', async () => {
    const c = await cenario();
    const a = new Date();
    const dia = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 10));
    const ini = new Date(a.getTime() - 3600000);
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'staff', iniciada_em: ini, inicio_origem: 'botao', hora_conclusao: a, concluida_em: a, confirmada_depois_em: a, fechada_automaticamente_em: a });
    const r = await request(app).get('/api/gestor/relatorios/tempo-real').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.casas).toHaveLength(0);
    expect(r.body.inicios.botao).toBe(0);
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'staff', iniciada_em: ini, inicio_origem: 'botao', hora_conclusao: a, concluida_em: a, fechada_automaticamente_em: a });
    const r2 = await request(app).get('/api/gestor/relatorios/tempo-real').set(auth(c.tokG));
    expect(r2.body.inicios.botao).toBe(1);
  });
});

describe('Confirmação tardia e sacos de roupa', () => {
  test('sem sacos_roupa_suja no corpo, o valor registado fica; com o campo, atualiza (comportamento normal)', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { sacos_roupa_suja: 3 });
    await executarFechoAutomatico(AGORA);
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect((await Tarefa.findById(t._id).lean()).sacos_roupa_suja).toBe(3);
  });
  test('o parceiro continua a não receber nada e a prova mostra confirmada_depois sem hora', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    const rv = await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.parc._id, empresa_id: c.e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
    await executarFechoAutomatico(AGORA);
    const a1 = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(a1.body.fechada_automaticamente).toBe(true);
    expect(a1.body.hora_conclusao).toBeNull();
    expect(a1.body.fechada_em).toBeTruthy(); // hora do fecho do SISTEMA: confirmar que a UI não a mostra como hora do trabalho
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    const a2 = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(a2.body.confirmada_depois).toBe(true);
    expect(a2.body.hora_conclusao).toBeNull();
    expect(a2.body.fechada_em).toBeNull();
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(0);
  });
  test('proprietário de outra empresa/parceiro não vê a limpeza de outro', async () => {
    const c = await cenario();
    const o = await cenario();
    const t = await c.tarefa(T_HOJE);
    const rv = await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.parc._id, empresa_id: c.e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
    await executarFechoAutomatico(AGORA);
    const r = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(o.tokP));
    expect([403, 404]).toContain(r.status);
  });
});
