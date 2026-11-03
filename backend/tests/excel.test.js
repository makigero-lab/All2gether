/**
 * Testes de importação/exportação Excel (gestor e parceiro).
 * Usa .xlsx REAL enviado como body cru (como faz o frontend), para garantir
 * que o parser raw está montado e que datas/duplicados/isolamento funcionam.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PASSWORD = 'teste123';

let mongod;
let empresa;
let outraEmpresa;
let gestorToken;
let staffToken;
let parceiroToken;
let parceiro;
let outroParceiro;
let casaGestor;
let casaParceiro;
let casaOutroParceiro;
let casaOutraEmpresa;

async function xlsxBuffer(linhas) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reservas');
  const cols = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  ws.addRow(cols);
  for (const l of linhas) ws.addRow(cols.map((c) => (l[c] === undefined ? null : l[c])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function lerXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const cab = ws.getRow(1).values.slice(1);
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const vals = row.values.slice(1);
    out.push(Object.fromEntries(cab.map((c, i) => [c, vals[i] ?? ''])));
  });
  return out;
}

function importar(url, token, buffer, contentType = MIME) {
  return request(app)
    .post(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', contentType)
    .send(buffer);
}

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  empresa = await Empresa.create({ nome: 'Empresa Excel' });
  outraEmpresa = await Empresa.create({ nome: 'Outra Empresa' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role, emp = empresa) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: emp._id, role, ativo: true });

  await mk('Gestor', 'gestor@x.pt', 'gestor');
  await mk('Staff', 'staff@x.pt', 'staff');
  parceiro = await mk('Parceiro', 'parceiro@x.pt', 'parceiro');
  outroParceiro = await mk('Outro Parceiro', 'parceiro2@x.pt', 'parceiro');

  casaGestor = await Propriedade.create({ nome: 'Casa Gestor', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 4 });
  casaParceiro = await Propriedade.create({ nome: 'Casa Parceiro', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 6, parceiro_id: parceiro._id });
  casaOutroParceiro = await Propriedade.create({ nome: 'Casa Do Outro', empresa_id: empresa._id, ativo: true, parceiro_id: outroParceiro._id });
  casaOutraEmpresa = await Propriedade.create({ nome: 'Casa Alheia', empresa_id: outraEmpresa._id, ativo: true });

  gestorToken = await login('gestor@x.pt');
  staffToken = await login('staff@x.pt');
  parceiroToken = await login('parceiro@x.pt');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Importação Excel — gestor', () => {
  const URL = '/api/gestor/reservas/importar-excel';

  it('importa um .xlsx real enviado como body cru e aplica fallback de hóspedes', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'casa gestor', 'Check-in': '08/06/2030', 'Check-out': '10/06/2030', 'Hóspedes': '' },
    ]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(1);
    const t = await Tarefa.findOne({ propriedade_id: casaGestor._id });
    expect(t.hospedes).toBe(4); // capacidade da propriedade
    expect(t.detalhes_reserva.checkout).toBe('2030-06-10');
    expect(t.detalhes_reserva.checkin).toBe('2030-06-08');
  });

  it('é idempotente: re-importar o mesmo ficheiro ignora duplicados', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Gestor', 'Check-out': '10/06/2030' }]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(0);
    expect(res.body.ignoradas).toBe(1);
  });

  it('uma tarefa de manutenção no mesmo dia NÃO bloqueia a limpeza', async () => {
    await Tarefa.create({
      empresa_id: empresa._id, propriedade_id: casaGestor._id, origem: 'manual',
      data: new Date(Date.UTC(2030, 6, 15, 10)), tipo: 'manutencao', estado: 'por_atribuir',
      tempo_limpeza_minutos: 30,
    });
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Gestor', 'Check-out': '15/07/2030' }]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(1);
  });

  it('aceita número serial do Excel como data', async () => {
    // 47000 = 2028-09-... ; calculamos o esperado.
    const serial = 47300;
    const esperado = new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Gestor', 'Check-out': serial }]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(1);
    const t = await Tarefa.findOne({ 'detalhes_reserva.checkout': esperado });
    expect(t).not.toBeNull();
  });

  it('aceita células de data reais do Excel (tipo Date)', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Gestor', 'Check-in': new Date(Date.UTC(2031, 0, 3)), 'Check-out': new Date(Date.UTC(2031, 0, 5)) },
    ]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(1);
    const t = await Tarefa.findOne({ 'detalhes_reserva.checkout': '2031-01-05' });
    expect(t).not.toBeNull();
    expect(t.detalhes_reserva.checkin).toBe('2031-01-03');
  });

  it('rejeita datas impossíveis (31/02 e 32/13) como erro de linha', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Gestor', 'Check-out': '31/02/2030' },
      { Propriedade: 'Casa Gestor', 'Check-out': '32/13/2030' },
    ]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(0);
    expect(res.body.erros).toBe(2);
  });

  it('não encontra propriedades de outra empresa', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Alheia', 'Check-out': '01/08/2030' }]);
    const res = await importar(URL, gestorToken, buf);
    expect(res.body.criadas).toBe(0);
    expect(res.body.erros).toBe(1);
    expect(await Tarefa.countDocuments({ propriedade_id: casaOutraEmpresa._id })).toBe(0);
  });

  it('rejeita ficheiro que não é xlsx (400) e body vazio (400)', async () => {
    const lixo = await importar(URL, gestorToken, Buffer.from('isto nao e um xlsx'));
    expect(lixo.status).toBe(400);
    const vazio = await request(app).post(URL).set('Authorization', `Bearer ${gestorToken}`).send({});
    expect(vazio.status).toBe(400);
  });

  it('staff e parceiro não podem usar a importação do gestor (403)', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Gestor', 'Check-out': '01/09/2030' }]);
    expect((await importar(URL, staffToken, buf)).status).toBe(403);
    expect((await importar(URL, parceiroToken, buf)).status).toBe(403);
  });
});

describe('Importação Excel — parceiro (isolamento)', () => {
  const URL = '/api/parceiro/reservas/importar-excel';

  it('cria reservas nas suas casas com origem_parceiro=true', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Parceiro', 'Check-out': '20/06/2030', 'Hóspedes': 3 }]);
    const res = await importar(URL, parceiroToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(1);
    const t = await Tarefa.findOne({ propriedade_id: casaParceiro._id });
    expect(t.origem_parceiro).toBe(true);
    expect(t.hospedes).toBe(3);
  });

  it('NÃO cria reservas em casas de outro parceiro nem do gestor', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Do Outro', 'Check-out': '21/06/2030' },
      { Propriedade: 'Casa Gestor', 'Check-out': '22/06/2030' },
    ]);
    const res = await importar(URL, parceiroToken, buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(0);
    expect(res.body.erros).toBe(2);
    expect(await Tarefa.countDocuments({ propriedade_id: casaOutroParceiro._id })).toBe(0);
  });

  it('staff não acede (403)', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Parceiro', 'Check-out': '23/06/2030' }]);
    expect((await importar(URL, staffToken, buf)).status).toBe(403);
  });
});

describe('Exportação Excel', () => {
  const binario = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('gestor exporta um .xlsx válido que pode ser re-importado (round-trip de datas)', async () => {
    const res = await request(app)
      .get('/api/gestor/reservas/exportar-excel')
      .set('Authorization', `Bearer ${gestorToken}`)
      .buffer(true)
      .parse(binario);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.body[0]).toBe(0x50); // 'P' de PK
    const linhas = await lerXlsx(res.body);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.some((l) => /^\d{2}\/\d{2}\/\d{4}$/.test(l['Data']))).toBe(true);
  });

  it('parceiro só exporta as suas propriedades', async () => {
    const res = await request(app)
      .get('/api/parceiro/reservas/exportar-excel')
      .set('Authorization', `Bearer ${parceiroToken}`)
      .buffer(true)
      .parse(binario);
    expect(res.status).toBe(200);
    const linhas = await lerXlsx(res.body);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => l['Propriedade'] === 'Casa Parceiro')).toBe(true);
  });
});
