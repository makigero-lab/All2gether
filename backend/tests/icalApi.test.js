/**
 * Calendários externos (iCal): API do proprietário e do gestor (acesso, link nunca exposto, limites), reservas
 * sincronizadas na tabela, job, lembretes e RGPD. Rede mockada; base de dados em memória.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
// O transporte real nunca é usado: todas as leituras passam por um transporte falso (global.__transporte).
jest.mock('../utils/calendarioExterno/buscar', () => {
  const real = jest.requireActual('../utils/calendarioExterno/buscar');
  return { ...real, pedir: (...a) => global.__transporte(...a) };
});

const H = require('./helpersIcal');
const { configurarChaves, dia, calendario, PRODID_AIRBNB, PRODID_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario, SENHA } = H;
const app = require('../server');
const Servico = require('../utils/calendarioExterno/servico');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const ReservaManual = require('../models/ReservaManual');
const LeituraCalendario = require('../models/LeituraCalendario');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Notificacao = require('../models/Notificacao');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const rgpdEmpresa = require('../utils/rgpdEmpresa');
const { apagarDadosPessoa, exportarDadosPessoa } = require('../utils/rgpdPessoa');
const job = require('../jobs/sincronizacaoCalendarios');

let mongod;
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const AIRBNB = (evs) => ({ 'www.airbnb.pt': { corpo: calendario(PRODID_AIRBNB, evs) } });
const BOOKING = (evs) => ({ 'ical.booking.com': { corpo: calendario(PRODID_BOOKING, evs.map((e) => ({ summary: 'CLOSED - Not available', ...e }))) } });
const VRBO = { 'www.vrbo.com': { corpo: calendario('-//Vrbo//EN', []) } };
const GOOGLE = { 'calendar.google.com': { corpo: calendario('-//Google Inc//Google Calendar//EN', []) } };

/** Cenário com tokens e um transporte falso global. */
async function cen(opcoes) {
  const c = await cenario(opcoes);
  c.tokG = await login(c.g); c.tokP = await login(c.dono); c.tokO = await login(c.outro); c.tokS = await login(c.staff);
  return c;
}
const usar = (estado) => { const t = criarTransporte(estado); global.__transporte = t; return t; };
const noticias = (u, re) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: re });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), LeituraCalendario.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); usar({}); });

