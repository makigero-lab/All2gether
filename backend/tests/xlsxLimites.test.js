/** B9: o limite do xlsx é verificado antes de descomprimir/carregar. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
const app = require('../server');
const { cenario, auth } = require('./helpersLote');
const { verificarTamanhoXlsx } = require('../utils/xlsxLimites');

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

async function zipBomba(mb) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('xl/worksheets/sheet1.xml', Buffer.alloc(mb * 1024 * 1024, 0x61)); // comprime para poucos KB
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('B9 zip que descomprime para 40 MB é recusado sem carregar o ExcelJS (rápido e sem memória)', async () => {
  const buf = await zipBomba(40);
  expect(buf.length).toBeLessThan(200 * 1024);
  expect(verificarTamanhoXlsx(buf)).toMatchObject({ ok: false, motivo: 'grande', causa: 'linhas' });
  const c = await cenario(app);
  const mem0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = await request(app).post('/api/gestor/reservas/importar-excel').set(auth(c.token)).set('Content-Type', MIME).send(buf);
  const ms = Date.now() - t0;
  const dMB = (process.memoryUsage().rss - mem0) / 1048576;
  process.stdout.write(`MEDICAO B9 bomba 40MB (zip ${buf.length} B): status ${r.status} em ${ms} ms, rss +${dMB.toFixed(0)} MB\n`);
  expect(r.status).toBe(400);
  expect(r.body.erro).toMatch(/demasiado grande/);
  expect(ms).toBeLessThan(2000);
});

test('B9 um xlsx normal continua a ser aceite', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('R');
  ws.addRow(['Propriedade', 'Check-out']); for (let i = 0; i < 1500; i++) ws.addRow(['X' + i, '10/06/2036']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  expect(verificarTamanhoXlsx(buf).ok).toBe(true);
});

async function zipComEntrada(nome, mb) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file(nome, Buffer.alloc(mb * 1024 * 1024, 0x61));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('item 7: styles.xml enorme e total acima de 30 MB têm mensagem própria (formatação)', async () => {
  const c = await cenario(app);
  const buf = await zipComEntrada('xl/styles.xml', 25);
  expect(verificarTamanhoXlsx(buf)).toMatchObject({ ok: false, causa: 'formatacao' });
  const r = await request(app).post('/api/gestor/reservas/importar-excel').set(auth(c.token)).set('Content-Type', MIME).send(buf);
  expect(r.status).toBe(400);
  expect(r.body.erro).toMatch(/demasiada formatação/);
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('xl/styles.xml', Buffer.alloc(15 * 1024 * 1024, 0x61));
  z.file('xl/worksheets/sheet1.xml', Buffer.alloc(18 * 1024 * 1024, 0x61));
  const total = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  expect(verificarTamanhoXlsx(total)).toMatchObject({ ok: false, causa: 'total' });
});

test('item 7: ficheiro acima de 5 MB devolve 413 em português com o limite e o que fazer', async () => {
  const c = await cenario(app);
  const r = await request(app).post('/api/gestor/reservas/importar-excel').set(auth(c.token)).set('Content-Type', MIME).send(Buffer.alloc(6 * 1024 * 1024, 0x50));
  expect(r.status).toBe(413);
  expect(r.body.erro).toMatch(/5 MB/);
  expect(r.body.erro).not.toMatch(/entity/i);
});
