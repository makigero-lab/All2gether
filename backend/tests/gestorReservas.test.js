/**
 * O gestor marca, altera e apaga reservas em nome do proprietário (mesmos serviços que o portal do
 * proprietário): isolamento por empresa e por papel, reserva normal do proprietário, avisos, e sem duplicados.
 */
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
const ReservaManual = require('../models/ReservaManual');
const { processarReservaSmoobu } = require('../controllers/smoobuController');
const R = require('../utils/reservasParceiro');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function empresaCom() {
  const e = await Empresa.create({ nome: 'GR' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const staff = await mk('Ana', 'staff');
  const dono = await mk('Dono', 'parceiro');
  const casa = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, origem: 'manual', ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: dono._id });
  return { e, g, staff, dono, casa, tokG: await login(g), tokS: await login(staff), tokP: await login(dono) };
}
const sino = (u, re) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: re });

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); await ReservaManual.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('gestor marca reservas em nome do proprietário', () => {
  test('cria, o proprietário vê a reserva como sua, edita e apaga; fica registado quem criou', async () => {
    const c = await empresaCom();
    const r = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG))
      .send({ propriedade_id: String(c.casa._id), check_in: dia(20), check_out: dia(23), hospedes: 3 });
    expect(r.status).toBe(201);
    expect(r.body.tarefa).toBeTruthy();
    expect(String(r.body.reserva.parceiro_id)).toBe(String(c.dono._id));
    expect(r.body.reserva.criada_pelo_gestor).toBe(true);
    expect(String(r.body.reserva.criada_por)).toBe(String(c.g._id));

    const lista = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    expect(lista.body.reservas).toHaveLength(1);
    expect(lista.body.reservas[0].criada_pelo_gestor).toBe(true);

    const ed = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokP)).send({ hospedes: 2, observacoes: 'dele' });
    expect(ed.status).toBe(200);
    const ap = await request(app).delete(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokP));
    expect(ap.status).toBe(200);
    expect((await Tarefa.findById(r.body.tarefa._id)).estado).toBe('cancelada');
  });

  test('o gestor lista, altera e apaga; o proprietário recebe aviso no sino e o gestor não recebe o das 48 h', async () => {
    const c = await empresaCom();
    const cr = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG))
      .send({ propriedade_id: String(c.casa._id), check_in: dia(-1), check_out: dia(1), hospedes: 2 });
    expect(cr.status).toBe(201);
    expect(await sino(c.dono, /A All2gether criou uma reserva tua/)).toBe(1);
    expect(await sino(c.g, /Proprietário mexeu|proprietário criou/i)).toBe(0); // sem o aviso das 48 h pelas próprias ações

    const id = cr.body.reserva._id;
    const lst = await request(app).get(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG));
    expect(lst.status).toBe(200);
    expect(lst.body.reservas).toHaveLength(1);

    const al = await request(app).put(`/api/gestor/parceiros/${c.dono._id}/reservas/${id}`).set(auth(c.tokG)).send({ check_out: dia(2) });
    expect(al.status).toBe(200);
    expect(await sino(c.dono, /A All2gether alterou uma reserva tua/)).toBe(1);
    const so_notas = await request(app).put(`/api/gestor/parceiros/${c.dono._id}/reservas/${id}`).set(auth(c.tokG)).send({ observacoes: 'x' });
    expect(so_notas.status).toBe(200);
    expect(await sino(c.dono, /A All2gether alterou uma reserva tua/)).toBe(2);

    const ap = await request(app).delete(`/api/gestor/parceiros/${c.dono._id}/reservas/${id}`).set(auth(c.tokG));
    expect(ap.status).toBe(200);
    expect(await sino(c.dono, /A All2gether apagou uma reserva tua/)).toBe(1);
    expect(await sino(c.g, /Proprietário mexeu/)).toBe(0);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /proprietário (criou|alterou|apagou)/i })).toBe(0);
  });

  test('o proprietário a mexer continua a avisar o gestor nas 48 h', async () => {
    const c = await empresaCom();
    const r = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(c.casa._id), check_in: dia(-1), check_out: dia(1), hospedes: 2 });
    expect(r.status).toBe(201);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /O proprietário criou uma reserva/ })).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: c.dono._id })).toBe(0);
  });

  test('segurança: gestor de outra empresa, staff e proprietário não podem usar os endpoints do gestor', async () => {
    const a = await empresaCom();
    const b = await empresaCom();
    const corpo = { propriedade_id: String(a.casa._id), check_in: dia(30), check_out: dia(32) };
    // gestor de outra empresa: proprietário inexistente para ele
    const x = await request(app).post(`/api/gestor/parceiros/${a.dono._id}/reservas`).set(auth(b.tokG)).send(corpo);
    expect(x.status).toBe(404);
    expect((await request(app).get(`/api/gestor/parceiros/${a.dono._id}/reservas`).set(auth(b.tokG))).status).toBe(404);
    expect((await request(app).get(`/api/gestor/parceiros/${a.dono._id}/propriedades`).set(auth(b.tokG))).status).toBe(404);
    // casa de outra empresa/proprietário
    const y = await request(app).post(`/api/gestor/parceiros/${b.dono._id}/reservas`).set(auth(b.tokG)).send(corpo);
    expect(y.status).toBe(404);
    // staff e proprietário
    for (const t of [a.tokS, a.tokP]) {
      expect((await request(app).get(`/api/gestor/parceiros/${a.dono._id}/reservas`).set(auth(t))).status).toBe(403);
      expect((await request(app).post(`/api/gestor/parceiros/${a.dono._id}/reservas`).set(auth(t)).send(corpo)).status).toBe(403);
      expect((await request(app).delete(`/api/gestor/parceiros/${a.dono._id}/reservas/${new mongoose.Types.ObjectId()}`).set(auth(t))).status).toBe(403);
    }
    // sem token
    expect((await request(app).get(`/api/gestor/parceiros/${a.dono._id}/reservas`)).status).toBe(401);
    // id inválido
    expect((await request(app).get('/api/gestor/parceiros/xx/reservas').set(auth(a.tokG))).status).toBe(400);
    expect(await ReservaManual.countDocuments({ empresa_id: { $in: [a.e._id, b.e._id] } })).toBe(0);
  });

  test('regras de casa ativa: proprietário inativo ou casa inativa não recebem reservas do gestor', async () => {
    const c = await empresaCom();
    const corpo = { propriedade_id: String(c.casa._id), check_in: dia(30), check_out: dia(32) };
    await Utilizador.updateOne({ _id: c.dono._id }, { ativo: false });
    const r1 = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG)).send(corpo);
    expect(r1.status).toBe(409);
    await Utilizador.updateOne({ _id: c.dono._id }, { ativo: true });
    await Propriedade.updateOne({ _id: c.casa._id }, { ativo: false });
    const r2 = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG)).send(corpo);
    expect(r2.status).toBe(404);
    const pr = await request(app).get(`/api/gestor/parceiros/${c.dono._id}/propriedades`).set(auth(c.tokG));
    expect(pr.body.propriedades).toHaveLength(0);
    expect(await ReservaManual.countDocuments({ empresa_id: c.e._id })).toBe(0);
  });

  test('o ecrã do gestor mostra as limpezas da gestão e do Smoobu; sem duplicar a limpeza partilhada no mesmo dia', async () => {
    const c = await empresaCom();
    const smoobu = await Propriedade.create({ nome: 'CasaS' + ++n, empresa_id: c.e._id, smoobu_id: String(8000 + n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: c.dono._id });
    await processarReservaSmoobu({ action: 'newReservation', data: { id: 7000 + n, type: 'reservation', arrival: dia(40), departure: dia(43), apartment: { id: Number(smoobu.smoobu_id) }, 'guest-name': 'Secreto', adults: 2, children: 0 } }, c.e._id, c.e._id);
    const lst = await request(app).get(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG));
    expect(lst.body.reservas_externas).toHaveLength(1);
    expect(lst.body.reservas_externas[0].origem).toBe('smoobu');
    // o gestor marca uma reserva no mesmo dia, na mesma casa do Smoobu: cria a reserva mas avisa a dupla limpeza
    const r = await request(app).post(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG))
      .send({ propriedade_id: String(smoobu._id), check_in: dia(40), check_out: dia(43) });
    expect(r.status).toBe(201);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /duas limpezas/ })).toBe(1);
    // duas reservas do mesmo dia na mesma casa (gestor + proprietário): UMA só limpeza
    const dup = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(smoobu._id), check_in: dia(41), check_out: dia(43) });
    expect(dup.status).toBe(201);
    expect(dup.body.associada_a_existente).toBe(true);
    const limpezas = await Tarefa.countDocuments({ propriedade_id: smoobu._id, tipo: 'limpeza', estado: { $ne: 'cancelada' }, origem_parceiro: true });
    expect(limpezas).toBe(1);
  });

  test('a lista do proprietário e a do gestor são a mesma: reservas dele, do gestor, do iCal e do Smoobu; sem limpezas avulsas, manutenções nem duplicados', async () => {
    const c = await empresaCom();
    const smoobu = await Propriedade.create({ nome: 'CasaS' + ++n, empresa_id: c.e._id, smoobu_id: String(9000 + n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: c.dono._id });
    const post = (tok, url, b) => request(app).post(url).set(auth(tok)).send(b);
    await post(c.tokP, '/api/parceiro/reservas', { propriedade_id: String(c.casa._id), check_in: dia(20), check_out: dia(22) });
    await post(c.tokG, `/api/gestor/parceiros/${c.dono._id}/reservas`, { propriedade_id: String(c.casa._id), check_in: dia(30), check_out: dia(32) });
    // reserva iCal confirmada = ReservaManual origem ical (uma só linha)
    const ical = await R.criarReservaComLimpeza({ parceiroId: c.dono._id, empresaId: c.e._id, ator: { tipo: 'ical' }, camposReserva: { origem: 'ical', sincronizada: true, plataforma: 'Airbnb' }, body: { propriedade_id: String(c.casa._id), check_in: dia(40), check_out: dia(42) } });
    expect(ical.status).toBe(201);
    await processarReservaSmoobu({ action: 'newReservation', data: { id: 7500 + n, type: 'reservation', arrival: dia(50), departure: dia(53), apartment: { id: Number(smoobu.smoobu_id) }, 'guest-name': 'X', adults: 2, children: 0 } }, c.e._id, c.e._id);
    await post(c.tokG, '/api/gestor/tarefas', { propriedade_id: String(c.casa._id), data: dia(60), tipo: 'limpeza' }); // limpeza avulsa do gestor
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.casa._id, data: new Date(Date.now() + 86400000), tipo: 'manutencao', estado: 'por_atribuir', tempo_limpeza_minutos: 30 });
    const p = (await request(app).get('/api/parceiro/reservas').set(auth(c.tokP))).body;
    const g = (await request(app).get(`/api/gestor/parceiros/${c.dono._id}/reservas`).set(auth(c.tokG))).body;
    expect(p.reservas).toHaveLength(3);
    expect(p.reservas.filter((r) => r.origem === 'ical')).toHaveLength(1);
    expect(p.reservas.filter((r) => r.criada_pelo_gestor)).toHaveLength(1);
    expect(p.reservas_externas).toHaveLength(1);
    expect(p.reservas_externas[0].origem).toBe('smoobu');
    expect(g.reservas.map((r) => r._id).sort()).toEqual(p.reservas.map((r) => r._id).sort());
    expect(g.reservas_externas.map((r) => r._id)).toEqual(p.reservas_externas.map((r) => r._id));
  });
});
