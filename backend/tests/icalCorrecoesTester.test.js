/**
 * Calendários externos (iCal): correções dos achados do @Tester (2026-11-13).
 * M1 promoção da duplicada · M2 feed vazio (24 h) e aviso das 48 h · B1 reserva nova nas datas de uma cancelada ·
 * B3 unicidade do link · B5 tetos (bytes e reservas novas por leitura) · B6 hóspedes/nome.
 * Rede mockada (transporte falso); base de dados em memória.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const H = require('./helpersIcal');
const { configurarChaves, dia, calendario, PRODID_AIRBNB, PRODID_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario } = H;
const Servico = require('../utils/calendarioExterno/servico');
const { sincronizarFonte, registarLeitura } = require('../utils/calendarioExterno/sincronizar');
const Decisoes = require('../utils/calendarioExterno/decisoes');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const ReservaManual = require('../models/ReservaManual');
const LeituraCalendario = require('../models/LeituraCalendario');
const Tarefa = require('../models/Tarefa');
const Notificacao = require('../models/Notificacao');
const R = require('../utils/reservasParceiro');

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
const noticias = (u, re) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: re });
const limpezas = (c) => Tarefa.find({ propriedade_id: c.casa._id, tipo: 'limpeza', estado: { $ne: 'cancelada' } }).lean();
const limpezasDoDia = async (c, d) => (await limpezas(c)).filter((t) => t.data.toISOString().slice(0, 10) === dia(d));
const ex = (c, uid) => ReservaExterna.findOne({ propriedade_id: c.casa._id, uid });

async function ligar(c, urlBase, estado) {
  const t = criarTransporte(estado);
  const r = await Servico.criarLigacao({ propriedadeId: c.casa._id, url: urlBase, escopo: c.escopoP, ator: c.ator, transporte: t });
  expect(r.status).toBe(201);
  return { id: r.body.fonte._id, t, estado, resp: r.body };
}
const ler = (f, opcoes = {}) => sincronizarFonte(f.id, { transporte: f.t, ...opcoes });
const mudar = (f, host, evs, tipo = 'airbnb') => { f.estado[host] = (tipo === 'airbnb' ? AIRBNB(evs) : BOOKING(evs))[host]; };
const confirmar = async (c, uid) => {
  const e = await ex(c, uid);
  const r = await Decisoes.confirmarExterna({ externaId: e._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator });
  expect(r.status).toBe(200);
};

const BK = [{ uid: 'b', ci: 20, co: 23 }, { uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 50, co: 52 }];

/** Booking confirmada pelo proprietário + Airbnb «Reserved» da mesma estadia (fica duplicada). */
async function bookingEAirbnb(c, evAirbnb = { uid: 'a', ci: 20, co: 23 }) {
  const fb = await ligar(c, urlBooking(), BOOKING(BK));
  await confirmar(c, 'b');
  const fa = await ligar(c, urlAirbnb(), AIRBNB([evAirbnb]));
  expect((await ex(c, 'a')).estado).toBe('duplicada');
  return { fb, fa };
}

