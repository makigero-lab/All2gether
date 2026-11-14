/**
 * Integrações (UX S1/S4): «desde quando falha» (falha_desde) e filtro `ate` da lista por confirmar.
 * Rede mockada; base de dados em memória.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const H = require('./helpersIcal');
const { configurarChaves, dia, calendario, PRODID_AIRBNB, PRODID_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario } = H;
const Servico = require('../utils/calendarioExterno/servico');
const Integracoes = require('../utils/calendarioExterno/integracoes');
const { sincronizarFonte } = require('../utils/calendarioExterno/sincronizar');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const ReservaManual = require('../models/ReservaManual');
const LeituraCalendario = require('../models/LeituraCalendario');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');

let mongod;
beforeAll(async () => {
  configurarChaves();
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), LeituraCalendario.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); });

const AIRBNB = (evs) => ({ 'www.airbnb.pt': { corpo: calendario(PRODID_AIRBNB, evs) } });
const BOOKING = (evs) => ({ 'ical.booking.com': { corpo: calendario(PRODID_BOOKING, evs.map((e) => ({ summary: 'CLOSED - Not available', ...e }))) } });

async function ligar(c, url, estado) {
  const t = criarTransporte(estado);
  const r = await Servico.criarLigacao({ propriedadeId: c.casa._id, url, escopo: c.escopoP, ator: c.ator, transporte: t });
  expect(r.status).toBe(201);
  return { id: r.body.fonte._id, t, estado };
}
const ler = (f, opcoes = {}) => sincronizarFonte(f.id, { transporte: f.t, ...opcoes });
const donoDe = (r, c) => r.body.proprietarios.find((p) => String(p._id) === String(c.dono._id));

describe('S1: falha_desde', () => {
  test('regista-se no 1.º erro, mantém-se nos seguintes, aparece no resumo e limpa-se ao ler bem', async () => {
    const c = await cenario();
    const bom = AIRBNB([{ uid: 'u1@airbnb.com', ci: 20, co: 23 }]);
    const f = await ligar(c, urlAirbnb(), { ...bom });
    expect((await FonteCalendario.findById(f.id).lean()).falha_desde).toBeUndefined();

    const t0 = new Date();
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await ler(f, { agora: t0 });
    await ler(f, { agora: new Date(t0.getTime() + 3600000) });
    await ler(f, { agora: new Date(t0.getTime() + 2 * 3600000) });
    const falha = await FonteCalendario.findById(f.id).lean();
    expect(falha.estado).toBe('erro');
    expect(falha.erros_consecutivos).toBe(3);
    expect(falha.falha_desde.getTime()).toBe(t0.getTime()); // o 1.º erro, não o último

    const prop = donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c);
    const cel = prop.casas[0].airbnb;
    expect(cel.erro.temporario).toBe(true);
    expect(new Date(cel.erro.falha_desde).getTime()).toBe(t0.getTime());
    expect(new Date(cel.erro.proxima_leitura_em).getTime()).toBe(falha.proxima_leitura_em.getTime());
    expect(prop.primeiro_erro.falha_desde).toBeTruthy();
    expect(prop.erros[0].proxima_leitura_em).toBeTruthy();

    f.estado['www.airbnb.pt'] = bom['www.airbnb.pt'];
    await ler(f, { agora: new Date(t0.getTime() + 3 * 3600000) });
    const rec = await FonteCalendario.findById(f.id).lean();
    expect(rec.estado).toBe('ativa');
    expect(rec.falha_desde).toBeUndefined();
    expect(donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c).casas[0].airbnb.erro).toBeNull();
  });

  test('fontes antigas em erro (sem falha_desde) não inventam a data: devolvem null e continuam a funcionar', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'u1@airbnb.com', ci: 20, co: 23 }]));
    await FonteCalendario.updateOne({ _id: f.id }, { $set: { estado: 'erro', erros_consecutivos: 4, ultimo_erro: { em: new Date(), codigo: 'http_5xx' } } });
    const cel = donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c).casas[0].airbnb;
    expect(cel.erro.falha_desde).toBeNull();
    // um novo erro sobre uma série já em curso também não inventa o início
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await ler(f);
    expect((await FonteCalendario.findById(f.id).lean()).falha_desde).toBeUndefined();
  });

  test('a API da ligação traz falha_desde e proxima_leitura_em', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([]));
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await ler(f);
    const api = Servico.fonteParaApi(await FonteCalendario.findById(f.id).lean());
    expect(api.falha_desde).toBeInstanceOf(Date);
    expect(api.proxima_leitura_em).toBeInstanceOf(Date);
  });
});

describe('S4: filtro `ate` da lista por confirmar', () => {
  test('limita as chegadas até essa data; datas inválidas ou fora do intervalo são ignoradas', async () => {
    const c = await cenario();
    await ligar(c, urlBooking(), BOOKING([{ uid: 'b1', ci: 2, co: 4 }, { uid: 'b2', ci: 10, co: 12 }, { uid: 'b3', ci: 40, co: 42 }]));
    const lista = (ate) => Servico.listarReservasExternas({ escopo: c.escopoG, estado: 'por_confirmar', ate });
    expect((await lista(undefined)).body.total).toBe(3);
    expect((await lista(dia(5))).body.total).toBe(1);
    expect((await lista(dia(11))).body.total).toBe(2);
    expect((await lista('lixo')).body.total).toBe(3);
    expect((await lista(dia(-3))).body.total).toBe(3);
    expect((await lista(dia(400))).body.total).toBe(3);
  });
});

describe('S11: morada curta para distinguir casas com o mesmo nome', () => {
  test('o resumo traz «Rua, Cidade» (estruturada) ou o início da morada livre; null sem morada', async () => {
    const c = await cenario();
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada_estruturada: { rua: 'Rua do Ouro 10', codigo_postal: '1100-001', cidade: 'Lisboa' } } });
    let casas = donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c).casas;
    expect(casas[0].morada_curta).toBe('Rua do Ouro 10, Lisboa');
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada_estruturada: { rua: '' }, morada: 'Avenida da Liberdade 5, 3º Esq, 1250-001 Lisboa' } });
    casas = donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c).casas;
    expect(casas[0].morada_curta).toBe('Avenida da Liberdade 5, 3º Esq');
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada: '' } });
    casas = donoDe(await Integracoes.resumoIntegracoes({ empresaId: c.e._id }), c).casas;
    expect(casas[0].morada_curta).toBeNull();
  });
});

describe('S11/ronda 2: a lista por confirmar traz o id e a morada curta da casa', () => {
  test('propriedade._id e morada_curta no gestor', async () => {
    const c = await cenario();
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { morada_estruturada: { rua: 'Rua do Ouro 10', cidade: 'Lisboa' } } });
    await ligar(c, urlBooking(), BOOKING([{ uid: 'b1', ci: 2, co: 4 }]));
    const r = await Servico.listarReservasExternas({ escopo: c.escopoG, estado: 'por_confirmar' });
    expect(r.body.reservas_externas[0].propriedade).toMatchObject({ _id: String(c.casa._id), morada_curta: 'Rua do Ouro 10, Lisboa' });
  });
});