describe('API: acesso e o link nunca aparece', () => {
  test('12/13) o proprietário liga o link; nenhuma resposta nem log contém o link; outro proprietário e gestor de outra empresa não veem nem mexem', async () => {
    const c = await cen();
    const outra = await cen();
    const espias = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
    const url = urlAirbnb();
    const segredo = url.split('?s=')[1];
    usar(AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    const respostas = [];
    const guardar = (r) => { respostas.push(JSON.stringify(r.body)); return r; };

    guardar(await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url }));
    const cr = guardar(await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url }));
    expect(cr.status).toBe(201);
    expect(cr.body.fonte.url_mascara).toMatch(/airbnb\.pt\/calendar\/…/);
    expect(cr.body.fonte.url_mascara).not.toContain(segredo);
    expect(cr.body.fonte.canal).toBe('airbnb');
    const id = cr.body.fonte._id;
    guardar(await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP)));
    guardar(await request(app).get(`/api/parceiro/calendarios/${id}/leituras`).set(auth(c.tokP)));
    guardar(await request(app).get('/api/gestor/calendarios').set(auth(c.tokG)));
    guardar(await request(app).get(`/api/gestor/calendarios/${id}/leituras`).set(auth(c.tokG)));
    guardar(await request(app).post(`/api/parceiro/calendarios/${id}/atualizar`).set(auth(c.tokP)));
    guardar(await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url })); // 409
    guardar(await request(app).get('/api/parceiro/reservas').set(auth(c.tokP)));
    const todo = respostas.join('\n');
    expect(todo).not.toContain(segredo);
    expect(todo).not.toMatch(/https:\/\/www\.airbnb\.pt\/calendar\/ical/);
    const logs = espias.flatMap((e) => e.mock.calls.map((a) => a.map(String).join(' '))).join('\n');
    expect(logs).not.toContain(segredo);
    espias.forEach((e) => e.mockRestore());
    // na base de dados o link está cifrado
    const crua = await FonteCalendario.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(JSON.stringify(crua)).not.toContain(segredo);
    expect(crua.url_cifrada).toMatch(/^v1:1:/);
    expect((await FonteCalendario.findById(id).lean()).url_cifrada).toBeUndefined(); // select:false

    // outro proprietário e gestor de outra empresa
    for (const tok of [c.tokO]) {
      expect((await request(app).get('/api/parceiro/calendarios').set(auth(tok))).body.fontes).toHaveLength(0);
      expect((await request(app).post(`/api/parceiro/calendarios/${id}/atualizar`).set(auth(tok))).status).toBe(404);
      expect((await request(app).delete(`/api/parceiro/calendarios/${id}`).set(auth(tok))).status).toBe(403);
      expect((await request(app).put(`/api/parceiro/calendarios/${id}`).set(auth(tok)).send({ url: urlAirbnb() })).status).toBe(403);
      expect((await request(app).get(`/api/parceiro/calendarios/${id}/leituras`).set(auth(tok))).status).toBe(404);
      expect((await request(app).post('/api/parceiro/calendarios').set(auth(tok)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() })).status).toBe(403);
    }
    expect((await request(app).get('/api/gestor/calendarios').set(auth(outra.tokG))).body.fontes).toHaveLength(0);
    expect((await request(app).delete(`/api/gestor/calendarios/${id}`).set(auth(outra.tokG))).status).toBe(404);
    expect((await request(app).post('/api/gestor/calendarios').set(auth(outra.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() })).status).toBe(404);
    expect((await request(app).patch(`/api/gestor/calendarios/${id}/estado`).set(auth(outra.tokG)).send({ acao: 'pausar' })).status).toBe(404);
    // staff não usa nenhuma das rotas; proprietário não usa as do gestor
    expect((await request(app).get('/api/parceiro/calendarios').set(auth(c.tokS))).status).toBe(403);
    expect((await request(app).get('/api/gestor/calendarios').set(auth(c.tokS))).status).toBe(403);
    expect((await request(app).get('/api/gestor/calendarios').set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get('/api/parceiro/calendarios')).status).toBe(401);
    // validação de tipos
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: { href: url } })).status).toBe(400);
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: 'xx', url })).status).toBe(400);
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: 'http://www.airbnb.pt/calendar/ical/1.ics' })).status).toBe(400);
    // casa de outro proprietário
    expect((await request(app).post('/api/gestor/calendarios').set(auth(outra.tokG)).send({ propriedade_id: String(c.alheia._id), url: urlAirbnb() })).status).toBe(404);
  });

  test('sem as chaves configuradas: 503, a funcionalidade fica desligada e o job não corre', async () => {
    const c = await cen();
    delete process.env.ICAL_CHAVES;
    const r = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(r.status).toBe(503);
    expect((await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() })).status).toBe(503);
    expect((await job.executarTique()).ligado).toBe(false);
    const lst = await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP));
    expect(lst.body.ligado).toBe(false);
    expect(await FonteCalendario.countDocuments({ empresa_id: c.e._id })).toBe(0);
    // interruptor de emergência
    configurarChaves();
    process.env.ICAL_SYNC_ATIVO = 'false';
    expect((await job.executarTique()).ligado).toBe(false);
    delete process.env.ICAL_SYNC_ATIVO;
  });

  test('o gestor também liga o link, na casa do proprietário, e decide períodos em nome dele', async () => {
    const c = await cen();
    usar(BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 40 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    expect(cr.status).toBe(201);
    expect(String(cr.body.fonte.parceiro_id)).toBe(String(c.dono._id));
    expect(cr.body.leitura.alteracoes.por_confirmar).toBe(2);
    // o proprietário vê a fonte e os períodos por confirmar
    expect((await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP))).body.fontes).toHaveLength(1);
    const pc = await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar').set(auth(c.tokP));
    expect(pc.body.reservas_externas).toHaveLength(2);
    const gl = await request(app).get(`/api/gestor/reservas-externas?estado=por_confirmar&parceiro_id=${c.dono._id}`).set(auth(c.tokG));
    expect(gl.body.reservas_externas).toHaveLength(2);
    // casa sem proprietário: não se liga
    const sem = await Propriedade.create({ nome: 'Sem dono', empresa_id: c.e._id, ativo: true, origem: 'manual' });
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(sem._id), url: urlAirbnb() })).status).toBe(400);
    // o proprietário confirma um e diz que o outro é bloqueio
    const [a, b] = pc.body.reservas_externas;
    const ok = await request(app).post(`/api/parceiro/reservas-externas/${a._id}/confirmar`).set(auth(c.tokP)).send({ hospedes: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.reserva.hospedes).toBe(3);
    expect((await request(app).post(`/api/parceiro/reservas-externas/${a._id}/confirmar`).set(auth(c.tokP)).send({})).status).toBe(409);
    expect((await request(app).post(`/api/parceiro/reservas-externas/${b._id}/bloqueio`).set(auth(c.tokP)).send({})).status).toBe(200);
    // outro proprietário não decide
    expect((await request(app).post(`/api/parceiro/reservas-externas/${b._id}/reabrir`).set(auth(c.tokO))).status).toBe(404);
    expect((await request(app).post(`/api/gestor/reservas-externas/${b._id}/reabrir`).set(auth(c.tokG))).status).toBe(200);
    // pausar e retomar pelo gestor
    const id = cr.body.fonte._id;
    expect((await request(app).patch(`/api/gestor/calendarios/${id}/estado`).set(auth(c.tokG)).send({ acao: 'pausar' })).body.fonte.estado).toBe('pausada');
    expect((await request(app).patch(`/api/gestor/calendarios/${id}/estado`).set(auth(c.tokG)).send({ acao: 'retomar' })).body.fonte.estado).toBe('ativa');
    expect((await request(app).patch(`/api/gestor/calendarios/${id}/estado`).set(auth(c.tokG)).send({ acao: 'xx' })).status).toBe(400);
    // diagnóstico completo só no gestor (UID e datas); o proprietário só o resumo
    const dg = await request(app).get(`/api/gestor/calendarios/${id}/leituras`).set(auth(c.tokG));
    expect(dg.body.leituras[0].eventos).toBeTruthy();
    const dp = await request(app).get(`/api/parceiro/calendarios/${id}/leituras`).set(auth(c.tokP));
    expect(dp.body.leituras[0].eventos).toBeUndefined();
    expect(dp.body.leituras[0].amostra_redigida).toBeUndefined();
  });

  test('«Testar» lê e analisa sem gravar; recusa link já usado noutra casa; 10 por hora', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 20, co: 23 }, { uid: 'n', ci: 30, co: 33, summary: 'Airbnb (Not available)' }]));
    const url = urlAirbnb();
    const t = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true, canal: 'airbnb', reservas: 1, bloqueios: 1, prodid_ok: true });
    expect(t.body.amostra).toHaveLength(2);
    expect(await FonteCalendario.countDocuments({ empresa_id: c.e._id })).toBe(0);
    expect(await ReservaManual.countDocuments({ empresa_id: c.e._id })).toBe(0);
    // erro do canal em linguagem simples
    usar({ 'www.airbnb.pt': { status: 404, corpo: '' } });
    const e = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(e.body.ok).toBe(false);
    expect(e.body.erro).toMatch(/deixou de funcionar/);
    // limite por hora configurável (ICAL_TESTES_POR_HORA; por omissão 60): com 5, já gastámos 2
    process.env.ICAL_TESTES_POR_HORA = '5';
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() })).status).toBe(200);
    const sexto = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    delete process.env.ICAL_TESTES_POR_HORA;
    expect(sexto.status).toBe(429);
    expect(sexto.body.erro).toMatch(/às \d{2}:\d{2}/);
  });
});

