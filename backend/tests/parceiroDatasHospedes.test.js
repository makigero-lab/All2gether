/**
 * Parceiro: hóspedes inválidos dão 400 (B3), datas absurdas dão 400 e a edição de notas de
 * reservas antigas não é bloqueada (B4), e o Excel do parceiro traz o tipo de limpeza (B6).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const ReservaManual = require('../models/ReservaManual');
const { validarDatas } = require('../controllers/parceiroController');

let mongod;
let token;
let casa;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const ymd = (d) => d.toISOString().slice(0, 10);
const emDias = (n) => ymd(new Date(Date.now() + n * 86400000));

beforeAll(async () => {
  // Neste ficheiro os limites de datas valem a sério (o setup global desliga-os).
  process.env.DATAS_SEM_LIMITES = '0';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const empresa = await Empresa.create({ nome: 'Empresa DH' });
  const hash = await bcrypt.hash('teste123', 10);
  const parceiro = await Utilizador.create({ nome: 'Par', email: 'dh@x.pt', password_hash: hash, empresa_id: empresa._id, role: 'parceiro', ativo: true });
  casa = await Propriedade.create({ nome: 'Casa DH', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 5, parceiro_id: parceiro._id });
  token = (await request(app).post('/api/auth/login').send({ email: 'dh@x.pt', password: 'teste123' })).body.token;
});
afterAll(async () => {
  process.env.DATAS_SEM_LIMITES = '1';
  await mongoose.disconnect();
  await mongod.stop();
});

const criar = (extra = {}) =>
  request(app).post('/api/parceiro/reservas').set(auth(token)).send({
    propriedade_id: String(casa._id), check_in: emDias(30), check_out: emDias(32), hospedes: 2, ...extra,
  });

describe('B3: hóspedes inválidos', () => {
  test.each([[-1], [-5], ['abc']])('hospedes=%p dá 400 (não 500)', async (h) => {
    const r = await criar({ hospedes: h });
    expect(r.status).toBe(400);
    expect(r.body.erro).toMatch(/hóspedes/i);
  });

  test('hospedes válido e vazio continuam a funcionar (vazio usa a capacidade)', async () => {
    expect((await criar({ check_in: emDias(40), check_out: emDias(41), hospedes: 3 })).status).toBe(201);
    const v = await criar({ check_in: emDias(50), check_out: emDias(51), hospedes: '' });
    expect(v.status).toBe(201);
    expect(v.body.reserva.hospedes).toBe(5);
  });
});

describe('B4: limites das datas', () => {
  const agora = new Date('2026-11-06T12:00:00Z');
  test('validarDatas: aceita dentro de -2/+3 anos e até 365 noites', () => {
    expect(validarDatas('2025-01-01', '2025-01-05', { agora })).toBeNull();
    expect(validarDatas('2029-11-01', '2029-11-03', { agora })).toBeNull();
    expect(validarDatas('2027-01-01', '2028-01-01', { agora })).toBeNull(); // 365 noites
  });

  test('validarDatas: recusa 0001-01-01, 9999-12-31, fora de janela e estadias > 365 noites', () => {
    expect(validarDatas('0001-01-01', '0001-01-03', { agora })).toMatch(/entre/);
    expect(validarDatas('9999-12-29', '9999-12-31', { agora })).toMatch(/entre/);
    expect(validarDatas('2024-10-01', '2024-10-03', { agora })).toMatch(/entre/); // há mais de 2 anos
    expect(validarDatas('2029-12-01', '2029-12-03', { agora })).toMatch(/entre/); // a mais de 3 anos
    expect(validarDatas('2027-01-01', '2028-01-02', { agora })).toMatch(/365 noites/);
    expect(validarDatas('2027-01-05', '2027-01-01', { agora })).toMatch(/anterior/);
  });

  test('POST com 0001-01-01 e 9999-12-31 dá 400', async () => {
    expect((await criar({ check_in: '0001-01-01', check_out: '0001-01-03' })).status).toBe(400);
    expect((await criar({ check_in: '9999-12-29', check_out: '9999-12-31' })).status).toBe(400);
  });

  test('reserva antiga: editar só as notas não é bloqueado; mudar para data absurda é', async () => {
    const antiga = await ReservaManual.create({
      propriedade_id: casa._id, parceiro_id: casa.parceiro_id, empresa_id: casa.empresa_id,
      check_in: new Date('2020-01-01T00:00:00Z'), check_out: new Date('2020-01-03T00:00:00Z'), hospedes: 2,
    });
    const ok = await request(app).put(`/api/parceiro/reservas/${antiga._id}`).set(auth(token)).send({ observacoes: 'nota nova' });
    expect(ok.status).toBe(200);
    const mal = await request(app).put(`/api/parceiro/reservas/${antiga._id}`).set(auth(token)).send({ check_in: '9999-12-29', check_out: '9999-12-31' });
    expect(mal.status).toBe(400);
  });
});

describe('B6: Excel do parceiro', () => {
  test('traz a coluna «Tipo de limpeza»', async () => {
    const ExcelJS = require('exceljs');
    expect((await criar({ check_in: emDias(60), check_out: emDias(62), tipo_limpeza: 'profunda' })).status).toBe(201);
    const res = await request(app).get('/api/parceiro/reservas/exportar-excel').set(auth(token)).buffer(true)
      .parse((r, cb) => { const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    const cab = ws.getRow(1).values.map((v) => String(v || ''));
    expect(cab).toContain('Tipo de limpeza');
    const col = cab.indexOf('Tipo de limpeza');
    const valores = [];
    ws.eachRow((row, i) => { if (i > 1) valores.push(String(row.values[col])); });
    expect(valores.some((v) => /profunda/i.test(v))).toBe(true);
  });
});
