/**
 * Pessoas por defeito (decisão do utilizador, 2026-11-09): cliente particular ou tipologia
 * T2 ou maior = 2 pessoas; valor posto à mão pelo gestor fica; Smoobu dá a tipologia.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario, auth } = require('./helpersLote');
const { staffPorDefeito, staffManual, decidirPessoas } = require('../utils/pessoasCasa');
const { idsEquipa } = require('../utils/equipaTarefa');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test('regra: particular ou T2+ = 2; T0/T1/desconhecida = 1; valor à mão fica', () => {
  expect(staffPorDefeito({ tipologia: null })).toBe(1);
  expect(staffPorDefeito({ tipologia: 1 })).toBe(1);
  expect(staffPorDefeito({ tipologia: 2 })).toBe(2);
  expect(staffPorDefeito({ tipologia: 5 })).toBe(2);
  expect(staffPorDefeito({ tipologia: 0, cliente_particular: true })).toBe(2);
  // Casas antigas sem marca: 2 conta como manual, 1 não.
  expect(staffManual({ staff_necessario: 2 })).toBe(true);
  expect(staffManual({ staff_necessario: 1 })).toBe(false);
  expect(decidirPessoas({ tipologia: 3, staff_necessario: 1 }, undefined)).toEqual({ staff_necessario: 2, staff_necessario_manual: false });
  expect(decidirPessoas({ tipologia: 3, staff_necessario: 3, staff_necessario_manual: true }, undefined)).toEqual({ staff_necessario: 3, staff_necessario_manual: true });
  expect(decidirPessoas({ tipologia: 3 }, 1)).toEqual({ staff_necessario: 1, staff_necessario_manual: true });
  expect(decidirPessoas({ tipologia: 3 }, 2)).toEqual({ staff_necessario: 2, staff_necessario_manual: false });
});

test('criar casa: T2 sem pessoas indicadas leva 2; particular leva 2; T1 leva 1; tipologia inválida dá 400', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const criar = (corpo) => request(app).post('/api/gestor/propriedades').set(auth(c.token)).send({ morada: 'Rua A 1, Lisboa', ...corpo });
  const t2 = await criar({ nome: 'T2', tipologia: 2 });
  expect(t2.status).toBe(201);
  expect(t2.body.propriedade.staff_necessario).toBe(2);
  expect((await criar({ nome: 'Part', tipologia: 1, cliente_particular: true })).body.propriedade.staff_necessario).toBe(2);
  expect((await criar({ nome: 'T1', tipologia: 1 })).body.propriedade.staff_necessario).toBe(1);
  // O ecrã envia sempre as pessoas: 1 numa T3 fica 1 (posto à mão).
  const mao = await criar({ nome: 'T3 a mao', tipologia: 3, staff_necessario: 1 });
  expect(mao.body.propriedade.staff_necessario).toBe(1);
  expect(mao.body.propriedade.staff_necessario_manual).toBe(true);
  expect((await criar({ nome: 'X', tipologia: 'T2' })).status).toBe(400);
  expect((await criar({ nome: 'Y', cliente_particular: 'sim' })).status).toBe(400);
});

test('editar: mudar para T2 sem tocar nas pessoas passa a 2 e as limpezas por começar ganham a 2.ª pessoa', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const t = await c.tarefa('2035-09-04', { equipa_atribuida: [c.ana._id] });
  const put = (corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);

  const r = await put({ tipologia: 2 });
  expect(r.status).toBe(200);
  expect(r.body.propriedade.tipologia).toBe(2);
  expect(r.body.propriedade.staff_necessario).toBe(2);
  expect(idsEquipa(await Tarefa.findById(t._id).lean())).toHaveLength(2);

  // O gestor põe 1 à mão: fica 1, e voltar a mexer na tipologia já não lhe toca.
  expect((await put({ staff_necessario: 1 })).body.propriedade.staff_necessario).toBe(1);
  expect((await put({ tipologia: 4 })).body.propriedade.staff_necessario).toBe(1);
  // Cliente particular também não mexe num valor manual.
  expect((await put({ cliente_particular: true })).body.propriedade.staff_necessario).toBe(1);
  // Pôr o valor da regra tira a marca de manual.
  const de = await put({ staff_necessario: 2 });
  expect(de.body.propriedade.staff_necessario_manual).toBe(false);
});

test('casa antiga com 2 pessoas e sem tipologia não desce para 1 ao editar outro campo', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  await Propriedade.collection.updateOne({ _id: c.p._id }, { $unset: { staff_necessario_manual: '' } });
  const r = await request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send({ tipologia: 1 });
  expect(r.status).toBe(200);
  expect(r.body.propriedade.staff_necessario).toBe(2);
});

describe('importar do Smoobu: tipologia pelo nº de quartos', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => { global.fetch = fetchOriginal; delete process.env.SMOOBU_API_KEY; });

  test('casa nova T2 leva 2 pessoas; existente sem tipologia ganha-a; tipologia já posta não muda', async () => {
    const c = await cenario(app, { extra: 0, sn: 1 });
    process.env.SMOOBU_API_KEY = 'chave-teste';
    const casaExistente = await Propriedade.create({ nome: 'Exist', empresa_id: c.e._id, smoobu_id: '9001', ativo: true, morada: 'Rua B 2, Lisboa', tempo_limpeza_minutos: 60 });
    const casaComTipo = await Propriedade.create({ nome: 'ComTipo', empresa_id: c.e._id, smoobu_id: '9002', ativo: true, morada: 'Rua C 3, Lisboa', tempo_limpeza_minutos: 60, tipologia: 1 });
    const quartos = { 9001: 3, 9002: 4, 9003: 2 };
    const pedidos = [];
    global.fetch = jest.fn(async (url) => {
      const u = String(url);
      pedidos.push(u);
      const m = u.match(/\/api\/apartments\/(\d+)/);
      const corpo = m
        ? { id: Number(m[1]), rooms: { bedrooms: quartos[m[1]], maxOccupancy: 4 } }
        : { apartments: [{ id: 9001, name: 'Exist' }, { id: 9002, name: 'ComTipo' }, { id: 9003, name: 'Nova T2' }] };
      return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) };
    });

    const r = await request(app).post('/api/gestor/smoobu/propriedades').set(auth(c.token)).send({});
    expect(r.status).toBe(200);
    const nova = await Propriedade.findOne({ empresa_id: c.e._id, smoobu_id: '9003' }).lean();
    expect(nova.tipologia).toBe(2);
    expect(nova.staff_necessario).toBe(2);
    const ex = await Propriedade.findById(casaExistente._id).lean();
    expect(ex.tipologia).toBe(3);
    expect(ex.staff_necessario).toBe(2);
    const ct = await Propriedade.findById(casaComTipo._id).lean();
    expect(ct.tipologia).toBe(1);
    expect(ct.staff_necessario).toBe(1);
    // A casa que já tinha tipologia não gasta pedido de detalhe.
    expect(pedidos.some((u) => /apartments\/9002/.test(u))).toBe(false);
  });
});
