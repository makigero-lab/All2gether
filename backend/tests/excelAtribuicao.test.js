/**
 * Importação de Excel automática: atribui com o motor partilhado, não duplica ao
 * reimportar, avisa uma vez por pessoa/gestor e não bloqueia em ficheiros grandes.
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
const Ausencia = require('../models/Ausencia');
const Notificacao = require('../models/Notificacao');

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PASSWORD = 'teste123';
const URL = '/api/gestor/reservas/importar-excel';

let mongod;
let empresa;
let gestor;
let staffA;
let staffB;
let gestorToken;
let casa;
let casaDupla;

async function xlsxBuffer(linhas) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reservas');
  const cols = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  ws.addRow(cols);
  for (const l of linhas) ws.addRow(cols.map((c) => (l[c] === undefined ? null : l[c])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function importar(buffer) {
  return request(app)
    .post(URL)
    .set('Authorization', `Bearer ${gestorToken}`)
    .set('Content-Type', MIME)
    .send(buffer);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  empresa = await Empresa.create({ nome: 'Empresa Excel Auto' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true });
  gestor = await mk('Gestor', 'gestor@auto.pt', 'gestor');
  staffA = await mk('Ana', 'ana@auto.pt', 'staff');
  staffB = await mk('Bruno', 'bruno@auto.pt', 'staff');
  casa = await Propriedade.create({
    nome: 'Casa Solo', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 30,
  });
  casaDupla = await Propriedade.create({
    nome: 'Casa Dupla', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 8,
    tempo_limpeza_minutos: 30, staff_necessario: 2,
  });
  const res = await request(app).post('/api/auth/login').send({ email: 'gestor@auto.pt', password: PASSWORD });
  gestorToken = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Importação Excel — atribuição automática', () => {
  it('atribui as tarefas criadas e respeita staff_necessario', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Solo', 'Check-out': '10/06/2032' },
      { Propriedade: 'Casa Dupla', 'Check-out': '10/06/2032' },
    ]);
    const res = await importar(buf);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(2);
    expect(res.body.atribuidas).toBe(2);
    expect(res.body.porAtribuir).toBe(0);

    const solo = await Tarefa.findOne({ propriedade_id: casa._id });
    expect(solo.estado).toBe('atribuida');
    expect(solo.utilizador_id).toBeTruthy();
    expect(solo.motivo_nao_atribuicao).toBeNull();

    const dupla = await Tarefa.findOne({ propriedade_id: casaDupla._id });
    expect(dupla.estado).toBe('atribuida');
    expect(dupla.equipa_atribuida.map(String).sort()).toEqual([String(staffA._id), String(staffB._id)].sort());
    expect(new Set(dupla.equipa_atribuida.map(String)).size).toBe(2);
  });

  it('reimportar o mesmo ficheiro (já atribuído, hora alterada) não duplica', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Solo', 'Check-out': '10/06/2032' },
      { Propriedade: 'Casa Dupla', 'Check-out': '10/06/2032' },
    ]);
    const res = await importar(buf);
    expect(res.body.criadas).toBe(0);
    expect(res.body.ignoradas).toBe(2);
    expect(await Tarefa.countDocuments({ propriedade_id: casa._id, tipo: 'limpeza' })).toBe(1);
  });

  it('a mesma casa e dia repetidos dentro do ficheiro só criam uma tarefa', async () => {
    const buf = await xlsxBuffer([
      { Propriedade: 'Casa Solo', 'Check-out': '11/06/2032' },
      { Propriedade: 'Casa Solo', 'Check-out': '11/06/2032' },
    ]);
    const res = await importar(buf);
    expect(res.body.criadas).toBe(1);
    expect(res.body.ignoradas).toBe(1);
  });

  it('uma notificação por pessoa, não uma por tarefa', async () => {
    const dias = [];
    for (let d = 1; d <= 6; d++) dias.push({ Propriedade: 'Casa Solo', 'Check-out': `${String(d).padStart(2, '0')}/07/2032` });
    await Notificacao.deleteMany({});
    const res = await importar(await xlsxBuffer(dias));
    expect(res.body.atribuidas).toBe(6);
    const notifs = await Notificacao.find({ tipo: 'tarefa_atribuida' }).lean();
    const porPessoa = {};
    for (const n of notifs) porPessoa[String(n.utilizador_id)] = (porPessoa[String(n.utilizador_id)] || 0) + 1;
    expect(Object.values(porPessoa).every((v) => v === 1)).toBe(true);
    expect(notifs.length).toBeLessThanOrEqual(2);
  });

  it('sem ninguém disponível: por atribuir, motivo de ausência (não lotação) e gestor avisado uma vez', async () => {
    const inicio = new Date(Date.UTC(2032, 8, 1));
    const fim = new Date(Date.UTC(2032, 8, 30));
    for (const s of [staffA, staffB]) {
      await Ausencia.create({
        utilizador_id: s._id, empresa_id: empresa._id, tipo: 'ferias',
        data_inicio: inicio, data_fim: fim, estado: 'aprovada',
      });
    }
    await Notificacao.deleteMany({});
    const linhas = [];
    for (let d = 5; d <= 8; d++) linhas.push({ Propriedade: 'Casa Solo', 'Check-out': `0${d}/09/2032` });
    const res = await importar(await xlsxBuffer(linhas));
    expect(res.body.criadas).toBe(4);
    expect(res.body.atribuidas).toBe(0);
    expect(res.body.porAtribuir).toBe(4);
    expect(res.body.detalheNaoAtribuidas).toHaveLength(4);

    const ts = await Tarefa.find({ 'detalhes_reserva.checkout': /^2032-09-0[5-8]$/ }).lean();
    expect(ts).toHaveLength(4);
    for (const t of ts) {
      expect(t.estado).toBe('por_atribuir');
      expect(t.motivo_nao_atribuicao).toMatch(/ausente, de folga/);
      expect(t.motivo_nao_atribuicao).not.toMatch(/horário/);
    }
    const avisos = await Notificacao.find({ utilizador_id: gestor._id }).lean();
    expect(avisos).toHaveLength(1);
    await Ausencia.deleteMany({});
  });

  it('200 linhas não bloqueiam o pedido e ficam todas atribuídas (tempo medido)', async () => {
    const linhas = [];
    const base = Date.UTC(2033, 0, 1);
    for (let i = 0; i < 200; i++) {
      const d = new Date(base + i * 86400000);
      const dd = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      linhas.push({ Propriedade: 'Casa Solo', 'Check-out': dd });
    }
    const buf = await xlsxBuffer(linhas);
    const t0 = Date.now();
    const res = await importar(buf);
    const ms = Date.now() - t0;
    console.log(`[medição] importação de 200 linhas com atribuição: ${ms} ms`);
    expect(res.status).toBe(200);
    expect(res.body.criadas).toBe(200);
    expect(res.body.atribuidas + res.body.porAtribuir).toBe(200);
    expect(ms).toBeLessThan(60000);
  }, 120000);

  it('se a atribuição demorar, responde já e conclui em segundo plano', async () => {
    process.env.IMPORT_ORCAMENTO_ATRIBUICAO_MS = '1';
    try {
      const linhas = [];
      const base = Date.UTC(2034, 0, 1);
      for (let i = 0; i < 12; i++) {
        const d = new Date(base + i * 86400000);
        linhas.push({
          Propriedade: 'Casa Solo',
          'Check-out': `${String(d.getUTCDate()).padStart(2, '0')}/01/2034`,
        });
      }
      const res = await importar(await xlsxBuffer(linhas));
      expect(res.body.criadas).toBe(12);
      expect(res.body.emSegundoPlano).toBeGreaterThan(0);
      for (let i = 0; i < 100; i++) {
        const por = await Tarefa.countDocuments({ 'detalhes_reserva.checkout': /^2034-01/, estado: 'por_atribuir' });
        if (por === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await Tarefa.countDocuments({ 'detalhes_reserva.checkout': /^2034-01/, estado: 'atribuida' })).toBe(12);
    } finally {
      delete process.env.IMPORT_ORCAMENTO_ATRIBUICAO_MS;
    }
  }, 60000);
});
