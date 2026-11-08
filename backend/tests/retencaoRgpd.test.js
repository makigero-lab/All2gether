/** Retenção RGPD: prazos finais (ContactoHospede, WebhookLog, retencao.js, limpezaFotos). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Auditoria = require('../models/Auditoria');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const WebhookLog = require('../models/WebhookLog');
const ContactoHospede = require('../models/ContactoHospede');
const { executarRetencao } = require('../jobs/retencao');
const { executarLimpezaFotos } = require('../jobs/limpezaFotos');
const { resolverAvariaDaManutencao } = require('../utils/avarias');

const DIA = 86400000;
const antes = (dias) => new Date(Date.now() - dias * DIA);
const hash = bcrypt.hashSync('p-de-teste-123', 4);
let mongod;
let n = 0;

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

async function empresa() {
  const e = await Empresa.create({ nome: 'R' + ++n });
  const p = await Propriedade.create({ nome: 'P' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  return { e, p, mk };
}
const arq = (c, data, x = {}) => TarefaArquivo.collection.insertOne({
  empresa_id: c.e._id, propriedade_id: c.p._id, data, tempo_limpeza_minutos: 45, tipo: 'limpeza', estado: 'concluida', ...x,
});

describe('ContactoHospede: 30 dias', () => {
  test('expira check-out + 30 dias', () => {
    const d = new Date(Date.now() + 10 * DIA);
    expect(ContactoHospede.calcularExpiracao(d).getTime()).toBe(d.getTime() + 30 * DIA);
  });

  test('migração 90 -> 30: encurta os antigos uma só vez e não toca nos novos', async () => {
    const c = await empresa();
    const expiraAntigo = new Date(Date.now() + 80 * DIA); // check-out daqui a 80 d, prazo antigo 90 d
    const antigo = (await ContactoHospede.collection.insertOne({ tarefa_id: new mongoose.Types.ObjectId(), empresa_id: c.e._id, email: 'a@x.pt', expira_em: expiraAntigo })).insertedId;
    const novoDoc = await ContactoHospede.create({ tarefa_id: new mongoose.Types.ObjectId(), empresa_id: c.e._id, email: 'b@x.pt', expira_em: ContactoHospede.calcularExpiracao(new Date(Date.now() + 5 * DIA)) });
    const r1 = await ContactoHospede.migrarRetencao();
    expect(r1.atualizados).toBeGreaterThanOrEqual(1);
    const a = await ContactoHospede.findById(antigo).lean();
    expect(a.expira_em.getTime()).toBe(expiraAntigo.getTime() - 60 * DIA);
    expect(a.retencao_dias).toBe(30);
    expect((await ContactoHospede.findById(novoDoc._id).lean()).expira_em.getTime()).toBe(novoDoc.expira_em.getTime());
    expect((await ContactoHospede.migrarRetencao()).atualizados).toBe(0);
    expect((await ContactoHospede.findById(antigo).lean()).expira_em.getTime()).toBe(expiraAntigo.getTime() - 60 * DIA);
  });
});

describe('WebhookLog: 30 dias e reconciliação', () => {
  test('migração encurta para max(departure, receção) + 30 d, só uma vez, e preserva logs recentes', async () => {
    const c = await empresa();
    const criado = antes(100);
    const mk = (payload, createdAt, expira) => WebhookLog.collection.insertOne({ payload, empresa_id: c.e._id, status: 'processado', createdAt, updatedAt: createdAt, expira_em: expira });
    const passado = (await mk({ action: 'newReservation', data: { id: 7001, departure: '2020-01-10' } }, criado, new Date(criado.getTime() + 90 * DIA))).insertedId;
    const futuroDep = new Date(Date.now() + 40 * DIA);
    const futuro = (await mk({ action: 'newReservation', data: { id: 7002, departure: futuroDep.toISOString().slice(0, 10) } }, criado, new Date(futuroDep.getTime() + 90 * DIA))).insertedId;
    const recente = await WebhookLog.create({ payload: { action: 'newReservation', data: { id: 7003, departure: '2020-01-01' } }, empresa_id: c.e._id });

    await WebhookLog.migrarRetencao();
    const p = await WebhookLog.findById(passado).lean();
    expect(p.expira_em.getTime()).toBe(criado.getTime() + 30 * DIA);
    const f = await WebhookLog.findById(futuro).lean();
    expect(Math.abs(f.expira_em.getTime() - (new Date(futuroDep.toISOString().slice(0, 10)).getTime() + 30 * DIA))).toBeLessThan(DIA);
    expect((await WebhookLog.findById(recente._id).lean()).expira_em.getTime()).toBe(recente.expira_em.getTime());
    expect((await WebhookLog.migrarRetencao()).atualizados).toBe(0);
  });

  test('reconciliar-cancelamentos continua a ver o cancelamento de uma reserva futura recebido há 60 dias', async () => {
    const c = await empresa();
    const admin = await c.mk('adm', 'admin');
    const token = (await request(app).post('/api/auth/login').send({ email: admin.email, password: 'p-de-teste-123' })).body.token;
    const dep = new Date(Date.now() + 20 * DIA);
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, data: dep, estado: 'por_atribuir', smoobu_reserva_id: '7777', origem: 'smoobu' });
    const rec = antes(60);
    // regime antigo: createdAt + 90 d (ainda no futuro), departure futuro
    const { insertedId } = await WebhookLog.collection.insertOne({
      payload: { action: 'cancelReservation', user: 1, data: { id: 7777, type: 'cancellation', departure: dep.toISOString().slice(0, 10) } },
      empresa_id: c.e._id, status: 'processado', createdAt: rec, updatedAt: rec, expira_em: new Date(rec.getTime() + 90 * DIA),
    });
    await WebhookLog.migrarRetencao();
    const log = await WebhookLog.findById(insertedId).lean();
    expect(log.expira_em.getTime()).toBeGreaterThan(Date.now() + 15 * DIA); // check-out + 30 d, não receção + 30 d
    const res = await request(app).post('/api/gestor/smoobu/reconciliar-cancelamentos').set({ Authorization: 'Bearer ' + token }).send({});
    expect(res.status).toBe(200);
    expect(res.body.candidatas.map((x) => x.reserva_id)).toContain('7777');
  });
});

describe('retencao.js', () => {
  test('notas do hóspede (30 d) separadas do nome (90 d); outra empresa e dados recentes intactos', async () => {
    const a = await empresa();
    const b = await empresa();
    const mk = (c, dias, x = {}) => Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, data: antes(dias), estado: 'concluida', detalhes_reserva: { nome_hospede: 'Nome', notas_hospede: 'nota' }, ...x });
    const t45 = await mk(a, 45);
    const t120 = await mk(a, 120);
    const t5 = await mk(a, 5);
    const arq45 = await arq(a, antes(45), { detalhes_reserva: { nome_hospede: 'N', notas_hospede: 'x' } });
    const rm = await ReservaManual.collection.insertOne({ empresa_id: a.e._id, check_in: antes(130), check_out: antes(120), nome_hospede: 'Manual' });
    const t45b = await mk(b, 45);
    // a regra opera sobre todas as empresas, mas cada empresa só vê os seus: usa-se um relógio fixo para as duas
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    const d45 = (await Tarefa.findById(t45._id).lean()).detalhes_reserva;
    expect(d45.notas_hospede).toBeNull();
    expect(d45.nome_hospede).toBe('Nome'); // o nome fica até aos 90 d
    expect((await Tarefa.findById(t120._id).lean()).detalhes_reserva.nome_hospede).toBeNull();
    expect((await Tarefa.findById(t5._id).lean()).detalhes_reserva).toMatchObject({ nome_hospede: 'Nome', notas_hospede: 'nota' });
    expect((await TarefaArquivo.collection.findOne({ _id: arq45.insertedId })).detalhes_reserva.notas_hospede).toBeNull();
    expect((await ReservaManual.collection.findOne({ _id: rm.insertedId })).nome_hospede).toBeNull();
    // os prazos são iguais para todas as empresas: a empresa B tem o mesmo tratamento, e o relatório separa-as
    expect((await Tarefa.findById(t45b._id).lean()).detalhes_reserva.notas_hospede).toBeNull();
    expect(r.por_empresa[String(a.e._id)].notas_hospede).toBe(3);
    expect(r.por_empresa[String(b.e._id)].notas_hospede).toBe(1);
    const r2 = await executarRetencao();
    expect(r2.notas_hospede).toBe(0);
    expect(r2.hospedes).toBe(0);
  });

  test('justificação/notas de doença limpas 30 d após o fim; a ausência fica até aos 12 meses', async () => {
    const a = await empresa();
    const b = await empresa();
    const sa = await a.mk('sa', 'staff');
    const sb = await b.mk('sb', 'staff');
    const aus = (c, s, fimDias, x = {}) => Ausencia.create({ utilizador_id: s._id, empresa_id: c.e._id, data_inicio: antes(fimDias + 2), data_fim: antes(fimDias), tipo: 'doenca', estado: 'aprovada', justificacao: 'gripe', notas: 'atestado', ...x });
    const velha = await aus(a, sa, 45);
    const recente = await aus(a, sa, 10);
    const futura = await aus(a, sa, -10);
    const velhaB = await aus(b, sb, 400);
    const ferias = await aus(a, sa, 45, { tipo: 'ferias', justificacao: 'viagem' });
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    expect(await Ausencia.findById(velha._id).lean()).toMatchObject({ justificacao: '', notas: '' });
    expect(await Ausencia.findById(recente._id).lean()).toMatchObject({ justificacao: 'gripe', notas: 'atestado' });
    expect(await Ausencia.findById(futura._id).lean()).toMatchObject({ justificacao: 'gripe' });
    expect(await Ausencia.findById(velhaB._id)).toBeNull(); // > 12 meses: apagada
    expect((await Ausencia.findById(ferias._id).lean()).justificacao).toBe('viagem'); // só a doença
    expect((await executarRetencao()).justificacoes_doenca).toBe(0);
  });

  test('ausências não aprovadas apagadas aos 12 meses; aprovadas só aos 36', async () => {
    const a = await empresa();
    const b = await empresa();
    const sa = await a.mk('sa', 'staff');
    const sb = await b.mk('sb', 'staff');
    const aus = (c, s, estado, fimDias) => Ausencia.create({ utilizador_id: s._id, empresa_id: c.e._id, data_inicio: antes(fimDias + 1), data_fim: antes(fimDias), tipo: 'ferias', estado });
    const ids = {};
    for (const estado of ['pendente', 'pendente_emergencia', 'rejeitada', 'cancelada']) {
      ids[estado] = { velha: await aus(a, sa, estado, 400), recente: await aus(a, sa, estado, 300), outra: await aus(b, sb, estado, 400) };
    }
    const aprov13 = await aus(a, sa, 'aprovada', 400);
    const aprov40 = await aus(a, sa, 'aprovada', 40 * 31);
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    for (const estado of Object.keys(ids)) {
      expect(await Ausencia.findById(ids[estado].velha._id)).toBeNull();
      expect(await Ausencia.findById(ids[estado].outra._id)).toBeNull(); // o prazo vale para todas; abaixo confirma-se a separação
      expect(await Ausencia.findById(ids[estado].recente._id)).not.toBeNull();
    }
    expect(await Ausencia.findById(aprov13._id)).not.toBeNull();
    expect(await Ausencia.findById(aprov40._id)).toBeNull();
    expect(r.por_empresa[String(b.e._id)].ausencias).toBe(4);
  });

  test('arquivo > 5 anos: anonimiza a equipa e mantém propriedade, data, tipo e estado', async () => {
    const a = await empresa();
    const b = await empresa();
    const sa = await a.mk('sa', 'staff');
    const ano = new Date().getUTCFullYear();
    const completo = (c, data) => arq(c, data, {
      utilizador_id: sa._id, equipa_atribuida: [sa._id], iniciada_por: sa._id, observacoes: 'Sr. João', observacoes_staff: 'Falei com Ana',
      nao_consegui_comecar: { motivo: 'sem_acesso', nota: 'x', por: sa._id }, avarias: [{ descricao: 'vidro', fotos: ['f'] }], fotos_conclusao: ['f'],
      detalhes_reserva: { nome_hospede: 'Maria', notas_hospede: 'n' }, alerta: 'Ana de folga',
    });
    const antiga = await completo(a, new Date(Date.UTC(ano - 6, 5, 1)));
    const antigaB = await completo(b, new Date(Date.UTC(ano - 6, 5, 1)));
    const limite = await completo(a, new Date(Date.UTC(ano - 5, 0, 1))); // 1 jan (ano-5): ainda não
    const recente = await completo(a, new Date(Date.UTC(ano - 4, 5, 1)));
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    const d = await TarefaArquivo.collection.findOne({ _id: antiga.insertedId });
    expect(d).toMatchObject({ utilizador_id: null, equipa_atribuida: [], iniciada_por: null, observacoes: '', observacoes_staff: '', avarias: [], fotos_conclusao: [], tipo: 'limpeza', estado: 'concluida' });
    expect(String(d.propriedade_id)).toBe(String(a.p._id));
    expect(d.data.getUTCFullYear()).toBe(ano - 6);
    for (const k of ['nao_consegui_comecar', 'detalhes_reserva', 'alerta']) expect(d).not.toHaveProperty(k);
    expect((await TarefaArquivo.collection.findOne({ _id: antigaB.insertedId })).utilizador_id).toBeNull();
    for (const x of [limite, recente]) {
      const doc = await TarefaArquivo.collection.findOne({ _id: x.insertedId });
      expect(String(doc.utilizador_id)).toBe(String(sa._id));
    }
    expect(r.por_empresa[String(a.e._id)].arquivo_anonimizado).toBe(1);
    expect((await executarRetencao()).arquivo_anonimizado).toBe(0);
  });

  test('auditoria > 3 anos apagada; registo de acesso ao contacto não copia email/telefone', async () => {
    const a = await empresa();
    const b = await empresa();
    const adm = await a.mk('adm', 'admin');
    const base = { utilizador_id: adm._id, utilizador_nome: 'x', acao: 'x', recurso: 'x', descricao: 'x' };
    const velha = await Auditoria.create({ ...base, empresa_id: a.e._id });
    const velhaB = await Auditoria.create({ ...base, empresa_id: b.e._id });
    const recente = await Auditoria.create({ ...base, empresa_id: a.e._id });
    const m = new Date(); m.setFullYear(m.getFullYear() - 4);
    await Auditoria.collection.updateMany({ _id: { $in: [velha._id, velhaB._id] } }, { $set: { createdAt: m } });
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    expect(await Auditoria.findById(velha._id)).toBeNull();
    expect(await Auditoria.findById(velhaB._id)).toBeNull();
    expect(await Auditoria.findById(recente._id)).not.toBeNull();
    expect(r.por_empresa[String(b.e._id)].auditoria).toBe(1);

    // consulta do contacto: a auditoria não guarda o email nem o telefone
    const token = (await request(app).post('/api/auth/login').send({ email: adm.email, password: 'p-de-teste-123' })).body.token;
    const t = await Tarefa.create({ empresa_id: a.e._id, propriedade_id: a.p._id, data: new Date(Date.now() + DIA), estado: 'por_atribuir' });
    await ContactoHospede.create({ tarefa_id: t._id, empresa_id: a.e._id, email: 'segredo@hospede.pt', telefone: '+351911222333', expira_em: new Date(Date.now() + 10 * DIA) });
    const res = await request(app).get(`/api/gestor/tarefas/${t._id}/contacto-hospede`).set({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('segredo@hospede.pt');
    let reg;
    for (let i = 0; i < 20 && !reg; i++) { reg = await Auditoria.findOne({ acao: 'ver_contacto_hospede', recurso_id: String(t._id) }).lean(); if (!reg) await new Promise((x) => setTimeout(x, 50)); }
    expect(reg).toBeTruthy();
    expect(JSON.stringify(reg)).not.toMatch(/segredo@hospede|911222333/);
  });

  test('notificações > 90 dias apagadas', async () => {
    const a = await empresa();
    const b = await empresa();
    const ua = await a.mk('ua', 'staff');
    const ub = await b.mk('ub', 'staff');
    const mk = (c, u) => Notificacao.create({ utilizador_id: u._id, empresa_id: c.e._id, mensagem: 'Olá Maria' });
    const velha = await mk(a, ua);
    const velhaB = await mk(b, ub);
    const recente = await mk(a, ua);
    await Notificacao.collection.updateMany({ _id: { $in: [velha._id, velhaB._id] } }, { $set: { createdAt: antes(100) } });
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    expect(await Notificacao.findById(velha._id)).toBeNull();
    expect(await Notificacao.findById(velhaB._id)).toBeNull();
    expect(await Notificacao.findById(recente._id)).not.toBeNull();
    expect(r.por_empresa[String(b.e._id)].notificacoes).toBe(1);
  });

  test('contas eliminadas há > 30 d: dados pessoais apagados, nome fica, email único e login impossível', async () => {
    const a = await empresa();
    const b = await empresa();
    const dados = { telefone: '+351911', nif: '123456789', observacoes: 'nota', pushSubscription: { endpoint: 'e' } };
    const velha1 = await a.mk('v1', 'staff', { ...dados, eliminado_em: antes(40), ativo: false });
    const velha2 = await a.mk('v2', 'staff', { ...dados, eliminado_em: antes(40), ativo: false });
    const velhaB = await b.mk('vb', 'staff', { ...dados, eliminado_em: antes(40), ativo: false });
    const recente = await a.mk('rc', 'staff', { ...dados, eliminado_em: antes(5), ativo: false });
    const viva = await a.mk('vv', 'staff', dados);
    const emailVelha = velha1.email;
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    const d1 = await Utilizador.findById(velha1._id).lean();
    const d2 = await Utilizador.findById(velha2._id).lean();
    expect(d1.nome).toBe('v1');
    expect(d1.email).toBe(`eliminado-${velha1._id}@invalido`);
    expect(d2.email).toBe(`eliminado-${velha2._id}@invalido`);
    expect(d1).toMatchObject({ telefone: '', nif: '', observacoes: '', ativo: false, pushSubscription: null });
    expect(d1.password_hash).toBeUndefined();
    expect((await Utilizador.findById(velhaB._id).lean()).email).toMatch(/@invalido$/);
    expect(r.por_empresa[String(b.e._id)].contas_anonimizadas).toBe(1);
    expect((await Utilizador.findById(recente._id).lean()).telefone).toBe('+351911');
    expect((await Utilizador.findById(viva._id).lean()).nif).toBe('123456789');
    // não consegue entrar, nem com o email antigo nem com o placeholder
    for (const email of [emailVelha, d1.email]) {
      const res = await request(app).post('/api/auth/login').send({ email, password: 'p-de-teste-123' });
      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
    }
    expect((await executarRetencao()).contas_anonimizadas).toBe(0);
  });

  test('lotes: mais de 500 registos antigos são tratados todos', async () => {
    const a = await empresa();
    const docs = Array.from({ length: 1100 }, () => ({ utilizador_id: new mongoose.Types.ObjectId(), utilizador_nome: 'x', empresa_id: a.e._id, acao: 'x', recurso: 'x', descricao: 'x', createdAt: antes(2000), updatedAt: antes(2000) }));
    await Auditoria.collection.insertMany(docs);
    const r = await executarRetencao();
    expect(r.auditoria).toBeGreaterThanOrEqual(1100);
    expect(await Auditoria.countDocuments({ empresa_id: a.e._id })).toBe(0);
  });
});

describe('limpezaFotos no arquivo', () => {
  test('as fotos sobrevivem à cópia do arquivista e são limpas em TarefaArquivo; recentes e outra empresa seguem a mesma regra por data', async () => {
    const a = await empresa();
    const b = await empresa();
    const fotos = { fotos_conclusao: ['f1', 'f2'], avarias: [{ descricao: 'vidro', fotos: ['f3'], resolvido: true }, { descricao: 'sem fotos', fotos: [] }] };
    const antiga = await arq(a, antes(100), fotos); // 100 d: acima de 30 e de 90
    const antigaB = await arq(b, antes(100), fotos);
    const recente = await arq(a, antes(2), fotos); // estado improvável no arquivo; não mexer em dados recentes
    const r = await executarLimpezaFotos();
    expect(r.arquivoLimpo).toBeGreaterThanOrEqual(2);
    for (const x of [antiga, antigaB]) {
      const d = await TarefaArquivo.collection.findOne({ _id: x.insertedId });
      expect(d.fotos_conclusao).toEqual([]);
      expect(d.avarias.map((v) => v.fotos)).toEqual([[], []]);
      expect(d.avarias[0].descricao).toBe('vidro');
    }
    expect((await TarefaArquivo.collection.findOne({ _id: recente.insertedId })).fotos_conclusao).toEqual(['f1', 'f2']);
    expect((await executarLimpezaFotos()).arquivoLimpo).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Fotos: 30 d (conclusão), 90 d + resolvida (avarias) e proteção Atlas */
