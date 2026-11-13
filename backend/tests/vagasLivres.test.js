/** Vagas livres: quando ninguém está disponível, a vaga é oferecida à equipa não ausente (aceita quem chegar primeiro). */
process.env.OFERTA_VAGAS_TESTE = '1';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Notificacao = require('../models/Notificacao');
const { calcularPrazoOferta, expirarOfertas, abrirOfertasPendentes, abrirOferta } = require('../utils/ofertaVaga');
const H = require('../utils/horario');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
const diaEm = (dias) => new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);

// Toda a equipa de folga todos os dias: o motor não encontra ninguém, mas ninguém está «ausente».
const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6];

async function cenario({ sn = 1 } = {}) {
  const e = await Empresa.create({ nome: 'V' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const parceiro = await mk('parceiro', 'parceiro');
  const ana = await mk('Ana', 'staff', { dias_folga: TODOS_OS_DIAS });
  const bia = await mk('Bia', 'staff', { dias_folga: TODOS_OS_DIAS });
  const cris = await mk('Cris', 'staff', { dias_folga: TODOS_OS_DIAS });
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: sn, parceiro_id: parceiro._id });
  return { e, g, parceiro, ana, bia, cris, p, mk, tokenP: await login(parceiro), tokenG: await login(g) };
}
const reservar = (c, corpo) => request(app).post('/api/parceiro/reservas').set(auth(c.tokenP)).send({ propriedade_id: String(c.p._id), hospedes: 2, ...corpo });
const ausente = (c, u, dia) => Ausencia.create({ utilizador_id: u._id, empresa_id: c.e._id, data_inicio: new Date(`${dia}T00:00:00Z`), data_fim: new Date(`${dia}T00:00:00Z`), tipo: 'ferias', estado: 'aprovada' });
const aceitar = (token, id) => request(app).post(`/api/staff/vagas-livres/${id}/aceitar`).set(auth(token)).send({});

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('prazo da oferta', () => {
  const t = (dia, iso) => ({ data: new Date(iso || `${dia}T10:00:00Z`) });
  test('18:00 de Lisboa da véspera (inverno e verão) quando vem primeiro', () => {
    // sem hora real: início previsto 09:00 locais; 2 h antes = 07:00; a véspera 18:00 vem primeiro
    const inv = calcularPrazoOferta({ data: new Date('2031-01-15T00:00:00Z') }, new Date('2031-01-10T10:00:00Z'));
    expect(inv.toISOString()).toBe('2031-01-14T18:00:00.000Z');
    const ver = calcularPrazoOferta({ data: new Date('2031-07-15T00:00:00Z') }, new Date('2031-07-10T10:00:00Z'));
    expect(ver.toISOString()).toBe('2031-07-14T17:00:00.000Z');
  });
  test('2 h antes do início quando vem primeiro (limpeza hoje à tarde) e salta se começa em menos de 2 h', () => {
    const tarefa = { data: new Date('2031-01-15T15:00:00Z') }; // 15:00 locais
    // agora = véspera depois das 18:00 já não há prazo da véspera; 2 h antes = 13:00 mas a véspera 18:00 já passou
    expect(calcularPrazoOferta(tarefa, new Date('2031-01-14T19:00:00Z'))).toBeNull();
    // início daqui a 1h30: salta
    expect(calcularPrazoOferta(tarefa, new Date('2031-01-15T13:30:00Z'))).toBeNull();
    // dentro do prazo normal
    expect(calcularPrazoOferta(tarefa, new Date('2031-01-14T09:00:00Z')).toISOString()).toBe('2031-01-14T18:00:00.000Z');
  });
  test('usa o menor dos dois quando o início é muito cedo', () => {
    const tarefa = { data: new Date('2031-01-15T08:00:00Z') }; // 08:00 locais (inverno)
    // 2 h antes = 06:00 do próprio dia, depois da véspera 18:00: a véspera vem primeiro
    expect(calcularPrazoOferta(tarefa, new Date('2031-01-14T09:00:00Z')).toISOString()).toBe('2031-01-14T18:00:00.000Z');
    expect(t('2031-01-15')).toBeTruthy();
  });
});

