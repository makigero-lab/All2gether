/**
 * Área «Integrações» (revisão do @UX e do @Tester, 2026-11-13): limite de testes, «link já usado» com o nome da casa,
 * mensagens de erro (passageiro / proprietário), «Aceitar» com resposta imediata, lote com tempo contado e um só aviso,
 * lista com total/paginação sem inativos, contagens coerentes, e acordo (interruptor desligado, aceitação idempotente
 * em corrida, retoma imediata). Rede mockada; base de dados em memória.
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
const { configurarChaves, calendario, PRODID_AIRBNB, PRODID_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario, SENHA } = H;
const app = require('../server');
const Servico = require('../utils/calendarioExterno/servico');
const Integracoes = require('../utils/calendarioExterno/integracoes');
const Limite = require('../utils/calendarioExterno/limiteTestes');
const Mensagens = require('../utils/calendarioExterno/mensagens');
const Sincronizar = require('../utils/calendarioExterno/sincronizar');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const AceitacaoAcordo = require('../models/AceitacaoAcordo');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Empresa = require('../models/Empresa');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');
const Notificacao = require('../models/Notificacao');

let mongod;
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const AIRBNB = (evs) => ({ 'www.airbnb.pt': { corpo: calendario(PRODID_AIRBNB, evs) } });
const BOOKING = (evs) => ({ 'ical.booking.com': { corpo: calendario(PRODID_BOOKING, evs.map((e) => ({ summary: 'CLOSED - Not available', ...e }))) } });
const usar = (estado) => { const t = criarTransporte(estado); global.__transporte = t; return t; };

async function cen() {
  const c = await cenario();
  c.tokG = await login(c.g); c.tokP = await login(c.dono); c.tokO = await login(c.outro);
  return c;
}
const casaExtra = (c, nome, x = {}) => Propriedade.create({ nome, empresa_id: c.e._id, origem: 'manual', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60, parceiro_id: c.dono._id, ...x });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), AceitacaoAcordo.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); delete process.env.ACORDO_RGPD_OBRIGATORIO; usar({}); });
afterEach(() => {
  for (const k of ['ACORDO_RGPD_OBRIGATORIO', 'ICAL_TESTES_POR_HORA', 'ICAL_TESTES_POR_HOST_HORA', 'ICAL_TESTES_POR_LINK_HORA', 'ICAL_MAX_NOVOS_LEITURA']) delete process.env[k];
});

describe('limite do «Testar ligação» (D4)', () => {
  test('por omissão deixa 60 por hora ao gestor e diz a que horas volta; links diferentes do mesmo site não travam o uso normal', () => {
    const agora = Date.UTC(2026, 10, 13, 10, 0, 0);
    for (let i = 0; i < 60; i += 1) expect(Limite.tentarTeste({ utilizadorId: 'u1', empresaId: 'e1', host: 'www.airbnb.pt', linkHash: `h${i}`, agora: agora + i * 1000 }).ok).toBe(true);
    const r = Limite.tentarTeste({ utilizadorId: 'u1', empresaId: 'e1', host: 'www.airbnb.pt', linkHash: 'h-novo', agora: agora + 61000 });
    expect(r).toMatchObject({ ok: false, motivo: 'utilizador' });
    expect(r.mensagem).toMatch(/^Testaste muitas vezes\. Podes voltar a testar às \d{2}:\d{2}\.$/);
    expect(r.ate.getTime()).toBe(agora + 3600000);
    // passada a hora, volta a poder
    expect(Limite.tentarTeste({ utilizadorId: 'u1', empresaId: 'e1', host: 'www.airbnb.pt', linkHash: 'h-novo', agora: agora + 3600001 }).ok).toBe(true);
    // outro utilizador não é afetado pelo primeiro
    expect(Limite.tentarTeste({ utilizadorId: 'u2', empresaId: 'e1', host: 'ical.booking.com', linkHash: 'x', agora }).ok).toBe(true);
  });

  test('o mesmo link só pode ser testado 15 vezes por hora e o mesmo site por empresa 150; uma recusa não gasta quota', () => {
    Limite.limparLimiteTestes();
    const agora = Date.now();
    for (let i = 0; i < 15; i += 1) expect(Limite.tentarTeste({ utilizadorId: `u${i}`, empresaId: 'e1', host: 'a.pt', linkHash: 'mesmo', agora }).ok).toBe(true);
    expect(Limite.tentarTeste({ utilizadorId: 'u99', empresaId: 'e1', host: 'a.pt', linkHash: 'mesmo', agora })).toMatchObject({ ok: false, motivo: 'link' });
    // site: 150 por empresa
    Limite.limparLimiteTestes();
    for (let i = 0; i < 150; i += 1) expect(Limite.tentarTeste({ utilizadorId: `v${i}`, empresaId: 'e1', host: 'a.pt', linkHash: `l${i}`, agora }).ok).toBe(true);
    expect(Limite.tentarTeste({ utilizadorId: 'v-novo', empresaId: 'e1', host: 'a.pt', linkHash: 'lx', agora })).toMatchObject({ ok: false, motivo: 'host' });
    expect(Limite.tentarTeste({ utilizadorId: 'v-novo', empresaId: 'e2', host: 'a.pt', linkHash: 'lx', agora }).ok).toBe(true); // outra empresa
    // limites configuráveis
    Limite.limparLimiteTestes();
    const env = { ICAL_TESTES_POR_HORA: '5' };
    for (let i = 0; i < 5; i += 1) expect(Limite.tentarTeste({ utilizadorId: 'c', empresaId: 'e', host: 'h', linkHash: `k${i}`, agora, env }).ok).toBe(true);
    expect(Limite.tentarTeste({ utilizadorId: 'c', empresaId: 'e', host: 'h', linkHash: 'k9', agora, env }).ok).toBe(false);
  });

  test('só o teste que chega à rede gasta quota: links inválidos e «já usado» não contam', async () => {
    const c = await cen();
    process.env.ICAL_TESTES_POR_HORA = '5';
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const corpo = (url) => ({ propriedade_id: String(c.casa._id), url });
    for (let i = 0; i < 8; i += 1) expect((await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send(corpo('isto não é um link'))).status).toBe(400);
    const usado = urlAirbnb();
    const outraCasa = await casaExtra(c, 'Outra casa');
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(outraCasa._id), url: usado });
    for (let i = 0; i < 8; i += 1) expect((await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send(corpo(usado))).status).toBe(409);
    for (let i = 0; i < 5; i += 1) expect((await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send(corpo(urlAirbnb()))).status).toBe(200);
    const r = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send(corpo(urlAirbnb()));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ codigo: 'LIMITE_TESTES', motivo: 'utilizador' });
  });
});

describe('link já usado (D7)', () => {
  test('diz a casa e o proprietário se for da mesma empresa; nunca revela nada de outra empresa', async () => {
    const c = await cen();
    const alheia = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const url = urlAirbnb();
    expect((await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url })).status).toBe(201);
    const casa2 = await casaExtra(c, 'Casa do Farol', { parceiro_id: c.outro._id });
    const t = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send({ propriedade_id: String(casa2._id), url });
    expect(t.status).toBe(409);
    expect(t.body.codigo).toBe('LINK_USADO');
    expect(t.body.erro).toContain(c.casa.nome);
    expect(t.body.erro).toContain('de Dono');
    expect(t.body.erro).toContain(`usado na casa ${c.casa.nome}`);
    expect(t.body.erro).not.toMatch(/\bem a\b/);
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(casa2._id), url });
    expect(cr.status).toBe(409);
    expect(cr.body.erro).toContain(c.casa.nome);
    // gestor de OUTRA empresa tenta o mesmo link: não aprende nada
    const o = await request(app).post('/api/gestor/calendarios/testar').set(auth(alheia.tokG)).send({ propriedade_id: String(alheia.casa._id), url });
    expect(o.status).toBe(409);
    expect(JSON.stringify(o.body)).not.toContain(c.casa.nome);
    expect(JSON.stringify(o.body)).not.toContain('Dono');
    expect(o.body.casa).toBeUndefined();
  });
});

describe('mensagens de erro (D5/D6, M3)', () => {
  test('erro passageiro diz «Problema temporário no Airbnb; voltamos a tentar sozinhos» e vem marcado como temporário', () => {
    expect(Mensagens.mensagemErro('http_5xx', { canal: 'Airbnb' })).toBe('Problema temporário no Airbnb; voltamos a tentar sozinhos.');
    expect(Mensagens.mensagemErro('timeout', { canal: 'Booking.com' })).toBe('Problema temporário no Booking.com; voltamos a tentar sozinhos.');
    expect(Mensagens.eErroTemporario('http_5xx')).toBe(true);
    expect(Mensagens.eErroTemporario('http_404_410')).toBe(false);
  });

  test('o proprietário lê um texto que pode cumprir; o gestor vê «temporario» e o contacto da empresa chega ao proprietário', async () => {
    const c = await cen();
    await Empresa.updateOne({ _id: c.e._id }, { telefone: '910000000', email: 'geral@empresa.pt' });
    usar(BOOKING([{ uid: 'b1', ci: 10, co: 13 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    await FonteCalendario.updateOne({ _id: cr.body.fonte._id }, { estado: 'erro', ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
    const p = (await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP))).body;
    expect(p.fontes[0].ultimo_erro.mensagem).toBe('O link deixou de funcionar. Gera um link novo no Booking.com e envia-o à All2gether.');
    expect(p.fontes[0].ultimo_erro.mensagem).not.toMatch(/substitui/);
    expect(p.contacto).toMatchObject({ telefone: '910000000', email: 'geral@empresa.pt' });
    const g = (await request(app).get('/api/gestor/calendarios').set(auth(c.tokG))).body;
    expect(g.fontes[0].ultimo_erro.mensagem).toMatch(/Copia o link novo/);
    expect(g.contacto).toBeUndefined();
    await FonteCalendario.updateOne({ _id: cr.body.fonte._id }, { ultimo_erro: { em: new Date(), codigo: 'http_5xx' } });
    const r = (await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG))).body;
    expect(r.proprietarios[0].primeiro_erro).toMatchObject({ temporario: true, mensagem: 'Problema temporário no Booking.com; voltamos a tentar sozinhos.' });
    expect(r.proprietarios[0].erros).toHaveLength(1);
    expect(r.proprietarios[0].erros[0]).toMatchObject({ fonte_id: String(cr.body.fonte._id), temporario: true });
  });
});

describe('«Aceitar» com resposta imediata (D9, M4)', () => {
  test('aceitar_calendario lê já o calendário e cria as limpezas, sem esperar pela próxima leitura', async () => {
    process.env.ICAL_MAX_NOVOS_LEITURA = '5';
    const c = await cen();
    const evs = Array.from({ length: 8 }, (_, i) => ({ uid: `n${i}`, ci: 5 + i * 3, co: 7 + i * 3 }));
    usar(AIRBNB(evs));
    const r = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(r.status).toBe(201);
    expect(r.body.fonte.em_validacao).toBe(true);
    expect(r.body.fonte.aviso_validacao).toMatch(/8 reservas novas de uma vez/);
    expect(await Tarefa.countDocuments({ propriedade_id: c.casa._id, tipo: 'limpeza' })).toBe(0);
    const a = await request(app).patch(`/api/gestor/calendarios/${r.body.fonte._id}/estado`).set(auth(c.tokG)).send({ acao: 'aceitar_calendario' });
    expect(a.status).toBe(200);
    expect(a.body.leitura).toMatchObject({ resultado: 'ok' });
    expect(a.body.leitura.alteracoes.criadas).toBe(8);
    expect(a.body.fonte.em_validacao).toBe(false);
    expect(await Tarefa.countDocuments({ propriedade_id: c.casa._id, tipo: 'limpeza' })).toBe(8);
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokG))).body.erros).toBe(0);
  });
});

describe('lote (D8, M2)', () => {
  async function comPendentes(c, n) {
    usar(BOOKING(Array.from({ length: n }, (_, i) => ({ uid: `b${i}`, ci: 20 + i * 4, co: 22 + i * 4 }))));
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    return (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar').set(auth(c.tokG))).body;
  }

  test('pára ao fim do tempo contado e devolve os ids por tratar; o proprietário recebe UM aviso por lote', async () => {
    const c = await cen();
    const lista = await comPendentes(c, 5);
    const ids = lista.reservas_externas.map((x) => x._id);
    let t = 0;
    const relogio = () => { t += 1000; return t; }; // cada chamada «gasta» 1 s
    const r = await Integracoes.decidirLote({ ids, acao: 'confirmar', empresaId: c.e._id, ator: c.atorG, orcamentoMs: 2500, relogio });
    expect(r.status).toBe(200);
    expect(r.body.incompleto).toBe(true);
    expect(r.body.ok + r.body.nao_tratados.length).toBe(5);
    expect(r.body.ok).toBeGreaterThan(0);
    expect(r.body.nao_tratados.length).toBeGreaterThan(0);
    expect(await ReservaExterna.countDocuments({ empresa_id: c.e._id, estado: 'por_confirmar' })).toBe(r.body.nao_tratados.length);
    const avisos = await Notificacao.countDocuments({ utilizador_id: c.dono._id, mensagem: /confirmou \d+ reservas? tuas?/ });
    expect(avisos).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: c.dono._id, mensagem: /A All2gether criou uma reserva/ })).toBe(0);
    // o resto numa segunda ronda, sem limite apertado
    const r2 = await Integracoes.decidirLote({ ids: r.body.nao_tratados, acao: 'confirmar', empresaId: c.e._id, ator: c.atorG });
    expect(r2.body).toMatchObject({ ok: r.body.nao_tratados.length, falhas: 0, incompleto: false, nao_tratados: [] });
    expect(await Tarefa.countDocuments({ propriedade_id: c.casa._id, tipo: 'limpeza' })).toBe(5);
  });

  test('a lista diz o total e pagina; casas e proprietários inativos não aparecem (nem contam) por defeito', async () => {
    const c = await cen();
    const lista = await comPendentes(c, 6);
    expect(lista).toMatchObject({ total: 6, limite: 500, desde: 0, mostrando: 6 });
    const pag = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar&pular=4').set(auth(c.tokG))).body;
    expect(pag).toMatchObject({ total: 6, desde: 4, mostrando: 2 });
    const prox = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar&proximos_dias=30').set(auth(c.tokG))).body;
    expect(prox.total).toBeLessThan(6);
    expect(prox.total).toBeGreaterThan(0);
  });

  test('selo, separador e lista contam o mesmo, com a mesma regra para casas e proprietários inativos', async () => {
    const c = await cen();
    // casa ativa do Dono com 3 por confirmar e 1 erro; casa INATIVA do Dono com erro e pendentes; Outro (inativo) com pendentes
    usar({ ...BOOKING([{ uid: 'b1', ci: 20, co: 22 }, { uid: 'b2', ci: 30, co: 32 }, { uid: 'b3', ci: 40, co: 42 }]), ...AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]) });
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    await FonteCalendario.updateOne({ _id: cr.body.fonte._id }, { estado: 'erro', ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
    const inativa = await casaExtra(c, 'Casa inativa');
    const f2 = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(inativa._id), url: urlBooking() });
    expect(f2.status).toBe(201);
    await FonteCalendario.updateOne({ _id: f2.body.fonte._id }, { estado: 'erro', ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
    await Propriedade.updateOne({ _id: inativa._id }, { ativo: false });
    const doOutro = await Propriedade.create({ nome: 'Casa do Outro', empresa_id: c.e._id, origem: 'manual', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60, parceiro_id: c.outro._id });
    const f3 = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(doOutro._id), url: urlBooking() });
    expect(f3.status).toBe(201);
    await FonteCalendario.updateOne({ _id: f3.body.fonte._id }, { estado: 'erro', ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
    await Utilizador.updateOne({ _id: c.outro._id }, { ativo: false });

    const resumo = (await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG))).body;
    const contagem = (await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokG))).body;
    const lista = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar').set(auth(c.tokG))).body;
    expect(resumo.totais.erros).toBe(1);
    expect(contagem.erros).toBe(1);
    expect(resumo.totais.por_confirmar).toBe(3);
    expect(lista.total).toBe(3);
    expect(lista.reservas_externas).toHaveLength(3);
    // inativos só a pedido, e confirmá-los não é oferecido por defeito (daria 409)
    const todos = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar&inativos=1').set(auth(c.tokG))).body;
    expect(todos.total).toBe(9);
    // o assistente sabe porque não há casas para ligar
    const dono = resumo.proprietarios.find((p) => p._id === String(c.dono._id));
    expect(dono.n_casas_inativas).toBe(1);
  });
});

describe('acordo (M5, M6, L2)', () => {
  test('com o interruptor DESLIGADO o portal não traz o texto-modelo e o endpoint recusa (409), sem registar nada', async () => {
    const c = await cen();
    const ver = await request(app).get('/api/parceiro/acordo-dados').set(auth(c.tokP));
    expect(ver.body).toMatchObject({ obrigatorio: false, texto: null, hash: null, aceite: false });
    const r = await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: 'PROP-DPA-1.0', hash: 'x'.repeat(64), confirmo: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ erro: 'O acordo ainda não está em vigor.', codigo: 'ACORDO_NAO_EM_VIGOR' });
    expect(await AceitacaoAcordo.countDocuments({ parceiro_id: c.dono._id })).toBe(0);
  });

  test('LIGADO: aceitações em corrida gravam um só registo (os restantes recebem 200) e o índice único impede o duplicado', async () => {
    process.env.ACORDO_RGPD_OBRIGATORIO = 'true';
    const c = await cen();
    const ver = (await request(app).get('/api/parceiro/acordo-dados').set(auth(c.tokP))).body;
    const corpo = { versao: ver.versao, hash: ver.hash, confirmo: true };
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send(corpo)));
    const estados = rs.map((r) => r.status).sort();
    expect(estados.filter((s) => s === 201)).toHaveLength(1);
    expect(estados.filter((s) => s === 200)).toHaveLength(4);
    expect(await AceitacaoAcordo.countDocuments({ parceiro_id: c.dono._id })).toBe(1);
    await expect(AceitacaoAcordo.create({ empresa_id: c.e._id, parceiro_id: c.dono._id, aceite_por_id: c.dono._id, versao: ver.versao, hash_texto: ver.hash })).rejects.toMatchObject({ code: 11000 });
    // um registo revogado fica como prova e não impede uma nova aceitação
    await AceitacaoAcordo.updateOne({ parceiro_id: c.dono._id }, { revogado_em: new Date() });
    expect((await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send(corpo)).status).toBe(201);
  });

  test('ao aceitar, as ligações em pausa por causa do acordo retomam logo (sem esperar pelo job)', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    process.env.ACORDO_RGPD_OBRIGATORIO = 'true';
    expect(await Sincronizar.sincronizarFonte(cr.body.fonte._id)).toMatchObject({ resultado: 'pausada', motivo: 'acordo_por_aceitar' });
    expect(await FonteCalendario.findById(cr.body.fonte._id).lean()).toMatchObject({ estado: 'pausada', motivo_estado: 'acordo_por_aceitar' });
    const antes = (await FonteCalendario.findById(cr.body.fonte._id).lean()).ultima_leitura_em;
    const ver = (await request(app).get('/api/parceiro/acordo-dados').set(auth(c.tokP))).body;
    const ok = await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: ver.versao, hash: ver.hash, confirmo: true });
    expect(ok.status).toBe(201);
    const depois = await FonteCalendario.findById(cr.body.fonte._id).lean();
    expect(depois).toMatchObject({ estado: 'ativa', motivo_estado: null });
    expect(new Date(depois.ultima_leitura_em).getTime()).toBeGreaterThan(antes ? new Date(antes).getTime() : 0);
    const g = (await request(app).get('/api/gestor/calendarios').set(auth(c.tokG))).body.fontes[0];
    expect(g.estado).toBe('ativa');
  });
});

describe('por confirmar com a fonte em erro ou pausada (N3)', () => {
  test('o proprietário continua a ver e a poder responder aos períodos por confirmar', async () => {
    const c = await cen();
    usar(BOOKING([{ uid: 'b1', ci: 10, co: 13 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    for (const estado of ['erro', 'pausada']) {
      await FonteCalendario.updateOne({ _id: cr.body.fonte._id }, { estado, ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
      const p = (await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP))).body;
      expect(p.fontes[0]).toMatchObject({ estado, n_por_confirmar: 1 });
      const l = (await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar').set(auth(c.tokP))).body;
      expect(l.reservas_externas).toHaveLength(1);
    }
  });
});
