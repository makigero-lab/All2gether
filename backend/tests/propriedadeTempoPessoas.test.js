/**
 * Editar propriedade: «Tempo base» e «Pessoas necessárias» têm de ficar gravados.
 * Envia o mesmo corpo que o ecrã «Editar propriedade» envia e confirma na base de dados
 * e na listagem (o que o ecrã volta a mostrar ao reabrir).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const { cenario, auth } = require('./helpersLote');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/** Corpo igual ao do ecrã (frontend/src/app/gestor/propriedades/page.tsx → handleEditar). */
const corpoEcra = (p, extra) => ({
  nome: p.nome,
  morada: 'Rua Augusta 1, Lisboa',
  tempo_limpeza_minutos: 60,
  checklist: [],
  tempos_limpeza_por_tipo: { intermedia: null, profunda: null, preparacao: null },
  checklists_por_tipo: { intermedia: [], profunda: [], preparacao: [] },
  modelo_checklist_id: null,
  equipa_preferencial: [],
  staff_necessario: 1,
  observacoes: '',
  parceiro_id: null,
  fornecedor_id: null,
  capacidade_hospedes: 6,
  dias_fixos_limpeza: [],
  ...extra,
});

test('PUT /propriedades/:id grava o tempo base e as pessoas necessárias', async () => {
  const c = await cenario(app, { extra: 0, sn: 1 });
  const put = (corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);

  const r = await put(corpoEcra(c.p, { tempo_limpeza_minutos: 95, staff_necessario: 3 }));
  expect(r.status).toBe(200);
  expect(r.body.propriedade.tempo_limpeza_minutos).toBe(95);
  expect(r.body.propriedade.staff_necessario).toBe(3);

  const bd = await Propriedade.findById(c.p._id).lean();
  expect(bd.tempo_limpeza_minutos).toBe(95);
  expect(bd.staff_necessario).toBe(3);

  // O que o ecrã lê ao reabrir o «Editar propriedade».
  const lista = await request(app).get('/api/gestor/propriedades').set(auth(c.token));
  const linha = lista.body.propriedades.find((x) => String(x._id) === String(c.p._id));
  expect(linha.tempo_limpeza_minutos).toBe(95);
  expect(linha.staff_necessario).toBe(3);

  // Só estes dois campos também chega (sem os outros).
  expect((await put({ staff_necessario: 2 })).status).toBe(200);
  expect((await Propriedade.findById(c.p._id).lean()).staff_necessario).toBe(2);
  expect((await put({ tempo_limpeza_minutos: 30 })).status).toBe(200);
  expect((await Propriedade.findById(c.p._id).lean()).tempo_limpeza_minutos).toBe(30);
});

test('PUT /propriedades/:id recusa pessoas necessárias fora de 1 a 10 e tempo inválido', async () => {
  const c = await cenario(app, { extra: 0, sn: 2 });
  const put = (corpo) => request(app).put(`/api/gestor/propriedades/${c.p._id}`).set(auth(c.token)).send(corpo);

  for (const mau of [0, 11, -1, 'dois', 1.5]) {
    expect((await put({ staff_necessario: mau })).status).toBe(400);
  }
  for (const mau of [-5, 'abc']) {
    expect((await put({ tempo_limpeza_minutos: mau })).status).toBe(400);
  }
  const bd = await Propriedade.findById(c.p._id).lean();
  expect(bd.staff_necessario).toBe(2);
  expect(bd.tempo_limpeza_minutos).toBe(60);
});
