/**
 * Validacao do parametro `ate` e isolamento (auditoria @Tester, UX S1/S4/S11). Mongo em memoria, rede mockada.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
jest.mock('../utils/calendarioExterno/buscar', () => {
  const real = jest.requireActual('../utils/calendarioExterno/buscar');
  return { ...real, pedir: (...a) => global.__transporte(...a) };
});

const H = require('./helpersIcal');
const { configurarChaves, dia, calendario, PRODID_AIRBNB, PRODID_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario, SENHA } = H;
const app = require('../server');
const Servico = require('../utils/calendarioExterno/servico');
const { sincronizarFonte } = require('../utils/calendarioExterno/sincronizar');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const ReservaManual = require('../models/ReservaManual');
const LeituraCalendario = require('../models/LeituraCalendario');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');

let mongod;
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const AIRBNB = (evs) => ({ 'www.airbnb.pt': { corpo: calendario(PRODID_AIRBNB, evs) } });
const BOOKING = (evs) => ({ 'ical.booking.com': { corpo: calendario(PRODID_BOOKING, evs.map((e) => ({ summary: 'CLOSED - Not available', ...e }))) } });
async function cen() {
  const c = await cenario();
  c.tokG = await login(c.g); c.tokP = await login(c.dono); c.tokO = await login(c.outro); c.tokS = await login(c.staff);
  return c;
}
const usar = (estado) => { const t = criarTransporte(estado); global.__transporte = t; return t; };

beforeAll(async () => {
  configurarChaves();
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), LeituraCalendario.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); usar({}); });

async function ligarHttp(c, tok, casa, url, estado) {
  const t = usar(estado);
  const r = await request(app).post('/api/gestor/calendarios').set(auth(tok)).send({ propriedade_id: String(casa._id), url });
  expect(r.status).toBe(201);
  return { id: r.body.fonte._id, t, estado };
}

describe('API ate: validacao e isolamento (HTTP)', () => {
  test('formatos invalidos, operadores e datas absurdas nunca dao 500 nem alargam o ambito', async () => {
    const c = await cen();
    await ligarHttp(c, c.tokG, c.casa, urlBooking(), BOOKING([{ uid: 'b1', ci: 2, co: 4 }, { uid: 'b2', ci: 10, co: 12 }, { uid: 'b3', ci: 40, co: 42 }]));
    const get = (q, tok = c.tokG, base = '/api/gestor') => request(app).get(`${base}/reservas-externas?estado=por_confirmar${q}`).set(auth(tok));
    const bons = [
      '', '&ate=', '&ate=lixo', '&ate=2026-13-45', '&ate=2026-02-31', '&ate=9999-99-99', '&ate=0000-00-00', '&ate=' + dia(5) + 'T00:00:00Z', '&ate=' + dia(5) + ' ',
      '&ate[$ne]=x', '&ate[$gt]=', '&ate[$where]=1', '&ate=a&ate=b', '&ate[]=' + dia(5), '&ate=%00', '&ate=' + encodeURIComponent('{"$gt":""}'),
      '&ate=' + dia(5) + '&proximos_dias=abc', '&proximos_dias[$ne]=1', '&proximos_dias=-1', '&proximos_dias=99999', '&estado[$ne]=x',
    ];
    const resultados = [];
    for (const q of bons) {
      const r = await get(q);
      resultados.push([q, r.status, r.body.total]);
    }
    console.log('ATE-RESULTADOS ' + JSON.stringify(resultados));
    for (const [q, st] of resultados) {
      if (q.includes('estado[')) expect([200, 400]).toContain(st); else expect([q, st]).toEqual([q, 200]);
    }
    expect((await get('&ate=' + dia(5))).body.total).toBe(1);
    expect((await get('&ate=' + dia(11))).body.total).toBe(2);
    expect((await get('&ate[$ne]=x')).body.total).toBe(3);
  });

  test('isolamento: proprietario so ve o seu; outro proprietario, outra empresa e staff nao veem nada', async () => {
    const c = await cen();
    const outraEmp = await cen();
    await ligarHttp(c, c.tokG, c.casa, urlBooking(), BOOKING([{ uid: 'b1', ci: 2, co: 4 }]));
    const ate = '&ate=' + dia(30);
    const g = await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokG));
    expect(g.body.total).toBe(1);
    const p = await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokP));
    expect(p.body.total).toBe(1);
    const o = await request(app).get(`/api/parceiro/reservas-externas?estado=por_confirmar${ate}&parceiro_id=${c.dono._id}`).set(auth(c.tokO));
    expect(o.status).toBe(200); expect(o.body.total).toBe(0);
    const x = await request(app).get(`/api/gestor/reservas-externas?estado=por_confirmar${ate}&parceiro_id=${c.dono._id}`).set(auth(outraEmp.tokG));
    expect(x.status).toBe(200); expect(x.body.total).toBe(0);
    expect((await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokS))).status).toBe(403);
    expect((await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokG))).status).toBe(403);
    expect((await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar' + ate).set(auth(c.tokS))).status).toBe(403);
    expect((await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar' + ate)).status).toBe(401);
  });
});

describe('morada_curta: so o gestor da propria empresa', () => {
  test('resumo nao mistura empresas, proprietario/staff/anonimo nao acedem, tamanho limitado', async () => {
    const c = await cen();
    const outraEmp = await cen();
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada_estruturada: { rua: 'Rua Secreta A 1', cidade: 'Lisboa' } } });
    await Propriedade.updateOne({ _id: outraEmp.casa._id }, { $set: { morada: 'RUA DA OUTRA EMPRESA 99, Porto', morada_estruturada: { rua: 'RUA DA OUTRA EMPRESA 99', cidade: 'Porto' } } });
    await Propriedade.updateOne({ _id: c.alheia._id }, { $set: { morada: 'X'.repeat(500) + ', ' + 'Y'.repeat(500) } });
    const r = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(r.status).toBe(200);
    const txt = JSON.stringify(r.body);
    expect(txt).toContain('Rua Secreta A 1, Lisboa');
    expect(txt).not.toContain('OUTRA EMPRESA');
    const casas = r.body.proprietarios.flatMap((p) => p.casas);
    for (const k of casas) if (k.morada_curta) expect(k.morada_curta.length).toBeLessThanOrEqual(60);
    expect((await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokS))).status).toBe(403);
    expect((await request(app).get('/api/gestor/integracoes/resumo')).status).toBe(401);
    for (const u of ['/api/parceiro/calendarios', '/api/parceiro/reservas-externas?estado=por_confirmar']) {
      const rp = await request(app).get(u).set(auth(c.tokO));
      expect(JSON.stringify(rp.body)).not.toContain('Rua Secreta');
    }
  });
});

describe('falha_desde: ciclos', () => {
  test('sucesso>erro>erro>sucesso>erro: novo inicio so no erro depois do sucesso', async () => {
    const c = await cen();
    const bom = AIRBNB([{ uid: 'u1@airbnb.com', ci: 20, co: 23 }]);
    const f = await ligarHttp(c, c.tokG, c.casa, urlAirbnb(), { ...bom });
    const ler = (agora) => sincronizarFonte(f.id, { transporte: f.t, agora });
    const lerF = async () => FonteCalendario.findById(f.id).lean();
    const T = Date.now();
    const t = (h) => new Date(T + h * 3600000);
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await ler(t(1)); const a = (await lerF()).falha_desde;
    await ler(t(2)); await ler(t(3)); await ler(t(4));
    const b = await lerF();
    expect(a.getTime()).toBe(t(1).getTime()); expect(b.falha_desde.getTime()).toBe(a.getTime());
    expect(b.estado).toBe('erro'); expect(b.erros_consecutivos).toBe(4);
    f.estado['www.airbnb.pt'] = bom['www.airbnb.pt'];
    await ler(t(5));
    const c1 = await lerF(); expect(c1.falha_desde).toBeUndefined(); expect(c1.estado).toBe('ativa'); expect(c1.erros_consecutivos).toBe(0);
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await ler(t(6));
    const d = await lerF(); expect(d.falha_desde.getTime()).toBe(t(6).getTime());
    expect(d.estado).toBe('ativa');
  });

  test('substituir link e retomar limpam; API do proprietario so mostra o seu', async () => {
    const c = await cen();
    const bom = AIRBNB([{ uid: 'u1@airbnb.com', ci: 20, co: 23 }]);
    const f = await ligarHttp(c, c.tokG, c.casa, urlAirbnb(), { ...bom });
    const lerF = async () => FonteCalendario.findById(f.id).lean();
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await sincronizarFonte(f.id, { transporte: f.t });
    expect((await lerF()).falha_desde).toBeInstanceOf(Date);
    f.estado['www.airbnb.pt'] = bom['www.airbnb.pt'];
    const novo = urlAirbnb().replace(/s=[^&]+/, 's=outrosegredo' + Date.now());
    const rs = await request(app).put(`/api/gestor/calendarios/${f.id}`).set(auth(c.tokG)).send({ url: novo });
    console.log('SUBSTITUIR status', rs.status, JSON.stringify(rs.body).slice(0, 200));
    expect(rs.status).toBe(200);
    expect((await lerF()).falha_desde).toBeUndefined();
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await sincronizarFonte(f.id, { transporte: f.t });
    expect((await lerF()).falha_desde).toBeInstanceOf(Date);
    const rp = await request(app).patch(`/api/gestor/calendarios/${f.id}/estado`).set(auth(c.tokG)).send({ acao: 'pausar' });
    expect(rp.status).toBe(200);
    expect((await lerF()).falha_desde).toBeInstanceOf(Date); // pausar mantem
    const rr = await request(app).patch(`/api/gestor/calendarios/${f.id}/estado`).set(auth(c.tokG)).send({ acao: 'retomar' });
    expect(rr.status).toBe(200);
    expect((await lerF()).falha_desde).toBeUndefined();
    const res = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(JSON.stringify(res.body)).not.toMatch(/outrosegredo|\?s=/);
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await sincronizarFonte(f.id, { transporte: f.t });
    const pr = await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP));
    expect(JSON.stringify(pr.body)).toContain('falha_desde');
    const po = await request(app).get('/api/parceiro/calendarios').set(auth(c.tokO));
    expect(JSON.stringify(po.body)).not.toContain('falha_desde');
  });
});

describe('ronda 3: o proprietário recebe rua e localidade só das suas casas', () => {
  test('GET /api/parceiro/propriedades traz morada_rua e morada_localidade', async () => {
    const c = await cen();
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada_estruturada: { rua: 'Rua Augusta 100', cidade: 'Lisboa' } } });
    const r = await request(app).get('/api/parceiro/propriedades').set(auth(c.tokP));
    expect(r.status).toBe(200);
    const minha = r.body.propriedades.find((p) => String(p._id) === String(c.casa._id));
    expect(minha).toMatchObject({ morada_rua: 'Rua Augusta 100', morada_localidade: 'Lisboa', morada_curta: 'Rua Augusta 100, Lisboa' });
    expect(r.body.propriedades.some((p) => String(p._id) === String(c.alheia._id))).toBe(false);
  });
});