describe('limites', () => {
  test('29) 4.ª fonte na casa, mesmo link em duas casas, mesmo canal duas vezes, «Atualizar agora» duas vezes em 10 min', async () => {
    const c = await cen();
    usar({ ...AIRBNB([]), ...BOOKING([]), ...VRBO, ...GOOGLE });
    const post = (b) => request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), ...b });
    const a = await post({ url: urlAirbnb() });
    expect(a.status).toBe(201);
    expect((await post({ url: urlAirbnb() })).status).toBe(409); // o mesmo canal duas vezes
    expect((await post({ url: urlBooking() })).status).toBe(201);
    expect((await post({ url: 'https://www.vrbo.com/icalendar/abc123.ics' })).status).toBe(201);
    const quarta = await post({ url: 'https://calendar.google.com/calendar/ical/xyz/private-abc/basic.ics' });
    expect(quarta.status).toBe(400);
    expect(quarta.body.codigo).toBe('LIMITE');
    // o mesmo link noutra casa
    const casa2 = await Propriedade.create({ nome: 'Casa B', empresa_id: c.e._id, ativo: true, origem: 'manual', parceiro_id: c.dono._id, capacidade_hospedes: 2 });
    const url = urlAirbnb();
    const casa3 = await Propriedade.create({ nome: 'Casa C', empresa_id: c.e._id, ativo: true, origem: 'manual', parceiro_id: c.dono._id, capacidade_hospedes: 2 });
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(casa2._id), url })).status).toBe(201);
    const rep = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(casa3._id), url });
    expect(rep.status).toBe(409);
    expect(rep.body.codigo).toBe('LINK_REPETIDO');
    // atualizar agora: 1 vez em 10 min
    const id = a.body.fonte._id;
    expect((await request(app).post(`/api/parceiro/calendarios/${id}/atualizar`).set(auth(c.tokP))).status).toBe(200);
    const dois = await request(app).post(`/api/parceiro/calendarios/${id}/atualizar`).set(auth(c.tokP));
    expect(dois.status).toBe(429);
    expect(dois.body.erro).toMatch(/Já atualizaste/);
    // limites configuráveis por variável
    process.env.ICAL_MAX_FONTES_PARCEIRO = '3';
    const mais = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(casa3._id), url: urlAirbnb() });
    expect(mais.status).toBe(400);
    delete process.env.ICAL_MAX_FONTES_PARCEIRO;
  });
});

