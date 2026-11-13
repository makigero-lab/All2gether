/** Limpezas livres: só se oferecem, notificam e listam limpezas até 7 dias (dia de Lisboa); as abertas além disso fecham-se sem avisar. */
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
const Notificacao = require('../models/Notificacao');
const { abrirOferta, abrirOfertasPendentes, expirarOfertas, listarOfertas, limiteOferta } = require('../utils/ofertaVaga');
const { executarOfertasVagas } = require('../jobs/ofertaVagas');
const H = require('../utils/horario');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
const diaEm = (dias) => H.somarDiasISO(H.hojeLisboa(), dias);

async function cenario() {
  const e = await Empresa.create({ nome: 'J' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1 });
  const tarefa = (dias, x = {}) => Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date(`${diaEm(dias)}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir', tipo: 'limpeza', origem: 'manual', ...x });
  return { e, g, ana, p, tarefa };
}
const msgVaga = (u) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: /Há uma limpeza livre/ });

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('janela de 7 dias das limpezas livres', () => {
  test('o limite é hoje (Lisboa) + 7 dias de calendário', () => {
    expect(limiteOferta(new Date('2026-11-13T12:00:00Z'))).toBe('2026-11-20');
    // 23:30 UTC de 30/06 já é 00:30 de 01/07 em Lisboa (verão)
    expect(limiteOferta(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-08');
  });

  test('abrirOferta: dentro dos 7 dias abre e notifica; ao 8.º dia não abre, não notifica e não marca como expirada', async () => {
    const c = await cenario();
    const dentro = await c.tarefa(7);
    const fora = await c.tarefa(8);
    const r1 = await abrirOferta(dentro._id);
    expect(r1.aberta).toBe(true);
    const r2 = await abrirOferta(fora._id);
    expect(r2).toMatchObject({ aberta: false, motivo: 'fora_da_janela' });
    const f = await Tarefa.findById(fora._id).lean();
    expect(f.oferta_estado ?? null).toBeNull(); // não fica «expirada»: abre quando entrar na janela
    expect(await msgVaga(c.ana)).toBe(1); // só a de dentro
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /Vaga oferecida/ })).toBe(1);
  });

  test('a rede de segurança só abre as que estão na janela e abre as outras quando lá chegam', async () => {
    const c = await cenario();
    const t3 = await c.tarefa(3);
    const t30 = await c.tarefa(30);
    const t60 = await c.tarefa(60);
    const r = await abrirOfertasPendentes();
    expect(r.candidatas).toBe(1);
    expect((await Tarefa.findById(t3._id)).oferta_estado).toBe('aberta');
    expect((await Tarefa.findById(t30._id)).oferta_estado ?? null).toBeNull();
    expect((await Tarefa.findById(t60._id)).oferta_estado ?? null).toBeNull();
    expect(await msgVaga(c.ana)).toBe(1);

    // 23 dias depois, a limpeza de daqui a 30 dias passa a estar a 7 dias: a rotina abre-a nessa altura
    const depois = new Date(Date.now() + 23 * 86400000);
    const r2 = await abrirOfertasPendentes(depois);
    expect(r2.abertas).toBeGreaterThanOrEqual(1);
    expect((await Tarefa.findById(t30._id)).oferta_estado).toBe('aberta');
    expect((await Tarefa.findById(t60._id)).oferta_estado ?? null).toBeNull();
    expect(await msgVaga(c.ana)).toBe(2);
  });

  test('as ofertas já abertas além dos 7 dias fecham-se na rotina, sem notificar ninguém', async () => {
    const c = await cenario();
    const longe = await c.tarefa(30, { oferta_estado: 'aberta', oferta_dia: diaEm(30), oferta_expira_em: new Date(Date.now() + 20 * 86400000) });
    const perto = await c.tarefa(3, { oferta_estado: 'aberta', oferta_dia: diaEm(3), oferta_expira_em: new Date(Date.now() + 86400000) });
    const antes = await Notificacao.countDocuments({});
    const r = await executarOfertasVagas();
    expect(r.fechadas).toBeGreaterThanOrEqual(1);
    expect((await Tarefa.findById(longe._id)).oferta_estado).toBe('fechada');
    expect((await Tarefa.findById(perto._id)).oferta_estado).toBe('aberta');
    // fechar não avisa ninguém (nem equipa nem gestor)
    expect(await Notificacao.countDocuments({})).toBe(antes);
  });

  test('a lista do staff (GET /api/staff/vagas-livres) esconde ofertas além dos 7 dias, mesmo que estejam abertas', async () => {
    const c = await cenario();
    const longe = await c.tarefa(30, { oferta_estado: 'aberta', oferta_dia: diaEm(30), oferta_expira_em: new Date(Date.now() + 20 * 86400000) });
    const perto = await c.tarefa(5, { oferta_estado: 'aberta', oferta_dia: diaEm(5), oferta_expira_em: new Date(Date.now() + 86400000) });
    const lista = await request(app).get('/api/staff/vagas-livres').set(auth(await login(c.ana)));
    expect(lista.status).toBe(200);
    expect(lista.body.vagas.map((v) => v._id)).toEqual([String(perto._id)]);
    expect((await listarOfertas({ id: c.ana._id, empresa_id: c.e._id })).map((v) => v._id)).not.toContain(String(longe._id));
    // e não se aceita uma vaga fora da janela
    const x = await request(app).post(`/api/staff/vagas-livres/${longe._id}/aceitar`).set(auth(await login(c.ana))).send({});
    expect(x.status).toBe(409);
  });

  test('casa inativa: não se oferece vaga', async () => {
    const c = await cenario();
    const t = await c.tarefa(2);
    await Propriedade.updateOne({ _id: c.p._id }, { $set: { ativo: false } });
    expect(await abrirOferta(t._id)).toMatchObject({ aberta: false, motivo: 'casa_inativa' });
    expect((await expirarOfertas()).expiradas).toBe(0);
  });
});