describe('M1: a duplicada viva é promovida quando a principal desaparece', () => {
  test('Booking confirmada some, Airbnb continua: a MESMA limpeza passa para o Airbnb (sem cancelar e recriar)', async () => {
    const c = await cenario();
    const { fb } = await bookingEAirbnb(c);
    const antes = (await limpezasDoDia(c, 23));
    expect(antes).toHaveLength(1);
    const reservaId = (await ex(c, 'b')).reserva_manual_id;
    mudar(fb, 'ical.booking.com', BK.slice(1), 'booking');
    for (let i = 0; i < 3; i++) await ler(fb);
    const b = await ex(c, 'b'); const a = await ex(c, 'a');
    expect(b.estado).toBe('cancelada');
    expect(a.estado).toBe('confirmada');
    expect(String(a.reserva_manual_id)).toBe(String(reservaId));
    const depois = await limpezasDoDia(c, 23);
    expect(depois).toHaveLength(1);
    expect(String(depois[0]._id)).toBe(String(antes[0]._id)); // transferida, não recriada
    const reserva = await ReservaManual.findById(reservaId).lean();
    expect(reserva.cancelada_em).toBeFalsy();
    expect(String(reserva.reserva_externa_id)).toBe(String(a._id));
    expect(reserva.plataforma).toBe('Airbnb');
    expect(await noticias(c.dono, /a limpeza foi mantida/)).toBeGreaterThanOrEqual(1);
  });

  test('a promovida passa a ser a principal: se agora o Airbnb também desaparecer, a limpeza cancela-se', async () => {
    const c = await cenario();
    const { fb, fa } = await bookingEAirbnb(c);
    mudar(fb, 'ical.booking.com', BK.slice(1), 'booking');
    for (let i = 0; i < 3; i++) await ler(fb);
    mudar(fa, 'www.airbnb.pt', [{ uid: 'a2', ci: 70, co: 72 }, { uid: 'a3', ci: 80, co: 82 }]);
    for (let i = 0; i < 3; i++) await ler(fa);
    expect((await ex(c, 'a')).estado).toBe('cancelada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(0);
  });

  test('a duplicada com outro dia de entrada (mesma saída): a reserva ajusta as datas e a limpeza mantém-se', async () => {
    const c = await cenario();
    const { fb } = await bookingEAirbnb(c, { uid: 'a', ci: 21, co: 23 });
    mudar(fb, 'ical.booking.com', BK.slice(1), 'booking');
    for (let i = 0; i < 3; i++) await ler(fb);
    const a = await ex(c, 'a');
    expect(a.estado).toBe('confirmada');
    const reserva = await ReservaManual.findById(a.reserva_manual_id).lean();
    expect(reserva.check_in.toISOString().slice(0, 10)).toBe(dia(21));
    expect(await limpezasDoDia(c, 23)).toHaveLength(1);
  });

  test('as duas desaparecem (a duplicada já estava a faltar): cancela-se a limpeza e nada é promovido', async () => {
    const c = await cenario();
    const { fb, fa } = await bookingEAirbnb(c);
    mudar(fa, 'www.airbnb.pt', [{ uid: 'a2', ci: 70, co: 72 }, { uid: 'a3', ci: 80, co: 82 }]);
    await ler(fa); // a duplicada passa a faltar (1 leitura)
    mudar(fb, 'ical.booking.com', BK.slice(1), 'booking');
    for (let i = 0; i < 3; i++) await ler(fb);
    expect((await ex(c, 'b')).estado).toBe('cancelada');
    expect((await ex(c, 'a')).estado).toBe('duplicada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(0);
    // e a duplicada acaba por cancelar-se também
    for (let i = 0; i < 3; i++) await ler(fa);
    expect((await ex(c, 'a')).estado).toBe('cancelada');
  });

  test('principal Airbnb some e a copia é um período incerto do Booking: cancela-se a limpeza e pergunta-se ao proprietário', async () => {
    const c = await cenario();
    const A = [{ uid: 'a', ci: 20, co: 23 }, { uid: 'a2', ci: 40, co: 42 }, { uid: 'a3', ci: 50, co: 52 }];
    const fa = await ligar(c, urlAirbnb(), AIRBNB(A));
    await ligar(c, urlBooking(), BOOKING([{ uid: 'b', ci: 20, co: 23 }]));
    expect((await ex(c, 'b')).estado).toBe('duplicada');
    mudar(fa, 'www.airbnb.pt', A.slice(1));
    for (let i = 0; i < 3; i++) await ler(fa);
    expect((await ex(c, 'a')).estado).toBe('cancelada');
    expect((await ex(c, 'b')).estado).toBe('por_confirmar');
    expect(await limpezasDoDia(c, 23)).toHaveLength(0);
  });

  test('remover a ligação da principal: a duplicada viva herda a limpeza e o impacto não a conta', async () => {
    const c = await cenario();
    const { fb } = await bookingEAirbnb(c);
    const fonte = await FonteCalendario.findById(fb.id);
    const impacto = await Decisoes.contarImpactoRemocao(fonte);
    expect(impacto.limpezas).toBe(0); // as outras do Booking (b2, b3) estão por confirmar
    await Decisoes.removerFonte(fonte, { silencioso: true });
    const a = await ex(c, 'a');
    expect(a.estado).toBe('confirmada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(1);
  });

  test('a duplicada que desaparece e volta, enquanto a principal continua, não volta a perguntar nada', async () => {
    const c = await cenario();
    const A = [{ uid: 'a', ci: 20, co: 23 }, { uid: 'a2', ci: 40, co: 42 }, { uid: 'a3', ci: 50, co: 52 }];
    await ligar(c, urlBooking(), BOOKING(BK));
    await confirmar(c, 'b');
    const fa = await ligar(c, urlAirbnb(), AIRBNB(A));
    expect((await ex(c, 'a')).estado).toBe('duplicada');
    mudar(fa, 'www.airbnb.pt', A.slice(1));
    for (let i = 0; i < 3; i++) await ler(fa);
    expect((await ex(c, 'a')).estado).toBe('cancelada');
    mudar(fa, 'www.airbnb.pt', A);
    await ler(fa);
    expect((await ex(c, 'a')).estado).toBe('duplicada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(1);
  });
});

describe('M2: calendário vazio só cancela depois de 24 h seguidas', () => {
  const t0 = () => Date.now() + 3600000;

  test('1 só reserva futura e feed vazio: 3 leituras e 2 h não bastam; às 24 h cancela', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'solo', ci: 20, co: 23 }]));
    mudar(f, 'www.airbnb.pt', []);
    const base = t0();
    for (const min of [0, 30, 60, 90, 150, 600]) await ler(f, { agora: new Date(base + min * 60000) });
    expect((await ex(c, 'solo')).estado).toBe('confirmada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(1);
    await ler(f, { agora: new Date(base + 23 * 3600000) });
    expect((await ex(c, 'solo')).estado).toBe('confirmada');
    await ler(f, { agora: new Date(base + 24 * 3600000 + 60000) });
    expect((await ex(c, 'solo')).estado).toBe('cancelada');
    expect(await limpezasDoDia(c, 23)).toHaveLength(0);
  });

  test('as horas são configuráveis (ICAL_HORAS_FEED_VAZIO)', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'solo', ci: 20, co: 23 }]));
    mudar(f, 'www.airbnb.pt', []);
    const env = { ...process.env, ICAL_HORAS_FEED_VAZIO: '5' };
    const base = t0();
    for (const min of [0, 30, 60, 200]) await ler(f, { env, agora: new Date(base + min * 60000) });
    expect((await ex(c, 'solo')).estado).toBe('confirmada');
    await ler(f, { env, agora: new Date(base + 301 * 60000) });
    expect((await ex(c, 'solo')).estado).toBe('cancelada');
  });

  test('um evento a voltar a meio recomeça a contagem das 24 h', async () => {
    const c = await cenario();
    const A = [{ uid: 'solo', ci: 20, co: 23 }];
    const f = await ligar(c, urlAirbnb(), AIRBNB(A));
    const base = t0();
    mudar(f, 'www.airbnb.pt', []);
    await ler(f, { agora: new Date(base) });
    mudar(f, 'www.airbnb.pt', A);
    await ler(f, { agora: new Date(base + 20 * 3600000) });
    expect((await FonteCalendario.findById(f.id)).vazio_desde).toBeFalsy();
    mudar(f, 'www.airbnb.pt', []);
    for (const h of [21, 22, 23, 30]) await ler(f, { agora: new Date(base + h * 3600000) });
    expect((await ex(c, 'solo')).estado).toBe('confirmada'); // só 9 h desde o novo vazio
  });

  test('limpeza nas próximas 48 h: avisa logo o gestor e o proprietário (uma vez) e não cancela', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'perto', ci: -1, co: 1 }]));
    expect(await limpezasDoDia(c, 1)).toHaveLength(1);
    mudar(f, 'www.airbnb.pt', []);
    await ler(f);
    expect(await noticias(c.dono, /ficou vazio e há/)).toBe(1);
    expect(await noticias(c.g, /ficou vazio e há/)).toBe(1);
    await ler(f); await ler(f);
    expect(await noticias(c.dono, /ficou vazio e há/)).toBe(1);
    expect((await ex(c, 'perto')).estado).toBe('confirmada');
  });

  test('limpeza longe (20 dias) não gera o aviso das 48 h', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'longe', ci: 18, co: 20 }]));
    mudar(f, 'www.airbnb.pt', []);
    await ler(f);
    expect(await noticias(c.dono, /ficou vazio e há/)).toBe(0);
  });
});

