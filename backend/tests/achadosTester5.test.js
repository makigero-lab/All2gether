/** Achados do @Tester (A6, A7, A9a-c): cada teste falhava antes da correção. */
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
const { preencherVagasPeriodo } = require('../utils/atribuicaoAutomatica');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
const diaEm = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function cenario() {
  const e = await Empresa.create({ nome: 'T5-' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const parceiro = await mk('parceiro', 'parceiro');
  const ana = await mk('Ana', 'staff');
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, staff_necessario: 1, parceiro_id: parceiro._id });
  return { e, g, parceiro, ana, p, mk, tokenG: await login(g), tokenP: await login(parceiro) };
}
const reservar = (c, corpo) => request(app).post('/api/parceiro/reservas').set(auth(c.tokenP)).send({ propriedade_id: String(c.p._id), hospedes: 2, ...corpo });
const mudar = (c, id, corpo) => request(app).patch(`/api/gestor/tarefas/${id}/data`).set(auth(c.tokenG)).send(corpo);

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('A6 pedidos simultâneos', () => {
  test('Mudar dia em simultâneo nunca dá 500', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(5), check_out: diaEm(8) });
    const id = r.body.tarefa._id;
    const rs = await Promise.all([mudar(c, id, { data: diaEm(10) }), mudar(c, id, { data: diaEm(11) }), mudar(c, id, { data: diaEm(12) })]);
    for (const x of rs) expect([200, 409]).toContain(x.status);
    expect(rs.some((x) => x.status === 200)).toBe(true);
  });

  test('DELETE e cancelar da mesma ausência em simultâneo: nunca 500, um só ganha', async () => {
    const c = await cenario();
    const dia = new Date(`${diaEm(20)}T00:00:00Z`);
    const au = await Ausencia.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, data_inicio: dia, data_fim: dia, tipo: 'ferias', estado: 'aprovada' });
    const [d, k] = await Promise.all([
      request(app).delete(`/api/gestor/ausencias/${au._id}`).set(auth(c.tokenG)),
      request(app).patch(`/api/gestor/ausencias/${au._id}/cancelar`).set(auth(c.tokenG)),
    ]);
    for (const x of [d, k]) expect([200, 404, 409]).toContain(x.status);
    expect([d.status, k.status]).not.toEqual([200, 200]);
  });
});

describe('A7 Mudar dia: limites e hora fora do horário', () => {
  test('recusa dias no passado e a mais de 2 anos; aceita hora fora do horário com aviso', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(5), check_out: diaEm(8) });
    const id = r.body.tarefa._id;
    process.env.DATAS_SEM_LIMITES = '0';
    try {
      const passado = await mudar(c, id, { data: diaEm(-3) });
      expect(passado.status).toBe(400);
      expect(passado.body.erro).toMatch(/já passou/);
      const longe = await mudar(c, id, { data: diaEm(900) });
      expect(longe.status).toBe(400);
      const tarde = await mudar(c, id, { data: diaEm(12), hora: '20:30' });
      expect(tarde.status).toBe(200);
      expect(tarde.body.aviso).toMatch(/fora do horário/);
      const hoje = await mudar(c, id, { data: diaEm(13), hora: '10:00' });
      expect(hoje.status).toBe(200);
    } finally {
      process.env.DATAS_SEM_LIMITES = '1';
    }
  });
});

describe('A9 reservas', () => {
  test('A9a: o aviso «Dia da limpeza recalculado» só sai se o dia mudou de facto', async () => {
    const c = await cenario();
    const co = diaEm(10);
    const r = await reservar(c, { check_in: diaEm(6), check_out: co });
    // o gestor ajusta o dia e volta a pô-lo no dia do check-out: fica «ajustado» mas igual
    expect((await mudar(c, r.body.tarefa._id, { data: diaEm(12) })).status).toBe(200);
    expect((await mudar(c, r.body.tarefa._id, { data: co })).status).toBe(200);
    await Notificacao.deleteMany({});
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(c.tokenP)).send({ check_in: diaEm(7) });
    expect(u.status).toBe(200);
    expect(await Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /Dia da limpeza recalculado/ })).toBe(0);
  });

  test('A9b: intermédia com a data calculada no passado -> 400', async () => {
    const c = await cenario();
    const r = await reservar(c, { check_in: diaEm(-20), check_out: diaEm(-10), tipo_limpeza: 'intermedia' });
    expect(r.status).toBe(400);
    const ok = await reservar(c, { check_in: diaEm(5), check_out: diaEm(15), tipo_limpeza: 'intermedia' });
    expect(ok.status).toBe(201);
  });

  test('A9c: o preenchimento automático não mexe no que o gestor desatribuiu de propósito', async () => {
    const c = await cenario();
    const a = await reservar(c, { check_in: diaEm(5), check_out: diaEm(8) });
    const b = await reservar(c, { check_in: diaEm(6), check_out: diaEm(9) });
    // ambas ficam atribuídas à Ana; o gestor desatribui a primeira de propósito, a segunda fica por atribuir por outra razão
    const des = await request(app).patch(`/api/gestor/tarefas/${a.body.tarefa._id}/atribuir`).set(auth(c.tokenG)).send({ utilizador_id: null });
    expect(des.status).toBe(200);
    expect((await Tarefa.findById(a.body.tarefa._id)).desatribuida_manual).toBe(true);
    await Tarefa.updateOne({ _id: b.body.tarefa._id }, { $set: { utilizador_id: null, equipa_atribuida: [], estado: 'por_atribuir' } });
    const r = await preencherVagasPeriodo(c.e._id, new Date(`${diaEm(1)}T00:00:00Z`), new Date(`${diaEm(30)}T00:00:00Z`));
    expect(r.erro).toBeUndefined();
    const ta = await Tarefa.findById(a.body.tarefa._id).lean();
    const tb = await Tarefa.findById(b.body.tarefa._id).lean();
    expect(ta.estado).toBe('por_atribuir');
    expect(ta.utilizador_id).toBeNull();
    expect(tb.estado).toBe('atribuida');
    // quando o gestor volta a atribuir, a marca limpa-se
    const re = await request(app).patch(`/api/gestor/tarefas/${a.body.tarefa._id}/atribuir`).set(auth(c.tokenG)).send({ utilizador_id: String(c.ana._id) });
    expect(re.status).toBe(200);
    expect((await Tarefa.findById(a.body.tarefa._id)).desatribuida_manual).toBe(false);
  });
});