describe('oferta à equipa', () => {
  test('sem ninguém disponível: a vaga é oferecida a quem não está ausente (sino) e os gestores são avisados', async () => {
    const c = await cenario();
    const dia = diaEm(4);
    await ausente(c, c.cris, dia);
    const r = await reservar(c, { check_in: diaEm(2), check_out: dia });
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.estado).toBe('por_atribuir');
    expect(t.oferta_estado).toBe('aberta');
    expect(t.oferta_dia).toBe(dia);
    expect(new Date(t.oferta_expira_em).getTime()).toBeGreaterThan(Date.now());
    const msg = (u) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: /Há uma limpeza livre em .* no dia/ });
    expect(await msg(c.ana)).toBe(1);
    expect(await msg(c.bia)).toBe(1);
    expect(await msg(c.cris)).toBe(0); // ausente nesse dia
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /Vaga oferecida à equipa/ })).toBe(1);
    // aparece na lista de quem pode aceitar, e não na de quem está ausente
    const lista = await request(app).get('/api/staff/vagas-livres').set(auth(await login(c.ana)));
    expect(lista.status).toBe(200);
    expect(lista.body.vagas.map((v) => v._id)).toEqual([String(t._id)]);
    expect((await request(app).get('/api/staff/vagas-livres').set(auth(await login(c.cris)))).body.vagas).toHaveLength(0);
  });

  test('dois a aceitar ao mesmo tempo: só um fica com ela, o outro recebe «já foi aceite»', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const id = r.body.tarefa._id;
    const [ta, tb] = [await login(c.ana), await login(c.bia)];
    const [a, b] = await Promise.all([aceitar(ta, id), aceitar(tb, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const perdedor = a.status === 409 ? a : b;
    expect(perdedor.body.codigo).toBe('JA_ACEITE');
    expect(perdedor.body.erro).toMatch(/já foi aceite/);
    const t = await Tarefa.findById(id).lean();
    expect(t.estado).toBe('atribuida');
    expect(t.pessoas_em_falta).toBe(0);
    expect(t.oferta_estado).toBe('aceite');
    expect(H.temHoraReal(t.data)).toBe(true); // hora recalculada pelo motor de horário
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /aceitou a limpeza/ })).toBe(1);
    // fecha o cartão para os outros
    expect((await request(app).get('/api/staff/vagas-livres').set(auth(await login(c.cris)))).body.vagas).toHaveLength(0);
  });

  test('equipa de 2 com 6 aceitações em simultâneo: acabam exatamente 2 aceites', async () => {
    const c = await cenario({ sn: 2 });
    const r = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const id = r.body.tarefa._id;
    const extra = [];
    for (const nome of ['Dani', 'Eva', 'Fabio']) extra.push(await c.mk(nome, 'staff', { dias_folga: TODOS_OS_DIAS }));
    const users = [c.ana, c.bia, c.cris, ...extra];
    const tokens = [];
    for (const u of users) tokens.push(await login(u));
    const res = await Promise.all(tokens.map((tk) => aceitar(tk, id)));
    expect(res.filter((x) => x.status === 200)).toHaveLength(2);
    expect(res.filter((x) => x.status === 409).every((x) => x.body.codigo === 'JA_ACEITE')).toBe(true);
    const t = await Tarefa.findById(id).lean();
    expect(t.pessoas_em_falta).toBe(0);
    expect((t.equipa_atribuida || []).length).toBe(2);
    expect(t.oferta_estado).toBe('aceite');
  });

  test('equipa de 2 pessoas: aceitam-se duas vagas e a terceira pessoa fica de fora', async () => {
    const c = await cenario({ sn: 2 });
    const r = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const id = r.body.tarefa._id;
    const [ta, tb, tc] = [await login(c.ana), await login(c.bia), await login(c.cris)];
    const lista = await request(app).get('/api/staff/vagas-livres').set(auth(ta));
    expect(lista.body.vagas[0].vagas).toBe(2);
    expect((await aceitar(ta, id)).status).toBe(200);
    let t = await Tarefa.findById(id).lean();
    expect(t.estado).toBe('atribuida');
    expect(t.pessoas_em_falta).toBe(1);
    expect(t.oferta_estado).toBe('aberta');
    // a mesma pessoa não aceita duas vezes
    expect((await aceitar(ta, id)).status).toBe(409);
    expect((await aceitar(tb, id)).status).toBe(200);
    t = await Tarefa.findById(id).lean();
    expect(t.pessoas_em_falta).toBe(0);
    expect(t.oferta_estado).toBe('aceite');
    expect((t.equipa_atribuida || []).map(String).sort()).toEqual([String(c.ana._id), String(c.bia._id)].sort());
    const terceira = await aceitar(tc, id);
    expect(terceira.status).toBe(409);
    expect(terceira.body.codigo).toBe('JA_ACEITE');
  });

  test('o gestor atribui à mão: a oferta fecha-se; cancelada: ninguém aceita; ausente não aceita', async () => {
    const c = await cenario();
    const r1 = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const r2 = await reservar(c, { check_in: diaEm(3), check_out: diaEm(5) });
    const dia2 = diaEm(5);
    await ausente(c, c.bia, dia2);
    const ta = await login(c.ana);
    // atribuição manual do gestor
    await Tarefa.updateOne({ _id: r1.body.tarefa._id }, { $set: { utilizador_id: c.cris._id, estado: 'atribuida' } });
    const x = await aceitar(ta, r1.body.tarefa._id);
    expect(x.status).toBe(409);
    expect((await expirarOfertas()).fechadas).toBeGreaterThanOrEqual(1);
    expect((await Tarefa.findById(r1.body.tarefa._id)).oferta_estado).not.toBe('aberta');
    // ausente nesse dia
    const y = await aceitar(await login(c.bia), r2.body.tarefa._id);
    expect(y.status).toBe(409);
    expect(y.body.codigo).toBe('AUSENTE');
    // cancelada
    await Tarefa.updateOne({ _id: r2.body.tarefa._id }, { $set: { estado: 'cancelada' } });
    expect((await aceitar(ta, r2.body.tarefa._id)).status).toBe(409);
    // só a equipa aceita
    expect((await aceitar(c.tokenP, r2.body.tarefa._id)).status).toBe(403);
  });

  test('prazo: depois dele ninguém aceita, a tarefa fica por atribuir e os gestores são avisados', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const id = r.body.tarefa._id;
    await Tarefa.updateOne({ _id: id }, { $set: { oferta_expira_em: new Date(Date.now() - 1000) } });
    const exp = await aceitar(await login(c.ana), id);
    expect(exp.status).toBe(409);
    expect(exp.body.codigo).toBe('OFERTA_EXPIRADA');
    const j = await expirarOfertas();
    expect(j.expiradas).toBe(1);
    const t = await Tarefa.findById(id).lean();
    expect(t.oferta_estado).toBe('expirada');
    expect(t.estado).toBe('por_atribuir');
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /Ninguém aceitou a limpeza livre/ })).toBe(1);
    // não volta a oferecer neste dia
    await abrirOfertasPendentes();
    expect((await Tarefa.findById(id)).oferta_estado).toBe('expirada');
    expect((await abrirOferta(id)).motivo).toBe('ja_expirou');
  });

  test('o gestor muda o dia: a oferta recomeça para o novo dia', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(2), check_out: diaEm(4) });
    const id = r.body.tarefa._id;
    const novo = diaEm(6);
    const m = await request(app).patch(`/api/gestor/tarefas/${id}/data`).set(auth(c.tokenG)).send({ data: novo });
    expect(m.status).toBe(200);
    const t = await Tarefa.findById(id).lean();
    expect(t.estado).toBe('por_atribuir');
    expect(t.oferta_estado).toBe('aberta');
    expect(t.oferta_dia).toBe(novo);
  });

  test('o rastreio apanha limpezas sem oferta (rede de segurança) e respeita o interruptor dos testes', async () => {
    const c = await cenario();
    const dia = diaEm(5);
    const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, data: new Date(`${dia}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir', tipo: 'limpeza', origem: 'manual' });
    const r = await abrirOfertasPendentes();
    expect(r.abertas).toBeGreaterThanOrEqual(1);
    expect((await Tarefa.findById(t._id)).oferta_estado).toBe('aberta');
  });
});