describe('tabela de Reservas: reservas sincronizadas', () => {
  test('28) as reservas iCal aparecem com a origem; PUT recusa datas e aceita hóspedes/tipo; DELETE cancela a limpeza e marca bloqueio; o gestor vê o mesmo', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 20, co: 23 }, { uid: 'a2', ci: 30, co: 32 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(cr.status).toBe(201);
    const lista = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    expect(lista.body.reservas).toHaveLength(2);
    expect(lista.body.reservas.every((r) => r.origem === 'ical' && r.sincronizada === true && r.plataforma === 'Airbnb')).toBe(true);
    const gl = await request(app).get(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG));
    expect(gl.body.reservas).toHaveLength(2);
    expect(gl.body.reservas[0].origem).toBe('ical');

    const r1 = lista.body.reservas.find((r) => String(r.check_out).startsWith(dia(23)));
    const d = await request(app).put(`/api/parceiro/reservas/${r1._id}`).set(auth(c.tokP)).send({ check_out: dia(25) });
    expect(d.status).toBe(400);
    expect(d.body.codigo).toBe('DATAS_SINCRONIZADAS');
    expect((await request(app).put(`/api/gestor/parceiros/${c.dono._id}/reservas/${r1._id}`).set(auth(c.tokG)).send({ check_in: dia(19) })).status).toBe(400);
    const ok = await request(app).put(`/api/parceiro/reservas/${r1._id}`).set(auth(c.tokP)).send({ hospedes: 2, tipo_limpeza: 'profunda', check_out: dia(23), nome_hospede: 'Ana' });
    expect(ok.status).toBe(200);
    expect(ok.body.reserva.hospedes).toBe(2);
    expect(ok.body.reserva.tipo_limpeza).toBe('profunda');

    const del = await request(app).delete(`/api/parceiro/reservas/${r1._id}`).set(auth(c.tokP));
    expect(del.status).toBe(200);
    const rm = await ReservaManual.findById(r1._id);
    expect(rm).toBeTruthy(); // não se apaga: o canal voltaria a trazê-la
    expect(rm.cancelada_em).toBeTruthy();
    expect(rm.cancelada_motivo).toBe('parceiro');
    expect((await Tarefa.findById(rm.tarefa_gerada_id)).estado).toBe('cancelada');
    const ex = await ReservaExterna.findById(rm.reserva_externa_id);
    expect(ex.estado).toBe('bloqueio');
    expect(ex.decidido_por).toBe('parceiro');
    // lido outra vez, não volta a criar nada
    await Servico.atualizarAgora({ id: cr.body.fonte._id, escopo: c.escopoP, ator: c.ator, agora: new Date(Date.now() + 11 * 60000) });
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(2);
    expect((await Tarefa.countDocuments({ propriedade_id: c.casa._id, tipo: 'limpeza', estado: { $ne: 'cancelada' } }))).toBe(1);
    // o gestor apaga a outra em nome do proprietário: mesmo tratamento e o proprietário é avisado
    const r2 = lista.body.reservas.find((r) => String(r.check_out).startsWith(dia(32)));
    expect((await request(app).delete(`/api/gestor/parceiros/${c.dono._id}/reservas/${r2._id}`).set(auth(c.tokG))).status).toBe(200);
    expect(await noticias(c.dono, /A All2gether apagou uma reserva tua/)).toBe(1);
    // reservas manuais continuam a ser apagadas normalmente
    const manual = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(c.casa._id), check_in: dia(50), check_out: dia(53) });
    expect((await request(app).delete(`/api/parceiro/reservas/${manual.body.reserva._id}`).set(auth(c.tokP))).status).toBe(200);
    expect(await ReservaManual.findById(manual.body.reserva._id)).toBeNull();
  });

  test('o gestor de uma casa recebe o aviso das 48 h para limpezas novas do calendário (e não para as de datas distantes)', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'perto', ci: -1, co: 1 }, { uid: 'longe', ci: 30, co: 33 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(cr.status).toBe(201);
    expect(await noticias(c.g, /O calendário Airbnb criou uma reserva/)).toBe(1);
  });
});