describe('B1: reserva nova nas datas de uma cancelada', () => {
  const base = [{ uid: 'k1', ci: 40, co: 42 }, { uid: 'k2', ci: 50, co: 52 }, { uid: 'k3', ci: 60, co: 62 }, { uid: 'k4', ci: 70, co: 72 }];

  test('com UID novo ganha a limpeza na MESMA leitura (não herda «cancelada»)', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'a', ci: 20, co: 23 }, ...base]));
    mudar(f, 'www.airbnb.pt', base);
    for (let i = 0; i < 3; i++) await ler(f);
    expect((await ex(c, 'a')).estado).toBe('cancelada');
    expect(await limpezas(c)).toHaveLength(4);
    mudar(f, 'www.airbnb.pt', [{ uid: 'novo-hospede', ci: 20, co: 23 }, ...base]);
    await ler(f);
    expect((await ex(c, 'novo-hospede')).estado).toBe('confirmada');
    expect(await limpezas(c)).toHaveLength(5);
  });

  test('um bloqueio já decidido pelo proprietário continua a valer com o UID novo', async () => {
    const c = await cenario();
    const f = await ligar(c, urlBooking(), BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 60, co: 62 }]));
    const e1 = await ex(c, 'b1');
    expect((await Decisoes.marcarBloqueio({ externaId: e1._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator })).status).toBe(200);
    mudar(f, 'ical.booking.com', [{ uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 60, co: 62 }], 'booking');
    for (let i = 0; i < 3; i++) await ler(f);
    expect((await ex(c, 'b1')).estado).toBe('cancelada');
    mudar(f, 'ical.booking.com', [{ uid: 'b1-novo', ci: 20, co: 23 }, { uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 60, co: 62 }], 'booking');
    await ler(f);
    expect((await ex(c, 'b1-novo')).estado).toBe('bloqueio');
    expect(await limpezasDoDia(c, 23)).toHaveLength(0);
  });
});

