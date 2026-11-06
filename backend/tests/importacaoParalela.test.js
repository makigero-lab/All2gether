/** B2: importações simultâneas não duplicam (lock por empresa com expiração). */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const ExcelJS = require('exceljs');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');
const { cenario, auth } = require('./helpersLote');
const { obterLock, libertarLock, LockEmpresa } = require('../utils/lockEmpresa');

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

async function xlsx(linhas) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('R');
  ws.addRow(['Propriedade', 'Check-out']); for (const l of linhas) ws.addRow(l);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('B2 quatro importações em paralelo do mesmo ficheiro criam cada limpeza UMA vez', async () => {
  const c = await cenario(app, { extra: 2 });
  const buf = await xlsx([[c.p.nome, '10/06/2036'], [c.p.nome, '11/06/2036']]);
  const post = () => request(app).post('/api/gestor/reservas/importar-excel').set(auth(c.token)).set('Content-Type', MIME).send(buf);
  const rs = await Promise.all([post(), post(), post(), post()]);
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(rs.reduce((a, r) => a + r.body.criadas, 0)).toBe(2);
  expect(await Tarefa.countDocuments({ empresa_id: c.e._id, tipo: 'limpeza' })).toBe(2);
  expect(await ReservaManual.countDocuments({ empresa_id: c.e._id })).toBe(2);
});

test('B2 lock: um segundo pedido espera; um lock expirado é tomado; o libertado fica livre', async () => {
  const k = 'import:teste-lock';
  const a = await obterLock(k, { ttlMs: 60000, esperaMs: 0 });
  expect(a).toBeTruthy();
  expect(await obterLock(k, { ttlMs: 60000, esperaMs: 300, passoMs: 50 })).toBeNull();
  await libertarLock(k, a);
  const b = await obterLock(k, { ttlMs: 60000, esperaMs: 0 });
  expect(b).toBeTruthy();
  await LockEmpresa.updateOne({ _id: k }, { $set: { expira_em: new Date(Date.now() - 1000) } });
  expect(await obterLock(k, { ttlMs: 60000, esperaMs: 0 })).toBeTruthy(); // expirado: toma
  await libertarLock(k, b); // dono errado não liberta
  expect(await obterLock(k, { ttlMs: 60000, esperaMs: 0 })).toBeNull();
});
