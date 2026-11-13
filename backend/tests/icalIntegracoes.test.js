/**
 * Área «Integrações» do gestor: só o gestor liga (403 ao proprietário), acordo RGPD (interruptor desligado/ligado),
 * vista geral por proprietário (só da empresa, sem N+1), lista única por confirmar e lote. Rede mockada.
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
const Acordo = require('../utils/acordoRgpd');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const AceitacaoAcordo = require('../models/AceitacaoAcordo');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');

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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), AceitacaoAcordo.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); delete process.env.ACORDO_RGPD_OBRIGATORIO; usar({}); });
afterEach(() => { delete process.env.ACORDO_RGPD_OBRIGATORIO; });

describe('só o gestor liga, testa, corrige e remove', () => {
  test('o proprietário recebe 403 a colar, testar, substituir, reativar e remover; continua a ver o estado e a decidir', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(cr.status).toBe(201);
    const id = cr.body.fonte._id;
    const corpo = { propriedade_id: String(c.casa._id), url: urlAirbnb() };
    expect((await request(app).post('/api/parceiro/calendarios').set(auth(c.tokP)).send(corpo)).status).toBe(403);
    expect((await request(app).post('/api/parceiro/calendarios/testar').set(auth(c.tokP)).send(corpo)).status).toBe(403);
    expect((await request(app).put(`/api/parceiro/calendarios/${id}`).set(auth(c.tokP)).send({ url: urlAirbnb() })).status).toBe(403);
    expect((await request(app).post(`/api/parceiro/calendarios/${id}/reativar`).set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get(`/api/parceiro/calendarios/${id}/impacto-remocao`).set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).delete(`/api/parceiro/calendarios/${id}`).set(auth(c.tokP))).status).toBe(403);
    expect(await FonteCalendario.countDocuments({ _id: id, removida: false })).toBe(1);
    const lst = await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP));
    expect(lst.status).toBe(200);
    expect(lst.body.fontes).toHaveLength(1);
    expect((await request(app).get('/api/parceiro/reservas-externas').set(auth(c.tokP))).status).toBe(200);
  });

  test('o proprietário continua a poder confirmar e dizer «é um bloqueio» no Booking por confirmar', async () => {
    const c = await cen();
    usar(BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 33 }]));
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    const lista = (await request(app).get('/api/parceiro/reservas-externas?estado=por_confirmar').set(auth(c.tokP))).body.reservas_externas;
    expect(lista).toHaveLength(2);
    expect((await request(app).post(`/api/parceiro/reservas-externas/${lista[0]._id}/confirmar`).set(auth(c.tokP)).send({})).status).toBe(200);
    expect((await request(app).post(`/api/parceiro/reservas-externas/${lista[1]._id}/bloqueio`).set(auth(c.tokP))).status).toBe(200);
  });

  test('o gestor liga e o proprietário recebe um aviso; o proprietário não usa as rotas de integrações do gestor', async () => {
    const c = await cen();
    usar(AIRBNB([]));
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    const Notificacao = require('../models/Notificacao');
    expect(await Notificacao.countDocuments({ utilizador_id: c.dono._id, mensagem: /O gestor ligou o calendário Airbnb/ })).toBe(1);
    expect((await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokP)).send({ ids: [], acao: 'bloqueio' })).status).toBe(403);
  });
});

describe('acordo RGPD (interruptor ACORDO_RGPD_OBRIGATORIO)', () => {
  test('DESLIGADO (omissão): o gestor liga sem acordo, o portal diz que não é obrigatório e nada fica pausado', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    expect((await request(app).get('/api/parceiro/acordo-dados').set(auth(c.tokP))).body).toMatchObject({ obrigatorio: false, aceite: false, versao: 'PROP-DPA-1.0' });
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(cr.status).toBe(201);
    expect(cr.body.fonte.estado).toBe('ativa');
    const r = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(r.body.acordo_obrigatorio).toBe(false);
    expect(r.body.proprietarios.find((p) => p._id === String(c.dono._id))).toMatchObject({ acordo: 'nao_exigido', estado: 'ok' });
  });

  test('LIGADO: 409 a testar e ligar sem acordo; ligações existentes ficam pausadas; aceitar desbloqueia e regista tudo', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const existente = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(existente.status).toBe(201);
    process.env.ACORDO_RGPD_OBRIGATORIO = 'true';

    const casa2 = await Propriedade.create({ nome: 'Casa2', empresa_id: c.e._id, origem: 'manual', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60, parceiro_id: c.dono._id });
    const corpo = { propriedade_id: String(casa2._id), url: urlBooking() };
    const t = await request(app).post('/api/gestor/calendarios/testar').set(auth(c.tokG)).send(corpo);
    expect(t.status).toBe(409);
    expect(t.body.codigo).toBe('ACORDO_POR_ACEITAR');
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send(corpo);
    expect(cr.status).toBe(409);
    expect(cr.body.erro).toMatch(/ainda não aceitou/);
    expect(await FonteCalendario.countDocuments({ propriedade_id: casa2._id })).toBe(0);

    // a lista e a vista geral mostram a ligação em pausa; a leitura não corre
    const lst = await request(app).get('/api/gestor/calendarios').set(auth(c.tokG));
    expect(lst.body.fontes[0]).toMatchObject({ estado: 'pausada', motivo_estado: 'acordo_por_aceitar' });
    const ant = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    const lin = ant.body.proprietarios.find((p) => p._id === String(c.dono._id));
    expect(lin).toMatchObject({ acordo: 'por_aceitar', estado: 'por_aceitar' });
    expect(ant.body.totais.por_aceitar).toBe(2); // Dono e Outro
    const sync = await require('../utils/calendarioExterno/sincronizar').sincronizarFonte(existente.body.fonte._id);
    expect(sync).toMatchObject({ resultado: 'pausada', motivo: 'acordo_por_aceitar' });

    // o proprietário vê o texto e aceita
    const ver = await request(app).get('/api/parceiro/acordo-dados').set(auth(c.tokP));
    expect(ver.body).toMatchObject({ obrigatorio: true, aceite: false });
    expect(ver.body.texto).toMatch(/Acordo de Tratamento de Dados/);
    expect(ver.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: ver.body.versao, hash: ver.body.hash })).status).toBe(400); // sem a caixa
    expect((await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: ver.body.versao, hash: 'x'.repeat(64), confirmo: true })).status).toBe(409);
    expect((await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokG)).send({ versao: ver.body.versao, hash: ver.body.hash, confirmo: true })).status).toBe(403); // o gestor não aceita por ele
    const ok = await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: ver.body.versao, hash: ver.body.hash, confirmo: true });
    expect(ok.status).toBe(201);
    const outra = await request(app).post('/api/parceiro/acordo-dados/aceitar').set(auth(c.tokP)).send({ versao: ver.body.versao, hash: ver.body.hash, confirmo: true });
    expect(outra.status).toBe(200); // idempotente
    const regs = await AceitacaoAcordo.find({ parceiro_id: c.dono._id }).lean();
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ versao: 'PROP-DPA-1.0', hash_texto: ver.body.hash, aceite_por_id: c.dono._id, empresa_id: c.e._id });
    expect(regs[0].aceite_por_email).toContain('@');
    expect(regs[0].aceite_em).toBeInstanceOf(Date);

    // agora o gestor liga e a ligação existente retoma
    const cr2 = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send(corpo);
    expect(cr2.status).toBe(201);
    const depois = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(depois.body.proprietarios.find((p) => p._id === String(c.dono._id))).toMatchObject({ acordo: 'aceite' });
    const s2 = await require('../utils/calendarioExterno/sincronizar').sincronizarFonte(existente.body.fonte._id);
    expect(['ok', 'sem_alteracoes']).toContain(s2.resultado);
  });

  test('LIGADO: reservas manuais e as do gestor continuam a funcionar sem acordo', async () => {
    const c = await cen();
    process.env.ACORDO_RGPD_OBRIGATORIO = 'true';
    const ci = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const co = new Date(Date.now() + 23 * 86400000).toISOString().slice(0, 10);
    const r = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(c.casa._id), check_in: ci, check_out: co, hospedes: 2 });
    expect(r.status).toBeLessThan(300);
    const ci2 = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const co2 = new Date(Date.now() + 43 * 86400000).toISOString().slice(0, 10);
    const g = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), check_in: ci2, check_out: co2, hospedes: 2 });
    expect(g.status).toBeLessThan(300);
  });

  test('o registo de aceitação não é apagado pelo RGPD da pessoa', async () => {
    const c = await cen();
    const t = Acordo.textoAtual();
    await AceitacaoAcordo.create({ empresa_id: c.e._id, parceiro_id: c.dono._id, aceite_por_id: c.dono._id, versao: t.versao, hash_texto: t.hash });
    const { apagarDadosPessoa } = require('../utils/rgpdPessoa');
    await apagarDadosPessoa({ empresaId: c.e._id, utilizadorId: c.dono._id }).catch(() => null);
    expect(await AceitacaoAcordo.countDocuments({ parceiro_id: c.dono._id })).toBe(1);
  });
});

describe('vista geral, por confirmar e lote', () => {
  test('o resumo agrega por proprietário, só da empresa do gestor, e esconde inativos por defeito', async () => {
    const c = await cen();
    const outra = await cen();
    usar({ ...AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]), ...BOOKING([{ uid: 'b1', ci: 20, co: 23 }]) });
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    await request(app).post('/api/gestor/calendarios').set(auth(outra.tokG)).send({ propriedade_id: String(outra.casa._id), url: urlAirbnb() });
    await Utilizador.updateOne({ _id: c.outro._id }, { ativo: false });

    const r = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.ligado).toBe(true);
    const nomes = r.body.proprietarios.map((p) => p.nome);
    expect(nomes).toEqual(['Dono']); // «Outro» inativo escondido; nada da outra empresa
    const dono = r.body.proprietarios[0];
    expect(dono).toMatchObject({ estado: 'ok', n_ligadas: 2, n_por_confirmar: 1 });
    expect(dono.casas[0].airbnb).toMatchObject({ estado: 'ativa' });
    expect(dono.casas[0].booking).toMatchObject({ estado: 'ativa' });
    expect(JSON.stringify(r.body)).not.toMatch(/segredo/);
    const com = await request(app).get('/api/gestor/integracoes/resumo?inativos=1').set(auth(c.tokG));
    expect(com.body.proprietarios.map((p) => p.nome).sort()).toEqual(['Dono', 'Outro']);
    expect(com.body.proprietarios.find((p) => p.nome === 'Outro')).toMatchObject({ ativo: false, estado: 'sem_ligacao' });
  });

  test('erros no topo e contagem para o selo; o erro vem em linguagem simples', async () => {
    const c = await cen();
    usar(AIRBNB([{ uid: 'a1', ci: 10, co: 13 }]));
    const cr = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    await FonteCalendario.updateOne({ _id: cr.body.fonte._id }, { estado: 'erro', ultimo_erro: { em: new Date(), codigo: 'http_404_410' } });
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokG))).body.erros).toBe(1);
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth((await cen()).tokG))).body.erros).toBe(0);
    const r = await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
    expect(r.body.totais.erros).toBe(1);
    expect(r.body.proprietarios[0]).toMatchObject({ estado: 'erro', n_erros: 1 });
    expect(r.body.proprietarios[0].primeiro_erro.mensagem).toMatch(/deixou de funcionar/);
  });

  test('o resumo não faz uma consulta por casa (sem N+1): o n.º de consultas não cresce com as casas', async () => {
    const c = await cen();
    const contar = async () => {
      const lista = []; mongoose.set('debug', (col, metodo) => lista.push(`${col}.${metodo}`));
      await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG));
      mongoose.set('debug', false);
      return lista.length;
    };
    const com1 = await contar();
    for (let i = 0; i < 6; i += 1) await Propriedade.create({ nome: 'Extra' + i, empresa_id: c.e._id, origem: 'manual', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60, parceiro_id: c.dono._id });
    const com7 = await contar();
    expect(com7).toBe(com1);
    expect(com7).toBeLessThanOrEqual(8);
  });

  test('lista única da empresa por confirmar (com proprietário) e decisões em lote', async () => {
    const c = await cen();
    const outra = await cen();
    usar(BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 33 }, { uid: 'b3', ci: 40, co: 43 }]));
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() });
    await request(app).post('/api/gestor/calendarios').set(auth(outra.tokG)).send({ propriedade_id: String(outra.casa._id), url: urlBooking() });
    const lista = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar').set(auth(c.tokG))).body.reservas_externas;
    expect(lista).toHaveLength(3);
    expect(lista[0].parceiro).toMatchObject({ nome: 'Dono' });
    const alheia = (await request(app).get('/api/gestor/reservas-externas?estado=por_confirmar').set(auth(outra.tokG))).body.reservas_externas;

    const lote = await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokG)).send({ ids: [lista[0]._id, lista[1]._id, alheia[0]._id, 'xx'], acao: 'confirmar' });
    expect(lote.status).toBe(200);
    expect(lote.body.ok).toBe(2);
    expect(lote.body.falhas).toBe(2); // a de outra empresa e o id inválido
    expect(await ReservaExterna.countDocuments({ _id: alheia[0]._id, estado: 'por_confirmar' })).toBe(1);
    const bl = await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokG)).send({ ids: [lista[2]._id], acao: 'bloqueio' });
    expect(bl.body.ok).toBe(1);
    expect(await ReservaExterna.countDocuments({ empresa_id: c.e._id, estado: 'por_confirmar' })).toBe(0);
    expect((await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokG)).send({ ids: [], acao: 'confirmar' })).status).toBe(400);
    expect((await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokG)).send({ ids: [lista[0]._id], acao: 'apagar' })).status).toBe(400);
    expect((await request(app).post('/api/gestor/reservas-externas/lote').set(auth(c.tokG)).send({ ids: Array(201).fill(lista[0]._id), acao: 'confirmar' })).status).toBe(400);
  });
});

describe('R1 reaparecimento, R2 hóspedes, R3 muitos novos', () => {
  const ler = (id) => require('../utils/calendarioExterno/sincronizar').sincronizarFonte(id, { transporte: global.__transporte });
  const ex = (c, uid) => ReservaExterna.findOne({ propriedade_id: c.casa._id, uid });
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  test('R1: a principal antiga reaparece depois de a duplicada ser promovida: passa a duplicada, sem 2 reservas nem 2 limpezas', async () => {
    const c = await cen();
    const bk = () => BOOKING([{ uid: 'b', ci: 20, co: 23 }, { uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 50, co: 52 }]);
    const bsem = () => BOOKING([{ uid: 'b2', ci: 40, co: 42 }, { uid: 'b3', ci: 50, co: 52 }]);
    usar(bk());
    const fb = (await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlBooking() })).body.fonte._id;
    const eb = await ex(c, 'b');
    await request(app).post(`/api/gestor/reservas-externas/${eb._id}/confirmar`).set(auth(c.tokG)).send({});
    usar({ ...AIRBNB([{ uid: 'a', ci: 20, co: 23 }]), ...bk() });
    await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    usar({ ...AIRBNB([{ uid: 'a', ci: 20, co: 23 }]), ...bsem() });
    for (let i = 0; i < 3; i += 1) await ler(fb);
    usar({ ...AIRBNB([{ uid: 'a', ci: 20, co: 23 }]), ...bk() });
    await ler(fb); await ler(fb);
    const dia23 = new Date(`${d(23)}T00:00:00Z`);
    const limpezas = (await Tarefa.find({ propriedade_id: c.casa._id, tipo: 'limpeza', estado: { $ne: 'cancelada' } }).lean()).filter((t) => t.data.toISOString().slice(0, 10) === d(23));
    expect(limpezas).toHaveLength(1);
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id, cancelada_em: null, check_out: dia23 })).toBe(1);
    expect((await ex(c, 'b')).estado).toBe('duplicada');
    expect((await ex(c, 'a')).estado).toBe('confirmada');
  });

  test('R2: a mensagem de hóspedes diz «entre 0 e 50» e 0 é aceite', async () => {
    const c = await cen();
    const base = { propriedade_id: String(c.casa._id), check_in: d(20), check_out: d(23) };
    const mau = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ ...base, hospedes: 51 });
    expect(mau.status).toBe(400);
    expect(mau.body.erro).toMatch(/entre 0 e 50/);
    expect(mau.body.erro).toMatch(/0 = usar a capacidade da casa/);
    expect((await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ ...base, hospedes: 0 })).status).toBeLessThan(300);
  });

  test('R3: mais de 60 novas = em validação com texto próprio (gestor e proprietário), na lista e na área Integrações', async () => {
    const c = await cen();
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ uid: `n${i}`, ci: 5 + i * 3, co: 7 + i * 3 }));
    usar(AIRBNB(mk(73)));
    const r = await request(app).post('/api/gestor/calendarios').set(auth(c.tokG)).send({ propriedade_id: String(c.casa._id), url: urlAirbnb() });
    expect(r.status).toBe(201);
    expect(await Tarefa.countDocuments({ propriedade_id: c.casa._id, tipo: 'limpeza' })).toBe(0);
    const g = (await request(app).get('/api/gestor/calendarios').set(auth(c.tokG))).body.fontes[0];
    expect(g.em_validacao).toBe(true);
    expect(g.aviso_validacao).toBe('Encontrámos 73 reservas novas de uma vez. Por segurança, não criámos nenhuma. Confirma que o calendário está certo e carrega em Aceitar.');
    const p = (await request(app).get('/api/parceiro/calendarios').set(auth(c.tokP))).body.fontes[0];
    expect(p.aviso_validacao).toBe('A All2gether está a validar este calendário.');
    const rs = (await request(app).get('/api/gestor/integracoes/resumo').set(auth(c.tokG))).body;
    expect(rs.proprietarios[0]).toMatchObject({ estado: 'erro', n_erros: 1 });
    expect(rs.proprietarios[0].primeiro_erro).toMatchObject({ codigo: 'muitos_novos' });
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokG))).body.erros).toBe(1);
    await request(app).patch(`/api/gestor/calendarios/${r.body.fonte._id}/estado`).set(auth(c.tokG)).send({ acao: 'aceitar_calendario' });
    await ler(r.body.fonte._id);
    expect((await request(app).get('/api/gestor/calendarios').set(auth(c.tokG))).body.fontes[0].em_validacao).toBe(false);
    expect((await request(app).get('/api/gestor/integracoes/contagem').set(auth(c.tokG))).body.erros).toBe(0);
  });
});