describe('B3: o mesmo link com parâmetros extra conta como o mesmo link', () => {
  test('?s=X&x=1 do Airbnb e o mesmo link noutro domínio regional são recusados como repetidos', async () => {
    const c = await cenario();
    const url = urlAirbnb();
    await ligar(c, url, AIRBNB([{ uid: 'a', ci: 20, co: 23 }]));
    const t = criarTransporte({ 'www.airbnb.pt': AIRBNB([])['www.airbnb.pt'], 'www.airbnb.com': AIRBNB([])['www.airbnb.pt'] });
    const outro = { empresaId: c.e._id, parceiroId: c.outro._id };
    for (const variante of [`${url}&x=1`, `${url}&utm=a&z=2`, url.replace('www.airbnb.pt', 'airbnb.com'), url.replace('www.airbnb.pt', 'WWW.AIRBNB.PT')]) {
      const r = await Servico.criarLigacao({ propriedadeId: c.alheia._id, url: variante, escopo: outro, ator: { tipo: 'parceiro', id: c.outro._id, nome: 'Outro' }, transporte: t });
      expect(r.status).toBe(409);
      expect(r.body.codigo).toBe('LINK_REPETIDO');
    }
  });

  test('Booking: parâmetros extra também não contornam', async () => {
    const c = await cenario();
    const url = urlBooking();
    await ligar(c, url, BOOKING(BK));
    const t = criarTransporte(BOOKING(BK));
    const outro = { empresaId: c.e._id, parceiroId: c.outro._id };
    const r = await Servico.criarLigacao({ propriedadeId: c.alheia._id, url: `${url}&extra=1`, escopo: outro, ator: { tipo: 'parceiro', id: c.outro._id, nome: 'Outro' }, transporte: t });
    expect(r.status).toBe(409);
  });
});

