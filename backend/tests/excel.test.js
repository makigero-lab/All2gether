/**
 * Testes de importação (gestor) e exportação (gestor e parceiro) de Excel.
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

describe('Importação Excel — rota retirada', () => {
  it('as rotas de importação (gestor e parceiro) já não existem: 404 para todos e nada é criado', async () => {
    const buf = await xlsxBuffer([{ Propriedade: 'Casa Parceiro', 'Check-out': '20/06/2030', 'Hóspedes': 3 }]);
    for (const url of ['/api/gestor/reservas/importar-excel', '/api/parceiro/reservas/importar-excel']) {
      for (const tk of [parceiroToken, staffToken, gestorToken]) {
        expect((await importar(url, tk, buf)).status).toBe(404);
      }
    }
    expect(await Tarefa.countDocuments({})).toBe(0);
  });
});

describe('Exportação Excel', () => {
  const binario = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('gestor exporta um .xlsx válido com datas dd/mm/aaaa', async () => {
    await Tarefa.create({
      empresa_id: empresa._id, propriedade_id: casaGestor._id, origem: 'manual', tipo: 'limpeza',
      data: new Date(Date.UTC(2030, 8, 9, 10)), estado: 'por_atribuir', tempo_limpeza_minutos: 30,
    });
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
    // Reservas de duas casas: o export do parceiro só traz a dele.
    for (const casa of [casaParceiro, casaOutroParceiro]) {
      await Tarefa.create({
        empresa_id: empresa._id, propriedade_id: casa._id, origem: 'manual', tipo: 'limpeza',
        data: new Date(Date.UTC(2030, 8, 10, 10)), estado: 'por_atribuir', tempo_limpeza_minutos: 30,
      });
    }
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
