/**
 * Tipos de limpeza (normal, intermedia, profunda, preparacao): data, tempo, checklist,
 * recurso à checklist da casa, validações, alterar tipo/datas, duplicados, importação do
 * gestor (coluna Tipo) e compatibilidade (sem o campo = normal).
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
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const {
  normalizarTipo, tempoDoTipo, checklistDoTipo, diaAutomatico, resolverDiaLimpeza, lerConfigTipos,
} = require('../utils/tipoLimpeza');

const PASSWORD = 'teste123';
let mongod;
let empresa;
let parceiroToken;
let gestorToken;
let casa;
let casaSimples;
let n = 0;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function xlsx(linhas) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reservas');
  const cols = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  ws.addRow(cols);
  for (const l of linhas) ws.addRow(cols.map((c) => (l[c] === undefined ? null : l[c])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Cada teste usa um mês/ano próprio para não colidir com limpezas dos outros.
const reservar = (corpo, propriedade = casa) =>
  request(app).post('/api/parceiro/reservas').set(auth(parceiroToken)).send({
    propriedade_id: String(propriedade._id), hospedes: 2, ...corpo,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  empresa = await Empresa.create({ nome: 'Empresa Tipos' });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = (nome, email, role) =>
    Utilizador.create({ nome, email, password_hash: hash, empresa_id: empresa._id, role, ativo: true, dias_folga: [] });
  const parceiro = await mk('Parceiro', 'p@tipos.pt', 'parceiro');
  await mk('Gestor', 'g@tipos.pt', 'gestor');
  await mk('Ana', 'a@tipos.pt', 'staff');
  casa = await Propriedade.create({
    nome: 'Casa Tipos', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 4,
    parceiro_id: parceiro._id, tempo_limpeza_minutos: 60,
    checklist: ['Item da casa'],
    tempos_limpeza_por_tipo: { intermedia: 30, profunda: 150 },
    checklists_por_tipo: { profunda: ['Frigorífico', 'Janelas'] },
  });
  casaSimples = await Propriedade.create({
    nome: 'Casa Simples', empresa_id: empresa._id, ativo: true, capacidade_hospedes: 4,
    parceiro_id: parceiro._id, tempo_limpeza_minutos: 50, checklist: ['Só da casa'],
  });
  parceiroToken = (await request(app).post('/api/auth/login').send({ email: 'p@tipos.pt', password: PASSWORD })).body.token;
  gestorToken = (await request(app).post('/api/auth/login').send({ email: 'g@tipos.pt', password: PASSWORD })).body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('utilitários do tipo', () => {
  it('normalizarTipo: vazio = normal, aceita rótulos, inválido falha fechado', () => {
    expect(normalizarTipo(undefined)).toEqual({ ok: true, tipo: 'normal' });
    expect(normalizarTipo('')).toEqual({ ok: true, tipo: 'normal' });
    expect(normalizarTipo('Intermédia')).toEqual({ ok: true, tipo: 'intermedia' });
    expect(normalizarTipo(' PREPARAÇÃO ')).toEqual({ ok: true, tipo: 'preparacao' });
    for (const mau of ['luxo', 5, {}, [], true, 'normal;']) expect(normalizarTipo(mau).ok).toBe(false);
  });
  it('tempo e checklist: do tipo ou o da casa', () => {
    expect(tempoDoTipo(casa.toObject(), 'normal')).toBe(60);
    expect(tempoDoTipo(casa.toObject(), 'intermedia')).toBe(30);
    expect(tempoDoTipo(casa.toObject(), 'preparacao')).toBe(60); // sem tempo próprio
    expect(tempoDoTipo(casaSimples.toObject(), 'profunda')).toBe(50);
    expect(checklistDoTipo(casa.toObject(), 'profunda')).toEqual(['Frigorífico', 'Janelas']);
    expect(checklistDoTipo(casa.toObject(), 'intermedia')).toEqual(['Item da casa']);
    expect(checklistDoTipo(casa.toObject(), 'normal')).toEqual(['Item da casa']);
  });
  it('datas: automáticas (normal/profunda no check-out, intermédia a meio, preparação no check-in)', () => {
    const r = (tipo, ci, co, extra = {}) => resolverDiaLimpeza({ tipo, check_in: ci, check_out: co, ...extra });
    expect(r('normal', '2040-05-10', '2040-05-15').dia).toBe('2040-05-15');
    expect(r('profunda', '2040-05-10', '2040-05-15').dia).toBe('2040-05-15');
    expect(r('preparacao', '2040-05-10', '2040-05-15').dia).toBe('2040-05-10');
    // intermédia: check-in + metade das noites (para baixo); 1 noite = check-out
    expect(r('intermedia', '2040-05-10', '2040-05-11').dia).toBe('2040-05-11'); // 1 noite
    expect(r('intermedia', '2040-05-10', '2040-05-12').dia).toBe('2040-05-11'); // 2 noites
    expect(r('intermedia', '2040-05-10', '2040-05-15').dia).toBe('2040-05-12'); // 5 noites
    expect(r('intermedia', '2040-05-10', '2040-05-18').dia).toBe('2040-05-14'); // 8 noites
    expect(diaAutomatico('intermedia', '2040-02-27', '2040-03-04')).toBe('2040-03-01'); // 6 noites, fim de mês
    // data gravada (reserva antiga ou ajustada): vale se ainda é válida para o tipo e a estadia
    expect(r('intermedia', '2040-05-10', '2040-05-15', { data_gravada: new Date('2040-05-13T00:00:00Z') }).dia).toBe('2040-05-13');
    expect(r('intermedia', '2040-05-10', '2040-05-15', { data_gravada: new Date('2040-05-20T00:00:00Z') }).dia).toBe('2040-05-12');
    expect(r('preparacao', '2040-05-10', '2040-05-15', { data_gravada: new Date('2040-05-08T00:00:00Z') }).dia).toBe('2040-05-08');
    expect(r('preparacao', '2040-05-10', '2040-05-15', { data_gravada: new Date('2040-05-11T00:00:00Z') }).dia).toBe('2040-05-10');
    // o campo antigo 'data_limpeza' já não é lido
    expect(r('intermedia', '2040-05-10', '2040-05-15', { data_limpeza: '2040-05-13' }).dia).toBe('2040-05-12');
  });
  it('lerConfigTipos valida tempos e listas', () => {
    expect(lerConfigTipos({}).set).toEqual({});
    expect(lerConfigTipos({ tempos_limpeza_por_tipo: { profunda: 90, intermedia: '' } }).set)
      .toEqual({ 'tempos_limpeza_por_tipo.profunda': 90, 'tempos_limpeza_por_tipo.intermedia': null });
    for (const mau of [{ normal: 30 }, { profunda: 0 }, { profunda: 481 }, { profunda: 'x' }, { profunda: 1.5 }]) {
      expect(lerConfigTipos({ tempos_limpeza_por_tipo: mau }).erro).toBeTruthy();
    }
    expect(lerConfigTipos({ checklists_por_tipo: { profunda: [' a ', '', 'b'] } }).set)
      .toEqual({ 'checklists_por_tipo.profunda': ['a', 'b'] });
    expect(lerConfigTipos({ checklists_por_tipo: { profunda: 'x' } }).erro).toBeTruthy();
    expect(lerConfigTipos({ checklists_por_tipo: { normal: [] } }).erro).toBeTruthy();
  });
});

describe('parceiro: criar reservas por tipo', () => {
  it('sem tipo = normal: check-out, tempo e checklist da casa (nada muda)', async () => {
    const r = await reservar({ check_in: '2041-01-01', check_out: '2041-01-03' });
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tipo_limpeza).toBe('normal');
    expect(t.tempo_limpeza_minutos).toBe(60);
    expect(t.checklist).toEqual(['Item da casa']);
    expect(new Date(t.data).toISOString().slice(0, 10)).toBe('2041-01-03');
    expect(r.body.reserva.tipo_limpeza).toBe('normal');
    expect(r.body.reserva.data_limpeza).toBeNull();
  });

  it('profunda: no check-out, com o tempo e a checklist da profunda', async () => {
    const r = await reservar({ check_in: '2041-02-01', check_out: '2041-02-03', tipo_limpeza: 'profunda' });
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tipo_limpeza).toBe('profunda');
    expect(t.tempo_limpeza_minutos).toBe(150);
    expect(t.checklist).toEqual(['Frigorífico', 'Janelas']);
    expect(t.checklist_do_tipo).toBe(true);
    expect(new Date(t.data).toISOString().slice(0, 10)).toBe('2041-02-03');
    expect(t.estado).toBe('atribuida');
  });

  it('intermédia: a meio da estadia, com o tempo do tipo e checklist da casa (recurso)', async () => {
    const r = await reservar({ check_in: '2041-03-01', check_out: '2041-03-08', tipo_limpeza: 'intermedia' });
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tipo_limpeza).toBe('intermedia');
    expect(t.tempo_limpeza_minutos).toBe(30);
    expect(t.checklist).toEqual(['Item da casa']);
    expect(t.checklist_do_tipo).toBe(false); // recurso à checklist da casa: a frase do staff não promete uma própria
    expect(new Date(t.data).toISOString().slice(0, 10)).toBe('2041-03-04');
    expect(t.detalhes_reserva.checkout).toBe('2041-03-08');
    expect(new Date(r.body.reserva.data_limpeza).toISOString().slice(0, 10)).toBe('2041-03-04');
  });

  it('preparação: no dia do check-in; sem tempo configurado usa o da casa', async () => {
    const r = await reservar({ check_in: '2041-04-10', check_out: '2041-04-12', tipo_limpeza: 'preparacao' });
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tipo_limpeza).toBe('preparacao');
    expect(t.tempo_limpeza_minutos).toBe(60);
    expect(new Date(t.data).toISOString().slice(0, 10)).toBe('2041-04-10');
  });

  it('casa sem configuração por tipo: usa tempo e checklist da casa em todos os tipos', async () => {
    const r = await reservar({ check_in: '2041-05-01', check_out: '2041-05-03', tipo_limpeza: 'profunda' }, casaSimples);
    expect(r.status).toBe(201);
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tempo_limpeza_minutos).toBe(50);
    expect(t.checklist).toEqual(['Só da casa']);
  });

  it('validações: tipo inválido ou preparação com check-in já passado -> 400 e nada criado', async () => {
    const antes = await ReservaManual.countDocuments({});
    for (const c of [{ tipo_limpeza: 'luxo' }, { tipo_limpeza: 7 }]) {
      const r = await reservar({ check_in: '2041-06-05', check_out: '2041-06-10', ...c });
      expect([c, r.status]).toEqual([c, 400]);
    }
    const passado = await reservar({ check_in: '2001-06-05', check_out: '2001-06-10', tipo_limpeza: 'preparacao' });
    expect(passado.status).toBe(400);
    expect(passado.body.erro).toMatch(/já passou/);
    expect(await ReservaManual.countDocuments({})).toBe(antes);
  });

  it('o parceiro não escolhe a data: data_limpeza (qualquer valor) é ignorada e o dia é automático (1, 2, 5 e 8 noites)', async () => {
    const casos = [
      ['2065-01-10', '2065-01-11', '2065-01-11'],
      ['2065-02-10', '2065-02-12', '2065-02-11'],
      ['2065-03-10', '2065-03-15', '2065-03-12'],
      ['2065-04-10', '2065-04-18', '2065-04-14'],
    ];
    for (const [ci, co, esperado] of casos) {
      const r = await reservar({ check_in: ci, check_out: co, tipo_limpeza: 'intermedia', data_limpeza: ci }); // tenta o check-in
      expect([ci, co, r.status]).toEqual([ci, co, 201]);
      expect(new Date(r.body.tarefa.data).toISOString().slice(0, 10)).toBe(esperado);
      expect(new Date(r.body.reserva.data_limpeza).toISOString().slice(0, 10)).toBe(esperado);
    }
    for (const dl of [0, true, ['2066-01-01'], { $gt: '' }, 'abc', '1999-01-01']) {
      const r = await reservar({ check_in: '2066-02-01', check_out: '2066-02-05', tipo_limpeza: 'preparacao', data_limpeza: dl });
      expect([JSON.stringify(dl), r.status]).toEqual([JSON.stringify(dl), 201]);
      expect(new Date(r.body.tarefa.data).toISOString().slice(0, 10)).toBe('2066-02-01');
      await Tarefa.deleteOne({ _id: r.body.tarefa._id }); await ReservaManual.deleteOne({ _id: r.body.reserva._id });
    }
  });

  it('data_limpeza é ignorada em normal/profunda (fica no check-out)', async () => {
    const r = await reservar({ check_in: '2041-07-01', check_out: '2041-07-05', tipo_limpeza: 'normal' });
    expect(r.status).toBe(201);
    expect(new Date((await Tarefa.findById(r.body.tarefa._id)).data).toISOString().slice(0, 10)).toBe('2041-07-05');
    expect(r.body.reserva.data_limpeza).toBeNull();
  });
});

describe('duplicados', () => {
  it('intermédia no dia da saída de outra reserva da casa NÃO dá 409 e não duplica', async () => {
    const a = await reservar({ check_in: '2042-01-01', check_out: '2042-01-10' });
    expect(a.status).toBe(201);
    const b = await reservar({ check_in: '2042-01-05', check_out: '2042-01-15', tipo_limpeza: 'intermedia' });
    expect(b.status).toBe(201);
    expect(String(b.body.tarefa._id)).not.toBe(String(a.body.tarefa._id));
    const dia = await Tarefa.countDocuments({
      propriedade_id: casa._id, estado: { $ne: 'cancelada' },
      data: { $gte: new Date('2042-01-10T00:00:00Z'), $lt: new Date('2042-01-11T00:00:00Z') },
    });
    expect(dia).toBe(2);
  });

  it('duas saídas (normal + profunda) no mesmo dia e casa -> 409; duas intermédias iguais -> 409', async () => {
    const a = await reservar({ check_in: '2042-02-01', check_out: '2042-02-05' });
    expect(a.status).toBe(201);
    const b = await reservar({ check_in: '2042-02-02', check_out: '2042-02-05', tipo_limpeza: 'profunda' });
    expect(b.status).toBe(409);
    expect(b.body.codigo).toBe('RESERVA_DUPLICADA');
    const i1 = await reservar({ check_in: '2042-03-01', check_out: '2042-03-09', tipo_limpeza: 'intermedia' });
    expect(i1.status).toBe(201);
    const i2 = await reservar({ check_in: '2042-03-01', check_out: '2042-03-10', tipo_limpeza: 'intermedia' });
    expect(i2.status).toBe(409);
    // intermédia e preparação no mesmo dia são limpezas diferentes
    const p = await reservar({ check_in: '2042-03-05', check_out: '2042-03-08', tipo_limpeza: 'preparacao' });
    expect(p.status).toBe(201);
  });

  it('uma saída normal ignora intermédias existentes nesse dia', async () => {
    const i = await reservar({ check_in: '2042-04-01', check_out: '2042-04-20', tipo_limpeza: 'intermedia' });
    expect(i.status).toBe(201);
    const s = await reservar({ check_in: '2042-04-05', check_out: '2042-04-10' });
    expect(s.status).toBe(201);
  });
});

describe('alterar tipo e datas de uma reserva gravada', () => {
  it('normal -> profunda no mesmo dia: a mesma tarefa muda tipo, tempo e checklist (mantém a equipa)', async () => {
    const r = await reservar({ check_in: '2043-01-01', check_out: '2043-01-04' });
    const id = r.body.tarefa._id;
    const antes = await Tarefa.findById(id).lean();
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'profunda' });
    expect(u.status).toBe(200);
    const dep = await Tarefa.findById(id).lean();
    expect(dep.estado).toBe(antes.estado);
    expect(String(dep.utilizador_id)).toBe(String(antes.utilizador_id));
    expect(dep.tipo_limpeza).toBe('profunda');
    expect(dep.tempo_limpeza_minutos).toBe(150);
    expect(dep.checklist).toEqual(['Frigorífico', 'Janelas']);
    expect(await Tarefa.countDocuments({ propriedade_id: casa._id, 'detalhes_reserva.checkout': '2043-01-04', estado: { $ne: 'cancelada' } })).toBe(1);
  });

  it('normal -> intermédia: o dia passa a ser a meio da estadia, cancela a antiga e gera outra', async () => {
    const r = await reservar({ check_in: '2043-02-01', check_out: '2043-02-10' });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken))
      .send({ tipo_limpeza: 'intermedia', data_limpeza: '2043-02-02' }); // o campo é ignorado
    expect(u.status).toBe(200);
    expect((await Tarefa.findById(r.body.tarefa._id)).estado).toBe('cancelada');
    const nova = await Tarefa.findById(u.body.reserva.tarefa_gerada_id._id).lean();
    expect(nova.tipo_limpeza).toBe('intermedia');
    expect(nova.tempo_limpeza_minutos).toBe(30);
    expect(new Date(nova.data).toISOString().slice(0, 10)).toBe('2043-02-05');
  });

  it('mudar o check-out de uma intermédia recalcula o dia a meio da nova estadia; notas não regeneram; datas trocadas -> 400', async () => {
    const r = await reservar({ check_in: '2043-03-01', check_out: '2043-03-10', tipo_limpeza: 'intermedia' });
    const notas = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ observacoes: 'só notas' });
    expect(notas.status).toBe(200);
    expect(String(notas.body.reserva.tarefa_gerada_id._id)).toBe(String(r.body.tarefa._id));
    const ok = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ check_out: '2043-03-13' });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.reserva.tarefa_gerada_id.data).toISOString().slice(0, 10)).toBe('2043-03-07'); // 12 noites
    const mau = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ check_out: '2043-02-27' });
    expect(mau.status).toBe(400);
  });

  it('mudar o tipo com a limpeza em curso ou concluída -> 409 (regra existente)', async () => {
    const r = await reservar({ check_in: '2043-04-01', check_out: '2043-04-04' });
    await Tarefa.updateOne({ _id: r.body.tarefa._id }, { $set: { estado: 'em_curso' } });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'profunda' });
    expect(u.status).toBe(409);
    expect((await Tarefa.findById(r.body.tarefa._id)).tipo_limpeza).toBe('normal');
  });

  it('mudar o tipo não troca a checklist se já houve trabalho nela', async () => {
    const r = await reservar({ check_in: '2043-05-01', check_out: '2043-05-04' });
    await Tarefa.updateOne({ _id: r.body.tarefa._id }, { $set: { checklist_dinamica: [{ nome: 'S', items: [{ texto: 'x', concluido: true }] }] } });
    await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'profunda' });
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect(t.tipo_limpeza).toBe('profunda');
    expect(t.checklist).toEqual(['Item da casa']);
  });

  it('tipo inválido no PUT -> 400', async () => {
    const r = await reservar({ check_in: '2043-06-01', check_out: '2043-06-04' });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'x' });
    expect(u.status).toBe(400);
  });
});

describe('reservas e tarefas antigas (sem o campo) contam como normal', () => {
  it('uma tarefa sem tipo_limpeza bloqueia uma nova saída no mesmo dia e a lista devolve normal', async () => {
    const antiga = await reservar({ check_in: '2044-01-01', check_out: '2044-01-05' });
    await Tarefa.collection.updateOne({ _id: new mongoose.Types.ObjectId(antiga.body.tarefa._id) }, { $unset: { tipo_limpeza: '' } });
    await ReservaManual.collection.updateOne({ _id: new mongoose.Types.ObjectId(antiga.body.reserva._id) }, { $unset: { tipo_limpeza: '', data_limpeza: '' } });
    const dup = await reservar({ check_in: '2044-01-02', check_out: '2044-01-05' });
    expect(dup.status).toBe(409);
    const lista = await request(app).get('/api/parceiro/reservas').set(auth(parceiroToken));
    const rs = lista.body.reservas.find((x) => String(x._id) === String(antiga.body.reserva._id));
    expect(rs.tipo_limpeza ?? 'normal').toBe('normal');
    // e uma intermédia nesse dia passa
    const inter = await reservar({ check_in: '2044-01-01', check_out: '2044-01-10', tipo_limpeza: 'intermedia' });
    expect(inter.status).toBe(201);
  });
});

describe('exportação com coluna Tipo de limpeza', () => {
  it('a exportação tem a coluna «Tipo de limpeza»', async () => {
    const res = await request(app).get('/api/gestor/reservas/exportar-excel').set(auth(gestorToken))
      .buffer(true).parse((r, cb) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const cab = wb.worksheets[0].getRow(1).values.slice(1);
    expect(cab).toContain('Tipo de limpeza');
    const idx = cab.indexOf('Tipo de limpeza') + 1;
    const valores = new Set();
    wb.worksheets[0].eachRow((row, i) => { if (i > 1) valores.add(row.getCell(idx).value); });
    expect(valores.has('Profunda')).toBe(true);
    expect(valores.has('Normal')).toBe(true);
  });
});

describe('gestor configura tempo e checklist por tipo', () => {
  it('PUT valida e grava; valores inválidos -> 400', async () => {
    const ok = await request(app).put(`/api/gestor/propriedades/${casaSimples._id}`).set(auth(gestorToken))
      .send({ tempos_limpeza_por_tipo: { profunda: 120, intermedia: null }, checklists_por_tipo: { preparacao: ['Camas feitas', ' '] } });
    expect(ok.status).toBe(200);
    const p = await Propriedade.findById(casaSimples._id).lean();
    expect(p.tempos_limpeza_por_tipo.profunda).toBe(120);
    expect(p.checklists_por_tipo.preparacao).toEqual(['Camas feitas']);
    for (const mau of [
      { tempos_limpeza_por_tipo: { normal: 10 } },
      { tempos_limpeza_por_tipo: { profunda: -3 } },
      { checklists_por_tipo: { profunda: 'x' } },
    ]) {
      const r = await request(app).put(`/api/gestor/propriedades/${casaSimples._id}`).set(auth(gestorToken)).send(mau);
      expect([mau, r.status]).toEqual([mau, 400]);
    }
  });

  it('o novo tempo chega ao motor: a tarefa nova usa o tempo configurado', async () => {
    const r = await reservar({ check_in: '2046-01-01', check_out: '2046-01-03', tipo_limpeza: 'profunda' }, casaSimples);
    expect(r.status).toBe(201);
    expect((await Tarefa.findById(r.body.tarefa._id)).tempo_limpeza_minutos).toBe(120);
  });
});

describe('o tempo do tipo chega ao limite de 8h', () => {
  it('duas profundas de 300 min no mesmo dia: a segunda já não cabe (lotação)', async () => {
    const parceiro = await Utilizador.findOne({ email: 'p@tipos.pt' });
    const mkCasa = (nome) => Propriedade.create({
      nome, empresa_id: empresa._id, ativo: true, capacidade_hospedes: 2, parceiro_id: parceiro._id,
      tempo_limpeza_minutos: 60, tempos_limpeza_por_tipo: { profunda: 300 },
    });
    const c1 = await mkCasa('Grande 1');
    const c2 = await mkCasa('Grande 2');
    const r1 = await reservar({ check_in: '2047-01-01', check_out: '2047-01-05', tipo_limpeza: 'profunda' }, c1);
    const r2 = await reservar({ check_in: '2047-01-01', check_out: '2047-01-05', tipo_limpeza: 'profunda' }, c2);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.tarefa.estado).toBe('atribuida');
    expect(r1.body.tarefa.tempo_limpeza_minutos).toBe(300);
    expect(r2.body.tarefa.estado).toBe('nao_atribuida');
  });
});

describe('S4/S5: data automática e limites', () => {
  it('preparação com o check-in no passado: mensagem clara (a validação tem a data de hoje)', () => {
    const r = resolverDiaLimpeza({ tipo: 'preparacao', check_in: '2020-02-10', check_out: '2020-02-12', hoje: '2026-11-06' });
    expect(r.erro).toMatch(/já passou/);
    expect(resolverDiaLimpeza({ tipo: 'preparacao', check_in: '2020-02-10', check_out: '2020-02-12' }).dia).toBe('2020-02-10');
    // data já gravada (reserva antiga) não é recusada
    expect(resolverDiaLimpeza({ tipo: 'preparacao', check_in: '2020-02-10', check_out: '2020-02-12', data_gravada: new Date('2020-02-09T00:00:00Z'), hoje: '2026-11-06' }).dia).toBe('2020-02-09');
  });

  it('editar notas de uma preparação cuja data já passou não é bloqueado', async () => {
    const r = await reservar({ check_in: '2060-07-10', check_out: '2060-07-12', tipo_limpeza: 'preparacao' });
    await ReservaManual.updateOne({ _id: r.body.reserva._id }, { $set: { check_in: new Date('2020-02-10T00:00:00Z'), check_out: new Date('2020-02-12T00:00:00Z'), data_limpeza: new Date('2020-02-09T00:00:00Z') } });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ observacoes: 'só notas' });
    expect(u.status).toBe(200);
  });

  it('tempos_limpeza_por_tipo só aceita números ([5], true, texto, objeto = 400; null/vazio = limpa)', async () => {
    const put = (b) => request(app).put(`/api/gestor/propriedades/${casaSimples._id}`).set(auth(gestorToken)).send(b);
    for (const v of [[5], true, 'abc', '90', { $gt: 1 }, 10.5, 0, 481]) {
      const r = await put({ tempos_limpeza_por_tipo: { profunda: v } });
      expect([JSON.stringify(v), r.status]).toEqual([JSON.stringify(v), 400]);
    }
    expect((await put({ tempos_limpeza_por_tipo: { profunda: 90 } })).status).toBe(200);
    expect((await put({ tempos_limpeza_por_tipo: { profunda: '' } })).status).toBe(200);
    expect((await Propriedade.findById(casaSimples._id).lean()).tempos_limpeza_por_tipo.profunda).toBeNull();
  });

  it('texto ISO com hora usa os 10 primeiros caracteres, sem converter para UTC', async () => {
    const r = await reservar({
      check_in: '2061-04-10T23:30:00-03:00', check_out: '2061-04-14T23:30:00-03:00',
      tipo_limpeza: 'intermedia',
    });
    expect(r.status).toBe(201);
    expect(new Date(r.body.reserva.data_limpeza).toISOString().slice(0, 10)).toBe('2061-04-12');
    expect(new Date(r.body.tarefa.data).toISOString().slice(0, 10)).toBe('2061-04-12');
    const fim = await reservar({
      check_in: '2061-05-10T00:30:00+05:00', check_out: '2061-05-14T23:59:00-03:00',
      tipo_limpeza: 'intermedia',
    });
    expect(fim.status).toBe(201);
    expect(resolverDiaLimpeza({ tipo: 'normal', check_in: '2061-01-01T23:00:00-03:00', check_out: '2061-01-03T23:00:00-03:00' }).dia).toBe('2061-01-03');
  });

  it('o tipo passa a Normal/Profunda: a data da limpeza é limpa no servidor', async () => {
    const r = await reservar({ check_in: '2061-06-01', check_out: '2061-06-10', tipo_limpeza: 'intermedia' });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'profunda' });
    expect(u.status).toBe(200);
    expect(u.body.reserva.data_limpeza).toBeNull();
    expect(u.body.reserva.tipo_limpeza).toBe('profunda');
  });

  it('tipos estranhos no corpo (objeto, lista, número) -> 400; o parceiro não define tempo nem checklist', async () => {
    for (const t of [{ $ne: null }, ['profunda'], 5, 'luxo']) {
      const r = await reservar({ check_in: '2061-07-01', check_out: '2061-07-03', tipo_limpeza: t });
      expect([JSON.stringify(t), r.status]).toEqual([JSON.stringify(t), 400]);
    }
    const r = await reservar({ check_in: '2061-08-01', check_out: '2061-08-03', tempo_limpeza_minutos: 1, checklist: ['x'], tempos_limpeza_por_tipo: { normal: 1 } });
    const t = await Tarefa.findById(r.body.tarefa._id).lean();
    expect([t.tempo_limpeza_minutos, t.checklist]).toEqual([60, ['Item da casa']]);
  });
});

describe('S2: alterar o tipo no mesmo dia também verifica duplicados', () => {
  it('A preparação e B intermédia no mesmo dia: PUT B -> preparação = 409; nada muda', async () => {
    const A = await reservar({ check_in: '2062-01-03', check_out: '2062-01-06', tipo_limpeza: 'preparacao' });
    const B = await reservar({ check_in: '2062-01-03', check_out: '2062-01-08', tipo_limpeza: 'intermedia' });
    expect([A.status, B.status]).toEqual([201, 201]);
    const u = await request(app).put(`/api/parceiro/reservas/${B.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'preparacao' });
    expect(u.status).toBe(409);
    expect(u.body.codigo).toBe('RESERVA_DUPLICADA');
    expect((await Tarefa.findById(B.body.tarefa._id)).tipo_limpeza).toBe('intermedia');
  });

  it('B normal (saída) e A intermédia no mesmo dia: PUT A -> normal = 409', async () => {
    const B = await reservar({ check_in: '2062-02-01', check_out: '2062-02-05' });
    const A = await reservar({ check_in: '2062-02-03', check_out: '2062-02-05', tipo_limpeza: 'intermedia' });
    expect([B.status, A.status]).toEqual([201, 201]);
    const u = await request(app).put(`/api/parceiro/reservas/${A.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'normal' });
    expect(u.status).toBe(409);
    expect(u.body.codigo).toBe('RESERVA_DUPLICADA');
    expect((await Tarefa.findById(A.body.tarefa._id)).tipo_limpeza).toBe('intermedia');
    expect((await ReservaManual.findById(A.body.reserva._id)).tipo_limpeza).toBe('intermedia');
  });

  it('normal -> profunda (mesma classe, mesmo dia) continua a passar', async () => {
    const r = await reservar({ check_in: '2062-03-01', check_out: '2062-03-05' });
    const u = await request(app).put(`/api/parceiro/reservas/${r.body.reserva._id}`).set(auth(parceiroToken)).send({ tipo_limpeza: 'profunda' });
    expect(u.status).toBe(200);
  });
});

describe('S3: limpeza mais longa é reavaliada pelo motor', () => {
  async function mundo() {
    const e = await Empresa.create({ nome: 'Longa' + ++n });
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = (nome, role) =>
      Utilizador.create({ nome, email: `${nome}${++n}@longa.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
    const par = await mk('Par', 'parceiro');
    const ges = await mk('Ges', 'gestor');
    const ana = await mk('Ana', 'staff');
    const bia = await mk('Bia', 'staff');
    const casaP = await Propriedade.create({
      nome: 'P', empresa_id: e._id, ativo: true, capacidade_hospedes: 2, parceiro_id: par._id,
      tempo_limpeza_minutos: 60, tempos_limpeza_por_tipo: { profunda: 150 },
    });
    const token = (await request(app).post('/api/auth/login').send({ email: par.email, password: PASSWORD })).body.token;
    const dia = '2063-01-10';
    // Cria a reserva e fixa pessoa e hora (determinístico, sem depender do balanceamento).
    const reservaCom = async (pessoa, hora = '10:00') => {
      const r = await request(app).post('/api/parceiro/reservas').set(auth(token))
        .send({ propriedade_id: String(casaP._id), check_in: '2063-01-08', check_out: dia, hospedes: 2 });
      await Tarefa.updateOne({ _id: r.body.tarefa._id }, { $set: {
        utilizador_id: pessoa._id, equipa_atribuida: [pessoa._id], estado: 'atribuida', data: new Date(`${dia}T${hora}:00Z`),
      } });
      return r.body;
    };
    const outra = (pessoa, tempo, hora) => Tarefa.create({
      empresa_id: e._id, propriedade_id: casaP._id, utilizador_id: pessoa._id, equipa_atribuida: [pessoa._id],
      data: new Date(`${dia}T${hora}:00Z`), tempo_limpeza_minutos: tempo, tipo: 'limpeza', estado: 'atribuida', origem: 'manual',
    });
    const profunda = (b) => request(app).put(`/api/parceiro/reservas/${b.reserva._id}`).set(auth(token)).send({ tipo_limpeza: 'profunda' });
    return { e, ges, ana, bia, token, reservaCom, outra, profunda };
  }

  it('se continua a caber, mantém a pessoa e a hora', async () => {
    const m = await mundo();
    const b = await m.reservaCom(m.bia);
    const antes = await Tarefa.findById(b.tarefa._id).lean();
    expect((await m.profunda(b)).status).toBe(200);
    const dep = await Tarefa.findById(b.tarefa._id).lean();
    expect([String(dep.utilizador_id), dep.estado, dep.tempo_limpeza_minutos]).toEqual([String(m.bia._id), 'atribuida', 150]);
    expect(dep.data.toISOString()).toBe(antes.data.toISOString());
  });

  it('se passa a sobrepor-se a outra limpeza da pessoa, o motor passa-a a quem couber', async () => {
    const m = await mundo();
    const b = await m.reservaCom(m.bia, '10:00'); // 10:00-11:00; com 150 min iria até 12:30
    await m.outra(m.bia, 60, '11:15'); // 11:15-12:15 da mesma pessoa
    expect((await m.profunda(b)).status).toBe(200);
    const dep = await Tarefa.findById(b.tarefa._id).lean();
    expect(dep.estado).toBe('atribuida');
    expect(dep.tempo_limpeza_minutos).toBe(150);
    // O motor volta a planear: ou outra pessoa, ou a mesma com a hora acertada. Nunca sobreposta.
    const ini = dep.data.getTime();
    const fim = ini + 150 * 60000;
    const outraT = await Tarefa.findOne({ empresa_id: m.e._id, _id: { $ne: b.tarefa._id }, utilizador_id: m.bia._id }).lean();
    if (String(dep.utilizador_id) === String(m.bia._id)) {
      const oi = outraT.data.getTime() - (outraT.tempo_viagem_minutos || 0) * 60000;
      const of = outraT.data.getTime() + outraT.tempo_limpeza_minutos * 60000;
      expect(ini < of && fim > oi).toBe(false);
      expect(dep.data.toISOString()).not.toBe(new Date('2063-01-10T10:00:00Z').toISOString());
    }
  });

  it('se deixa de caber no horário da pessoa e ninguém cabe: fica por atribuir com o motivo real e o gestor é avisado', async () => {
    const m = await mundo();
    const b = await m.reservaCom(m.bia, '10:00');
    // Dias cheios dentro do horário (09:00-12:00 e 13:00-17:00): 150 min já não cabem a ninguém.
    for (const p of [m.bia, m.ana]) {
      await m.outra(p, 180, '09:00');
      await m.outra(p, 240, '13:00');
    }
    expect((await m.profunda(b)).status).toBe(200);
    const dep = await Tarefa.findById(b.tarefa._id).lean();
    expect(dep.utilizador_id).toBeNull();
    expect(dep.equipa_atribuida).toHaveLength(0);
    expect(dep.estado).toBe('nao_atribuida');
    expect(dep.motivo_nao_atribuicao).toMatch(/horário/);
    expect(dep.tipo_limpeza).toBe('profunda');
    expect(await Notificacao.countDocuments({ utilizador_id: m.ges._id, mensagem: /já não cabe/ })).toBe(1);
  });

  it('com a limpeza em curso nada é reavaliado (409) e fica com a pessoa', async () => {
    const m = await mundo();
    const b = await m.reservaCom(m.bia);
    await Tarefa.updateOne({ _id: b.tarefa._id }, { $set: { estado: 'em_curso' } });
    expect((await m.profunda(b)).status).toBe(409);
    const dep = await Tarefa.findById(b.tarefa._id).lean();
    expect([String(dep.utilizador_id), dep.estado, dep.tempo_limpeza_minutos]).toEqual([String(m.bia._id), 'em_curso', 60]);
  });
});

describe('S1: a recriação do Smoobu respeita o tipo da reserva', () => {
  it('recria a tarefa de uma reserva sem tarefa com dia, tempo e checklist do tipo', async () => {
    const e = await Empresa.create({ nome: 'Smoobu Tipos', integracoes: { smoobu: { api_key: 'chave-de-teste', ativo: true } } });
    const par = await Utilizador.create({ nome: 'Par', email: `par${++n}@sm.pt`, password_hash: 'x', empresa_id: e._id, role: 'parceiro', ativo: true });
    const c = await Propriedade.create({
      nome: 'Casa Sm', empresa_id: e._id, ativo: true, parceiro_id: par._id, tempo_limpeza_minutos: 60,
      checklist: ['Da casa'], tempos_limpeza_por_tipo: { intermedia: 25, profunda: 140 }, checklists_por_tipo: { profunda: ['Frigorífico'] },
    });
    const mkRes = (extra) => ReservaManual.create({
      propriedade_id: c._id, parceiro_id: par._id, empresa_id: e._id, hospedes: 2, ...extra,
    });
    const inter = await mkRes({ check_in: new Date('2064-03-01T00:00:00Z'), check_out: new Date('2064-03-10T00:00:00Z'), tipo_limpeza: 'intermedia', data_limpeza: new Date('2064-03-05T00:00:00Z') });
    const prof = await mkRes({ check_in: new Date('2064-04-01T00:00:00Z'), check_out: new Date('2064-04-04T00:00:00Z'), tipo_limpeza: 'profunda' });
    const prep = await mkRes({ check_in: new Date('2064-05-10T00:00:00Z'), check_out: new Date('2064-05-12T00:00:00Z'), tipo_limpeza: 'preparacao', data_limpeza: new Date('2064-05-09T00:00:00Z') });
    const antiga = await mkRes({ check_in: new Date('2064-06-01T00:00:00Z'), check_out: new Date('2064-06-03T00:00:00Z') });
    await ReservaManual.collection.updateOne({ _id: antiga._id }, { $unset: { tipo_limpeza: '', data_limpeza: '' } });

    const fetchOriginal = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, statusText: '200',
      json: async () => ({ bookings: [], page_count: 1 }), text: async () => '{}',
    });
    const { sincronizarReservas } = require('../controllers/smoobuController');
    const out = {};
    await sincronizarReservas({ user: { empresa_id: e._id } }, { status: (c2) => ({ json: (b) => { out.status = c2; out.body = b; } }) });
    global.fetch = fetchOriginal;
    expect(out.status).toBe(200);

    const tarefaDe = async (r) => Tarefa.findById((await ReservaManual.findById(r._id)).tarefa_gerada_id).lean();
    const ti = await tarefaDe(inter);
    expect([ti.tipo_limpeza, ti.tempo_limpeza_minutos, ti.checklist, ti.data.toISOString().slice(0, 10)])
      .toEqual(['intermedia', 25, ['Da casa'], '2064-03-05']);
    const tp = await tarefaDe(prof);
    expect([tp.tipo_limpeza, tp.tempo_limpeza_minutos, tp.checklist, tp.data.toISOString().slice(0, 10)])
      .toEqual(['profunda', 140, ['Frigorífico'], '2064-04-04']);
    const tr = await tarefaDe(prep);
    expect([tr.tipo_limpeza, tr.tempo_limpeza_minutos, tr.data.toISOString().slice(0, 10)]).toEqual(['preparacao', 60, '2064-05-09']);
    const ta = await tarefaDe(antiga);
    expect([ta.tipo_limpeza, ta.tempo_limpeza_minutos, ta.data.toISOString().slice(0, 10)]).toEqual(['normal', 60, '2064-06-03']);
    expect(ti.estado).toBe('por_atribuir');
  });
});

describe('outra empresa', () => {
  it('o gestor de outra empresa não altera a casa', async () => {
    const e2 = await Empresa.create({ nome: 'Outra' + ++n });
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({ nome: 'G2', email: 'g2@tipos.pt', password_hash: hash, empresa_id: e2._id, role: 'gestor', ativo: true });
    const tk = (await request(app).post('/api/auth/login').send({ email: 'g2@tipos.pt', password: PASSWORD })).body.token;
    const r = await request(app).put(`/api/gestor/propriedades/${casa._id}`).set(auth(tk)).send({ tempos_limpeza_por_tipo: { profunda: 5 } });
    expect([403, 404]).toContain(r.status);
    expect((await Propriedade.findById(casa._id).lean()).tempos_limpeza_por_tipo.profunda).toBe(150);
  });
});