describe('B5: tetos do registo de leituras e das reservas novas por leitura', () => {
  test('teto em bytes por fonte: as leituras mais antigas saem, a mais recente fica', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'a', ci: 20, co: 23 }]));
    const fonte = await FonteCalendario.findById(f.id);
    await LeituraCalendario.deleteMany({ fonte_id: fonte._id });
    const eventos = Array.from({ length: 300 }, (_, i) => ({ uid: `u${i}-${'x'.repeat(40)}`, ci: dia(10), co: dia(12), classe: 'reserva' }));
    for (let i = 0; i < 10; i++) {
      await registarLeitura({ tetoBytes: 50 * 1024, fonte, origem: 'agendada', iniciada: new Date(Date.now() + i * 1000), duracao: 5, resultado: 'ok', http_status: 200, n_eventos: 300, n_futuros: 300, hash: `h${i}`, eventos });
    }
    const docs = await LeituraCalendario.find({ fonte_id: fonte._id }).sort({ iniciada_em: -1 }).lean();
    expect(docs.length).toBeLessThan(10);
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].hash_normalizado).toBe('h9');
    expect(docs.reduce((s, d) => s + d.bytes, 0)).toBeLessThanOrEqual(50 * 1024 + docs[0].bytes);
  });

  test('reservas novas a mais numa só leitura: leitura anómala, nada é criado, o gestor é avisado; aceitar deixa criar', async () => {
    const c = await cenario();
    const f = await ligar(c, urlAirbnb(), AIRBNB([{ uid: 'p1', ci: 20, co: 22 }, { uid: 'p2', ci: 30, co: 32 }]));
    expect(await limpezas(c)).toHaveLength(2);
    const muitos = Array.from({ length: 10 }, (_, i) => ({ uid: `n${i}`, ci: 40 + i * 3, co: 42 + i * 3 }));
    mudar(f, 'www.airbnb.pt', [{ uid: 'p1', ci: 20, co: 22 }, { uid: 'p2', ci: 30, co: 32 }, ...muitos]);
    const env = { ...process.env, ICAL_MAX_NOVOS_LEITURA: '5' };
    const r = await ler(f, { env });
    expect(r.resultado).toBe('suspeita');
    expect(r.motivos).toContain('muitos_novos');
    expect(await limpezas(c)).toHaveLength(2);
    expect(await ReservaExterna.countDocuments({ propriedade_id: c.casa._id })).toBe(2);
    expect(await noticias(c.g, /reservas novas de uma só vez/)).toBe(1);
    await ler(f, { env });
    expect(await noticias(c.g, /reservas novas de uma só vez/)).toBe(1); // aviso único
    const ac = await Servico.mudarEstado({ id: f.id, acao: 'aceitar_calendario', escopo: c.escopoG });
    expect(ac.status).toBe(200);
    const r2 = await ler(f, { env });
    expect(r2.resultado).not.toBe('suspeita');
    expect(await limpezas(c)).toHaveLength(12);
  });

  test('o limite por leitura é configurável e abaixo dele tudo corre como antes', async () => {
    const c = await cenario();
    const evs = Array.from({ length: 8 }, (_, i) => ({ uid: `m${i}`, ci: 20 + i * 3, co: 22 + i * 3 }));
    const f = await ligar(c, urlAirbnb(), AIRBNB(evs));
    expect(f.resp.leitura.alteracoes.criadas).toBe(8);
  });
});

describe('B6: hóspedes e nome validados (calendários e reservas manuais)', () => {
  test('confirmar recusa hóspedes absurdos e nomes compridos, e aceita valores normais', async () => {
    const c = await cenario();
    await ligar(c, urlBooking(), BOOKING(BK));
    const e1 = await ex(c, 'b');
    const args = (dados) => ({ externaId: e1._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator, dados });
    for (const dados of [{ hospedes: 99999 }, { hospedes: -1 }, { hospedes: 2.5 }, { hospedes: 'abc' }, { hospedes: { $gt: 0 } }, { nome_hospede: 'x'.repeat(1250) }, { nome_hospede: { $ne: '' } }]) {
      const r = await Decisoes.confirmarExterna(args(dados));
      expect(r.status).toBe(400);
    }
    expect((await ex(c, 'b')).estado).toBe('por_confirmar'); // as recusas não deixam o período meio tratado
    const ok = await Decisoes.confirmarExterna(args({ hospedes: 6, nome_hospede: 'Ana Silva' }));
    expect(ok.status).toBe(200);
  });

  test('a reserva manual aplica os mesmos limites', async () => {
    const c = await cenario();
    const corpo = (extra) => ({ propriedade_id: String(c.casa._id), check_in: dia(30), check_out: dia(33), ...extra });
    const tenta = (extra) => R.criarReservaComLimpeza({ parceiroId: c.dono._id, empresaId: c.e._id, ator: { tipo: 'parceiro' }, body: corpo(extra) });
    expect((await tenta({ hospedes: 99999 })).status).toBe(400);
    expect((await tenta({ nome_hospede: 'y'.repeat(500) })).status).toBe(400);
    expect((await tenta({ hospedes: 50, nome_hospede: 'Rui' })).status).toBe(201);
  });
});