/* ------------------------------------------------------------------ */
describe('limpezaFotos: prazos 30/90 e proteção de espaço', () => {
  const tar = (c, dias, x = {}) => Tarefa.collection.insertOne({
    empresa_id: c.e._id, propriedade_id: c.p._id, data: antes(dias), data_conclusao: antes(dias), tempo_limpeza_minutos: 45,
    tipo: 'limpeza', estado: 'concluida', fotos_conclusao: ['F'], avarias: [], ...x,
  });
  const ler = async (r) => Tarefa.collection.findOne({ _id: r.insertedId });
  const stats = (pct, limite = 512) => jest.spyOn(mongoose.connection.db, 'stats').mockResolvedValue({ dataSize: (pct / 100) * limite * 1024 * 1024, storageSize: 1 });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.ATLAS_LIMITE_MB; delete process.env.RETENCAO_FOTOS_DIAS; delete process.env.RETENCAO_FOTOS_AVARIAS_DIAS; });

  test('fotos de conclusão: 29 d mantém, 31 d apaga (Tarefa)', async () => {
    stats(10);
    const c = await empresa();
    const novo = await tar(c, 29);
    const velho = await tar(c, 31);
    await executarLimpezaFotos();
    expect((await ler(novo)).fotos_conclusao).toEqual(['F']);
    expect((await ler(velho)).fotos_conclusao).toEqual([]);
  });

  test('avarias: 90 d e aberta mantém; resolvida antes dos 90 d mantém; resolvida com 90 d apaga; conclusão independente', async () => {
    stats(10);
    const c = await empresa();
    const r = await tar(c, 120, { avarias: [
      { descricao: 'aberta', fotos: ['A'], resolvido: false, data_registo: antes(120) },
      { descricao: 'resolvida velha', fotos: ['B'], resolvido: true, data_registo: antes(100) },
      { descricao: 'resolvida recente', fotos: ['C'], resolvido: true, data_registo: antes(60) },
    ] });
    const res = await executarLimpezaFotos();
    const d = await ler(r);
    expect(d.fotos_conclusao).toEqual([]);
    expect(d.avarias.map((a) => a.fotos)).toEqual([['A'], [], ['C']]);
    expect(d.avarias[1].descricao).toBe('resolvida velha');
    expect(res.fotosRemovidas).toBeGreaterThanOrEqual(2);
    // idempotente
    await executarLimpezaFotos();
    expect((await ler(r)).avarias.map((a) => a.fotos)).toEqual([['A'], [], ['C']]);
  });

  test('avarias: os 90 d contam desde data_resolucao (resolvida hoje mantém, há 91 d apaga, sem data usa o registo)', async () => {
    stats(10);
    const c = await empresa();
    const r = await tar(c, 120, { avarias: [
      { descricao: 'resolvida hoje', fotos: ['A'], resolvido: true, data_registo: antes(100), data_resolucao: new Date() },
      { descricao: 'resolvida ha 91 d', fotos: ['B'], resolvido: true, data_registo: antes(200), data_resolucao: antes(91) },
      { descricao: 'antiga sem data', fotos: ['C'], resolvido: true, data_registo: antes(100) },
      { descricao: 'aberta', fotos: ['D'], resolvido: false, data_registo: antes(300), data_resolucao: null },
    ] });
    const ar = await arq(c, antes(120), { avarias: [
      { descricao: 'hoje', fotos: ['E'], resolvido: true, data_registo: antes(100), data_resolucao: new Date() },
      { descricao: 'velha', fotos: ['F'], resolvido: true, data_registo: antes(100), data_resolucao: antes(91) },
    ] });
    await executarLimpezaFotos();
    expect((await ler(r)).avarias.map((a) => a.fotos)).toEqual([['A'], [], [], ['D']]);
    const d = await TarefaArquivo.collection.findOne({ _id: ar.insertedId });
    expect(d.avarias.map((a) => a.fotos)).toEqual([['E'], []]);
    expect(d.avarias[0].data_resolucao).toBeInstanceOf(Date);
  });

  test('concluir a manutenção grava data_resolucao', async () => {
    const c = await empresa();
    const r = await tar(c, 5, { avarias: [{ _id: new mongoose.Types.ObjectId(), descricao: 'x', fotos: ['A'], resolvido: false, data_registo: antes(100) }] });
    const t = await Tarefa.findById(r.insertedId);
    const item = t.avarias[0];
    expect(item.data_resolucao).toBeNull();
    const m = { tipo: 'manutencao', avaria_origem_id: t._id, avaria_origem_item_id: item._id };
    expect(await resolverAvariaDaManutencao(m)).toBe(true);
    const aposRes = (await Tarefa.findById(t._id)).avarias[0];
    expect(aposRes.resolvido).toBe(true);
    expect(Date.now() - aposRes.data_resolucao.getTime()).toBeLessThan(60000);
  });

  test('arquivo: mesmos prazos (avaria aberta mantém, resolvida a 100 d e conclusão a 40 d apagam)', async () => {
    stats(10);
    const c = await empresa();
    const r = await arq(c, antes(40), { fotos_conclusao: ['X'], avarias: [{ descricao: 'a', fotos: ['Y'], resolvido: false, data_registo: antes(200) }, { descricao: 'b', fotos: ['Z'], resolvido: true, data_registo: antes(100) }] });
    await executarLimpezaFotos();
    const d = await TarefaArquivo.collection.findOne({ _id: r.insertedId });
    expect(d.fotos_conclusao).toEqual([]);
    expect(d.avarias.map((a) => a.fotos)).toEqual([['Y'], []]);
  });

  test('variáveis de ambiente: prazo alterado; abaixo do mínimo volta aos 30 dias', async () => {
    stats(10);
    const c = await empresa();
    process.env.RETENCAO_FOTOS_DIAS = '60';
    const meio = await tar(c, 40);
    await executarLimpezaFotos();
    expect((await ler(meio)).fotos_conclusao).toEqual(['F']);
    process.env.RETENCAO_FOTOS_DIAS = '1'; // abaixo do mínimo -> volta aos 30, não encurta
    const dez = await tar(c, 10);
    const quarenta = await tar(c, 40);
    await executarLimpezaFotos();
    expect((await ler(dez)).fotos_conclusao).toEqual(['F']);
    expect((await ler(quarenta)).fotos_conclusao).toEqual([]);
  });

  test('aos 80%: avisa os admins uma só vez por dia e mantém o prazo de 30 d', async () => {
    const c = await empresa();
    const admin = await c.mk('adminA', 'admin');
    await Notificacao.deleteMany({});
    stats(85);
    const dez = await tar(c, 10);
    const r1 = await executarLimpezaFotos();
    expect(r1.espaco.pct).toBeGreaterThanOrEqual(80);
    expect(r1.espaco.modo7dias).toBe(false);
    expect((await ler(dez)).fotos_conclusao).toEqual(['F']);
    const n = await Notificacao.find({ utilizador_id: admin._id }).lean();
    expect(n).toHaveLength(1);
    expect(n[0].mensagem).toMatch(/85%/);
    await executarLimpezaFotos();
    expect(await Notificacao.countDocuments({ utilizador_id: admin._id })).toBe(1);
  });

  test('abaixo de 80%: sem aviso', async () => {
    const c = await empresa();
    const admin = await c.mk('adminB', 'admin');
    stats(50);
    await executarLimpezaFotos();
    expect(await Notificacao.countDocuments({ utilizador_id: admin._id })).toBe(0);
  });

  test('aos 90%: modo de 7 dias nas fotos de conclusão (avarias intactas) e aviso diz isso; ATLAS_LIMITE_MB respeitado', async () => {
    const c = await empresa();
    const admin = await c.mk('adminC', 'admin');
    await Notificacao.deleteMany({});
    process.env.ATLAS_LIMITE_MB = '100';
    stats(95, 100);
    const dez = await tar(c, 10, { avarias: [{ descricao: 'x', fotos: ['K'], resolvido: true, data_registo: antes(20) }] });
    const tres = await tar(c, 3);
    const r = await executarLimpezaFotos();
    expect(r.espaco.modo7dias).toBe(true);
    expect((await ler(dez)).fotos_conclusao).toEqual([]);
    expect((await ler(dez)).avarias[0].fotos).toEqual(['K']);
    expect((await ler(tres)).fotos_conclusao).toEqual(['F']);
    const n = await Notificacao.findOne({ utilizador_id: admin._id }).lean();
    expect(n.mensagem).toMatch(/7 dias/);
  });

  test('se db.stats() falhar, a limpeza normal conclui sem lançar', async () => {
    jest.spyOn(mongoose.connection.db, 'stats').mockRejectedValue(new Error('sem stats'));
    const c = await empresa();
    const velho = await tar(c, 31);
    const r = await executarLimpezaFotos();
    expect(r.espaco).toBeNull();
    expect((await ler(velho)).fotos_conclusao).toEqual([]);
  });
});