describe('job, lembretes e RGPD', () => {
  test('o job lê as fontes devidas (rede falsa), 1 por servidor de cada vez, e manda os lembretes d3/d1 sem repetir', async () => {
    const c = await cen();
    usar(BOOKING([{ uid: 'b1', ci: 10, co: 13 }, { uid: 'b2', ci: 20, co: 21 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    const id = cr.body.fonte._id;
    await FonteCalendario.updateOne({ _id: id }, { $set: { proxima_leitura_em: new Date(Date.now() - 1000) } });
    const t = usar(BOOKING([{ uid: 'b1', ci: 10, co: 13 }, { uid: 'b2', ci: 20, co: 21 }]));
    const r = await job.executarTique({ agora: new Date() });
    expect(r.lidas).toBeGreaterThanOrEqual(1);
    expect(t.pedidos.length).toBeGreaterThanOrEqual(1);
    const f = await FonteCalendario.findById(id).lean();
    expect(f.proxima_leitura_em.getTime()).toBeGreaterThan(Date.now() + 55 * 60000); // a seguir, daqui a ~1 h
    // lembretes: período por confirmar com saída daqui a 3 dias e a 1 dia
    await ReservaExterna.updateOne({ uid: 'b1', propriedade_id: c.casa._id }, { $set: { check_in: new Date(`${dia(0)}T00:00:00Z`), check_out: new Date(`${dia(3)}T00:00:00Z`) } });
    await ReservaExterna.updateOne({ uid: 'b2', propriedade_id: c.casa._id }, { $set: { check_in: new Date(`${dia(0)}T00:00:00Z`), check_out: new Date(`${dia(1)}T00:00:00Z`) } });
    expect(await job.enviarLembretes()).toBe(2);
    expect(await job.enviarLembretes()).toBe(0);
    expect(await noticias(c.dono, /Falta confirmar/)).toBe(2);
    expect(await noticias(c.g, /Falta confirmar/)).toBe(1); // só o d1 vai ao gestor
  });

  test('30) RGPD: as 3 coleções estão cobertas; apagar a empresa e o proprietário limpa tudo; TTL e índices existem', async () => {
    const cobertas = rgpdEmpresa.coleccoesCobertas();
    for (const nome of ['fontecalendarios', 'reservaexternas', 'leituracalendarios']) expect(cobertas).toContain(nome);
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 20, co: 23, desc: 'Reservation URL: https://www.airbnb.com/reservation/itinerary?code=ABC123' }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(cr.status).toBe(201);
    expect((await ReservaExterna.findOne({ propriedade_id: c.casa._id })).codigo_ref_hash).toBeTruthy();
    const exp = await exportarDadosPessoa(await Utilizador.findById(c.dono._id).lean());
    expect(exp.calendarios_externos).toHaveLength(1);
    expect(JSON.stringify(exp.calendarios_externos)).not.toMatch(/https:\/\//);
    // apagar o proprietário: fontes e leituras desaparecem; da externa fica só as datas
    const r = await apagarDadosPessoa(await Utilizador.findById(c.dono._id).lean());
    expect(r.calendarios_apagados).toBe(1);
    expect(await FonteCalendario.countDocuments({ parceiro_id: c.dono._id })).toBe(0);
    expect(await LeituraCalendario.countDocuments({ empresa_id: c.e._id })).toBe(0);
    expect((await ReservaExterna.findOne({ propriedade_id: c.casa._id })).codigo_ref_hash).toBeNull();
    // apagar a empresa leva as 3 coleções
    const c2 = await cen();
    usar(AIRBNB([{ uid: 'z1', ci: 20, co: 23 }]));
    await request(app).post('/api/gestor/calendarios').set(auth(c2.tokG)).send({ propriedade_id: String(c2.casa._id), url: urlAirbnb() });
    expect(await FonteCalendario.countDocuments({ empresa_id: c2.e._id })).toBe(1);
    await rgpdEmpresa.apagarEmpresaDefinitivo(c2.e._id);
    for (const M of [FonteCalendario, ReservaExterna, LeituraCalendario, ReservaManual]) expect(await M.countDocuments({ empresa_id: c2.e._id })).toBe(0);
    expect(await Empresa.findById(c2.e._id)).toBeNull();
    // índices TTL e únicos
    const ix = async (M) => (await M.collection.indexes());
    expect((await ix(FonteCalendario)).find((i) => i.key.apagar_apos === 1 && i.expireAfterSeconds === 0)).toBeTruthy();
    expect((await ix(ReservaExterna)).find((i) => i.key.apagar_apos === 1 && i.expireAfterSeconds === 0)).toBeTruthy();
    expect((await ix(LeituraCalendario)).find((i) => i.key.iniciada_em === 1 && i.expireAfterSeconds === 2592000)).toBeTruthy();
    expect((await ix(ReservaManual)).find((i) => i.key.reserva_externa_id === 1 && i.unique)).toBeTruthy();
    expect((await ix(ReservaExterna)).find((i) => i.key.propriedade_id === 1 && i.key.canal_chave === 1 && i.key.uid === 1 && i.unique)).toBeTruthy();
  });
});
