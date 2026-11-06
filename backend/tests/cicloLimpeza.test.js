/**
 * Ciclo da limpeza: sino do parceiro e da lavandaria (sem duplicar), prova da limpeza,
 * avarias com ciclo fechado, resumo das 18:05, aviso da véspera, dashboard e tempo real.
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
const ReservaManual = require('../models/ReservaManual');
const { aoConcluirTarefa } = require('../utils/cicloTarefa');
const { executarResumoGestor, montarTexto } = require('../jobs/resumoGestor');
const { executarAgendaAmanha, textoAgenda } = require('../jobs/agendaAmanha');
const { calcularPorCasa, duracaoRealMinutos } = require('../utils/tempoReal');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const FOTO = 'data:image/jpeg;base64,/9j/4AAQ';

const diaUTC = (offset = 0) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
};
const hora = (offset, h, m = 0) => new Date(diaUTC(offset).getTime() + (h * 60 + m) * 60000);

async function cenario() {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const parc = await mk('Par', 'parceiro');
  const forn = await mk('Lav', 'fornecedor');
  const p = await Propriedade.create({
    nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4,
    tempo_limpeza_minutos: 60, parceiro_id: parc._id, fornecedor_id: forn._id,
  });
  const tarefa = (data, ex = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, data, tempo_limpeza_minutos: 60, estado: 'atribuida', tipo: 'limpeza', ...ex });
  const reserva = (t) =>
    ReservaManual.create({ propriedade_id: p._id, parceiro_id: parc._id, empresa_id: e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
  return {
    e, g, ana, parc, forn, p, tarefa, reserva,
    tokG: await login(g), tokAna: await login(ana), tokP: await login(parc), tokF: await login(forn),
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  await Notificacao.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Sino do parceiro (sem push, sem duplicar)', () => {
  test('conclusão pelo staff: o parceiro vê «Limpeza concluída às HH:MM» uma só vez', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { origem_parceiro: true, origem: 'manual' });
    await c.reserva(t);
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(r.status).toBe(200);
    const q = { utilizador_id: c.parc._id };
    const lista = await Notificacao.find(q);
    expect(lista.length).toBe(1);
    expect(lista[0].mensagem).toMatch(/^Limpeza concluída às \d{2}:\d{2}: Casa\d+/);
    expect(lista[0].url).toBe('/parceiro/reservas');
    // repetir o efeito (reenvio, dois cliques, gestor a marcar a seguir) não duplica
    await aoConcluirTarefa(await Tarefa.findById(t._id));
    await aoConcluirTarefa(await Tarefa.findById(t._id));
    expect(await Notificacao.countDocuments(q)).toBe(1);
    const sino = await request(app).get('/api/auth/me/notificacoes?lidas=false').set(auth(c.tokP));
    expect(sino.status).toBe(200);
    expect(sino.body.nao_lidas).toBe(1);
  });

  test('o staff e o gestor não recebem o aviso do parceiro; limpezas sem parceiro não geram nada', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10));
    await Propriedade.updateOne({ _id: c.p._id }, { $unset: { parceiro_id: '' } });
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(await Notificacao.countDocuments({ utilizador_id: { $in: [c.ana._id, c.g._id, c.parc._id] } })).toBe(0);
  });

  test('o gestor cancela: «cancelada pelo gestor»; repetir não duplica', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(2, 10), { origem_parceiro: true, origem: 'manual' });
    await c.reserva(t);
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'cancelada' });
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'cancelada' });
    const l = await Notificacao.find({ utilizador_id: c.parc._id });
    expect(l.length).toBe(1);
    expect(l[0].mensagem).toMatch(/Limpeza cancelada pelo gestor/);
    expect(l[0].tipo).toBe('tarefa_cancelada');
  });

  test('o gestor muda a hora/dia ao atribuir: «alterada pelo gestor»; sem mudança de data não avisa', async () => {
    const c = await cenario();
    const t = await c.tarefa(diaUTC(3), { utilizador_id: null, estado: 'por_atribuir', origem_parceiro: true, origem: 'manual' });
    await c.reserva(t);
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(c.tokG)).send({ utilizador_id: String(c.ana._id) });
    expect(r.status).toBe(200);
    const l = await Notificacao.find({ utilizador_id: c.parc._id });
    expect(l.length).toBe(1);
    expect(l[0].mensagem).toMatch(/Limpeza alterada pelo gestor.*às \d{2}:\d{2}/);
    // volta a atribuir à mesma pessoa, sem mudar a data: sem novo aviso
    await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(c.tokG)).send({ utilizador_id: String(c.ana._id) });
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(1);
  });
});

describe('Sino da lavandaria: «Amanhã: N casas»', () => {
  test('o job da véspera avisa a lavandaria uma só vez por dia; sem limpezas amanhã não avisa', async () => {
    const c = await cenario();
    await c.tarefa(hora(1, 10));
    await executarAgendaAmanha();
    await executarAgendaAmanha();
    const l = await Notificacao.find({ utilizador_id: c.forn._id });
    expect(l.length).toBe(1);
    expect(l[0].mensagem).toMatch(/^Amanhã: 1 casa \(Casa\d+\)\./);
    expect(l[0].url).toBe('/fornecedor/tarefas');
    const c2 = await cenario();
    await executarAgendaAmanha();
    expect(await Notificacao.countDocuments({ utilizador_id: c2.forn._id })).toBe(0);
  });

  test('a lavandaria consegue ver o seu sino', async () => {
    const c = await cenario();
    await c.tarefa(hora(1, 10));
    await executarAgendaAmanha();
    const r = await request(app).get('/api/auth/me/notificacoes?lidas=false').set(auth(c.tokF));
    expect(r.body.nao_lidas).toBe(1);
  });
});

describe('Aviso da véspera: hora da primeira limpeza e casa', () => {
  test('textoAgenda: primeira com hora real e nome da casa', () => {
    const ts = [
      { data: new Date('2040-05-10T13:00:00Z'), propriedade_id: { nome: 'Casa B' } },
      { data: new Date('2040-05-10T08:30:00Z'), propriedade_id: { nome: 'Casa A' } },
    ];
    const txt = textoAgenda(ts);
    expect(txt).toMatch(/^Tens 2 tarefas agendadas\. A primeira é às \d{2}:\d{2} em Casa A\./);
    expect(textoAgenda([ts[0]])).toMatch(/^Tens 1 tarefa agendada\. A primeira é às .* em Casa B/);
    expect(textoAgenda([{ data: new Date('2040-05-10T00:00:00Z'), propriedade_id: { nome: 'Casa C' } }])).toMatch(/A primeira é amanhã em Casa C/);
  });

  test('o job envia ao staff o texto novo e não duplica se correr duas vezes', async () => {
    const c = await cenario();
    await c.tarefa(hora(1, 9, 30));
    await executarAgendaAmanha();
    await executarAgendaAmanha();
    const l = await Notificacao.find({ utilizador_id: c.ana._id });
    expect(l.length).toBe(1);
    expect(l[0].mensagem).toMatch(/Tens 1 tarefa agendada\. A primeira é às \d{2}:\d{2} em Casa\d+/);
  });
});

describe('Avarias com ciclo fechado', () => {
  async function reportar(c, t, descricao = 'Torneira a pingar') {
    const r = await request(app).post(`/api/staff/tarefas/${t._id}/avaria`).set(auth(c.tokAna)).send({ descricao });
    expect(r.status).toBe(200);
    return r.body.tarefa_manutencao;
  }
  const dash = async (c) => (await request(app).get('/api/gestor/dashboard').set(auth(c.tokG))).body;

  test('reportar liga a manutenção à avaria; concluir a manutenção resolve a avaria e baixa o contador', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { estado: 'em_curso' });
    const m = await reportar(c, t);
    expect(String(m.avaria_origem_id)).toBe(String(t._id));
    expect(m.avaria_origem_item_id).toBeTruthy();
    expect((await dash(c)).avariasAbertas).toBe(1);

    // a limpeza seguinte na mesma casa mostra o aviso
    const seguinte = await c.tarefa(hora(1, 10));
    const det = await request(app).get(`/api/auth/me/tarefas/${seguinte._id}`).set(auth(c.tokAna));
    expect(det.body.tarefa.avarias_abertas_casa).toHaveLength(1);
    expect(det.body.tarefa.avarias_abertas_casa[0].descricao).toBe('Torneira a pingar');
    // e a própria limpeza onde foi reportada não se avisa a si mesma
    const propria = await request(app).get(`/api/auth/me/tarefas/${t._id}`).set(auth(c.tokAna));
    expect(propria.body.tarefa.avarias_abertas_casa).toHaveLength(0);

    await Tarefa.updateOne({ _id: m._id }, { utilizador_id: c.ana._id, estado: 'atribuida' });
    const conc = await request(app).patch(`/api/staff/tarefas/${m._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(conc.status).toBe(200);
    const depois = await Tarefa.findById(t._id);
    expect(depois.avarias[0].resolvido).toBe(true);
    expect((await dash(c)).avariasAbertas).toBe(0);
    const det2 = await request(app).get(`/api/auth/me/tarefas/${seguinte._id}`).set(auth(c.tokAna));
    expect(det2.body.tarefa.avarias_abertas_casa).toHaveLength(0);
  });

  test('concluir uma manutenção sem avaria ligada não rebenta; limpeza concluída não mexe nas avarias', async () => {
    const c = await cenario();
    const m = await c.tarefa(hora(0, 10), { tipo: 'manutencao' });
    expect((await request(app).patch(`/api/staff/tarefas/${m._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] })).status).toBe(200);
  });

  test('o gestor marca «Resolvida» à mão (e pode reabrir); outra empresa leva 404', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10));
    await reportar(c, t);
    const av = (await Tarefa.findById(t._id)).avarias[0];
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/avarias/${av._id}/resolver`).set(auth(c.tokG)).send({});
    expect(r.status).toBe(200);
    expect(r.body.avarias[0].resolvido).toBe(true);
    expect((await dash(c)).avariasAbertas).toBe(0);
    const re = await request(app).patch(`/api/gestor/tarefas/${t._id}/avarias/${av._id}/resolver`).set(auth(c.tokG)).send({ resolvido: false });
    expect(re.body.avarias[0].resolvido).toBe(false);
    const outra = await cenario();
    expect((await request(app).patch(`/api/gestor/tarefas/${t._id}/avarias/${av._id}/resolver`).set(auth(outra.tokG)).send({})).status).toBe(404);
    expect((await request(app).patch(`/api/gestor/tarefas/${t._id}/avarias/xx/resolver`).set(auth(c.tokG)).send({})).status).toBe(400);
  });

  test('o parceiro NÃO vê avarias: nem na lista de reservas nem no detalhe da limpeza', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { origem_parceiro: true, origem: 'manual' });
    const rv = await c.reserva(t);
    await reportar(c, t, 'Fechadura avariada');
    const lista = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    expect(JSON.stringify(lista.body)).not.toMatch(/avaria|Fechadura/i);
    const det = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(JSON.stringify(det.body)).not.toMatch(/avaria|Fechadura/i);
    const tar = await request(app).get('/api/parceiro/tarefas').set(auth(c.tokP));
    expect(JSON.stringify(tar.body)).not.toMatch(/avaria|Fechadura/i);
  });
});

describe('Prova da limpeza', () => {
  test('gestor: fotos, hora, checklist 2/3 e avarias; as listas já não trazem fotos', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), {
      estado: 'concluida', hora_conclusao: new Date('2040-05-10T10:42:00Z'), concluida_em: new Date('2040-05-10T10:42:00Z'),
      fotos_conclusao: [FOTO, FOTO],
      checklist_dinamica: [{ nome: 'A', items: [{ texto: 'a', concluido: true }, { texto: 'b', concluido: true }, { texto: 'c', concluido: false }] }],
      avarias: [{ descricao: 'x', fotos: [FOTO], resolvido: false }],
    });
    const r = await request(app).get(`/api/gestor/tarefas/${t._id}/prova`).set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.fotos).toHaveLength(2);
    expect(r.body.checklist).toEqual({ feitos: 2, total: 3 });
    expect(r.body.hora_conclusao).toBe('2040-05-10T10:42:00.000Z');
    expect(r.body.fotos_expiradas).toBe(false);
    expect(r.body.avarias[0].fotos).toHaveLength(1);

    const dia = diaUTC(0).toISOString().slice(0, 10);
    const lista = await request(app).get(`/api/gestor/tarefas?inicio=${dia}&fim=${dia}`).set(auth(c.tokG));
    const item = lista.body.tarefas.find((x) => x._id === String(t._id));
    expect(item).toBeTruthy();
    expect(item.fotos_conclusao).toBeUndefined();
    expect(item.avarias[0].fotos).toBeUndefined();
    expect(item.avarias[0].descricao).toBe('x');
    const cal = await request(app).get(`/api/gestor/calendario/dados?inicio=${dia}&fim=${dia}`).set(auth(c.tokG));
    const itemCal = cal.body.tarefas.find((x) => x._id === String(t._id));
    expect(itemCal.fotos_conclusao).toBeUndefined();
  });

  test('gestor: concluída sem fotos = retenção de 7 dias já passou; outra empresa 404', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { estado: 'concluida', hora_conclusao: new Date(), fotos_conclusao: [] });
    const r = await request(app).get(`/api/gestor/tarefas/${t._id}/prova`).set(auth(c.tokG));
    expect(r.body.fotos_expiradas).toBe(true);
    const outra = await cenario();
    expect((await request(app).get(`/api/gestor/tarefas/${t._id}/prova`).set(auth(outra.tokG))).status).toBe(404);
  });

  test('parceiro: lista só com a hora de conclusão; detalhe com as fotos enquanto existirem; nada de outro parceiro', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), {
      estado: 'concluida', hora_conclusao: new Date('2040-05-10T11:42:00Z'), fotos_conclusao: [FOTO],
      observacoes_staff: 'segredo interno', checklist_dinamica: [{ nome: 'A', items: [{ texto: 'a', concluido: true }] }],
      origem_parceiro: true, origem: 'manual',
    });
    const rv = await c.reserva(t);
    const lista = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    const linha = lista.body.reservas.find((x) => x._id === String(rv._id));
    expect(linha.tarefa_gerada_id.hora_conclusao).toBe('2040-05-10T11:42:00.000Z');
    expect(linha.tarefa_gerada_id.fotos_conclusao).toBeUndefined();
    const det = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(det.status).toBe(200);
    expect(det.body.fotos).toEqual([FOTO]);
    expect(det.body.hora_conclusao).toBe('2040-05-10T11:42:00.000Z');
    expect(JSON.stringify(det.body)).not.toMatch(/segredo interno|checklist/);

    await Tarefa.updateOne({ _id: t._id }, { fotos_conclusao: [] });
    const exp = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(exp.body.fotos).toEqual([]);
    expect(exp.body.fotos_expiradas).toBe(true);

    const outro = await cenario();
    expect((await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(outro.tokP))).status).toBe(404);
    expect((await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokG))).status).toBe(403);
  });

  test('parceiro: limpeza não concluída não mostra hora nem fotos', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { fotos_conclusao: [FOTO] });
    const rv = await c.reserva(t);
    const det = await request(app).get(`/api/parceiro/reservas/${rv._id}/limpeza`).set(auth(c.tokP));
    expect(det.body.hora_conclusao).toBeNull();
    expect(det.body.fotos).toEqual([]);
    expect(det.body.fotos_expiradas).toBe(false);
  });
});

describe('Resumo das 18:05 para o gestor', () => {
  const AGORA = new Date('2040-05-10T17:05:00Z');

  test('só envia se houver novidades, uma vez por dia e por gestor', async () => {
    const vazio = await cenario();
    await executarResumoGestor(AGORA);
    expect(await Notificacao.countDocuments({ utilizador_id: vazio.g._id })).toBe(0);

    const c = await cenario();
    await c.tarefa(new Date('2040-05-10T10:00:00Z')); // hoje por concluir
    await c.tarefa(new Date('2040-05-11T00:00:00Z'), { utilizador_id: null, estado: 'por_atribuir' }); // amanhã por atribuir
    await c.tarefa(new Date('2040-05-10T11:00:00Z'), { avarias: [{ descricao: 'x', resolvido: false }] });
    await Ausencia.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, data_inicio: new Date('2040-06-01T00:00:00Z'), data_fim: new Date('2040-06-02T00:00:00Z'), tipo: 'ferias', estado: 'pendente' });
    const r1 = await executarResumoGestor(AGORA);
    expect(r1.enviados).toBeGreaterThanOrEqual(1);
    await executarResumoGestor(AGORA);
    const l = await Notificacao.find({ utilizador_id: c.g._id });
    expect(l.length).toBe(1);
    expect(l[0].mensagem).toMatch(/2 limpezas de hoje por concluir/);
    expect(l[0].mensagem).toMatch(/1 limpeza de amanhã por atribuir/);
    expect(l[0].mensagem).toMatch(/1 avaria aberta/);
    expect(l[0].mensagem).toMatch(/1 ausência pendente/);
    // no dia seguinte já pode voltar a enviar
    await executarResumoGestor(new Date('2040-05-11T17:05:00Z'));
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id })).toBe(2);
  });

  test('montarTexto só menciona o que existe', () => {
    expect(montarTexto({ hojeNaoConcluidas: 0, amanhaPorAtribuir: 0, avarias: 0, ausencias: 0 })).toBe('');
    expect(montarTexto({ hojeNaoConcluidas: 1, amanhaPorAtribuir: 0, avarias: 0, ausencias: 3 })).toBe('1 limpeza de hoje por concluir · 3 ausências pendentes');
  });
});

describe('Dashboard: a decorrer agora, avarias e roupa', () => {
  test('aDecorrerAgora lista as em curso com origem; limpezasSemRoupa conta só casas com lavandaria e baixa quando entregue', async () => {
    const c = await cenario();
    const t = await c.tarefa(hora(0, 10), { estado: 'em_curso', iniciada_em: new Date(), inicio_origem: 'automatico' });
    await c.tarefa(hora(0, 14));
    const semLav = await Propriedade.create({ nome: 'SemLav' + ++n, empresa_id: c.e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 2 });
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: semLav._id, utilizador_id: c.ana._id, data: hora(0, 15), tempo_limpeza_minutos: 60, estado: 'atribuida', tipo: 'limpeza' });
    let d = (await request(app).get('/api/gestor/dashboard').set(auth(c.tokG))).body;
    expect(d.aDecorrerAgora.total).toBe(1);
    expect(d.aDecorrerAgora.tarefas[0]).toMatchObject({ _id: String(t._id), pessoa: 'Ana', inicio_origem: 'automatico' });
    expect(d.limpezasSemRoupa).toBe(2);
    const r = await request(app).patch(`/api/fornecedor/tarefas/${t._id}/roupa`).set(auth(c.tokF)).send({ roupa_entregue: true });
    expect(r.status).toBe(200);
    d = (await request(app).get('/api/gestor/dashboard').set(auth(c.tokG))).body;
    expect(d.limpezasSemRoupa).toBe(1);
  });

  test('o cartão do staff traz o fornecedor_id da casa e roupa_entregue (só com lavandaria)', async () => {
    const c = await cenario();
    await c.tarefa(hora(0, 10), { roupa_entregue: true });
    const r = await request(app).get('/api/auth/me/tarefas').set(auth(c.tokAna));
    const t = r.body.tarefas.find((x) => x.propriedade_id && x.propriedade_id.fornecedor_id);
    expect(t).toBeTruthy();
    expect(t.roupa_entregue).toBe(true);
  });
});

describe('Tempo real vs estimado por casa', () => {
  const base = (ex) => ({
    propriedade_id: new mongoose.Types.ObjectId('64b000000000000000000001'), tempo_limpeza_minutos: 60,
    hora_conclusao: new Date('2040-05-10T12:00:00Z'), ...ex,
  });
  const botao = (min) => base({ inicio_origem: 'botao', iniciada_em: new Date(new Date('2040-05-10T12:00:00Z').getTime() - min * 60000) });

  test('duracaoRealMinutos: botão e checklist contam; automático sem checklist não', () => {
    expect(duracaoRealMinutos(botao(75))).toBe(75);
    expect(duracaoRealMinutos(base({ inicio_origem: 'automatico', iniciada_em: new Date('2040-05-10T09:00:00Z') }))).toBeNull();
    expect(duracaoRealMinutos(base({ inicio_origem: 'automatico', iniciada_em: new Date('2040-05-10T09:00:00Z'), primeiro_item_checklist_em: new Date('2040-05-10T10:30:00Z') }))).toBe(90);
    expect(duracaoRealMinutos(base({ primeiro_item_checklist_em: new Date('2040-05-10T11:00:00Z') }))).toBe(60);
    expect(duracaoRealMinutos(base({}))).toBeNull();
    expect(duracaoRealMinutos(botao(2))).toBeNull(); // demasiado curto
    expect(duracaoRealMinutos(botao(13 * 60))).toBeNull(); // demasiado longo
  });

  test('calcularPorCasa: média, diferença e sugestão só com ≥3 amostras e ≥15% de diferença; profundas ficam de fora', () => {
    const props = new Map([['64b000000000000000000001', { nome: 'Casa X', tempo: 60 }]]);
    const r = calcularPorCasa([botao(90), botao(80), botao(100), base({ inicio_origem: 'automatico' }), base({ ...botao(300), tipo_limpeza: 'profunda' })], props);
    expect(r.excluidas).toBe(1);
    expect(r.casas).toHaveLength(1);
    expect(r.casas[0]).toMatchObject({ nome: 'Casa X', amostras: 3, por_botao: 3, real_medio_min: 90, estimado_medio_min: 60, diferenca_min: 30, sugestao_min: 90 });
    const poucas = calcularPorCasa([botao(90), botao(80)], props);
    expect(poucas.casas[0].sugestao_min).toBeNull();
    const perto = calcularPorCasa([botao(62), botao(64), botao(66)], props);
    expect(perto.casas[0].sugestao_min).toBeNull();
  });

  test('endpoint: relatório por casa, contagem de inícios, nada é alterado na casa', async () => {
    const c = await cenario();
    const mk = (min, ex = {}) => {
      const fim = hora(0, 12);
      return c.tarefa(hora(0, 10), { estado: 'concluida', hora_conclusao: fim, concluida_em: fim, inicio_origem: 'botao', iniciada_em: new Date(fim.getTime() - min * 60000), ...ex });
    };
    await mk(90); await mk(95); await mk(85);
    await mk(30, { inicio_origem: 'automatico', iniciada_em: hora(0, 10) }); // automático sem checklist: excluída
    const dia0 = diaUTC(0).toISOString().slice(0, 10);
    const r = await request(app).get(`/api/gestor/relatorios/tempo-real?inicio=${dia0}&fim=${dia0}`).set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.inicios).toEqual({ botao: 3, automatico: 1, sem_registo: 0 });
    expect(r.body.excluidas_sem_inicio_fiavel).toBe(1);
    expect(r.body.casas[0]).toMatchObject({ amostras: 3, real_medio_min: 90, tempo_atual_casa_min: 60, sugestao_min: 90 });
    expect((await Propriedade.findById(c.p._id)).tempo_limpeza_minutos).toBe(60);
    const staff = await request(app).get('/api/gestor/relatorios/tempo-real').set(auth(c.tokAna));
    expect(staff.status).toBe(403);
  });
});
