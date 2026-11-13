/**
 * Distribuição (decisão 2026-11-13): equilíbrio semanal em horas, equipa
 * preferida ganha sempre mas reparte pelo membro menos carregado, e quem já
 * está no mesmo prédio (coordenadas a menos de 50 m) fica com a seguinte.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const { obterRangeDia } = require('../utils/scheduler');
const {
  determinarUtilizadorAtribuido,
  temTarefaNoMesmoSitio,
  calcularCargaSemanal,
} = require('../utils/loadBalancer');

let mongod;
let n = 0;

// Quarta-feira; a semana vai de 16/11 (seg) a 22/11 (dom).
const DIA = '2026-11-18';
const PREDIO = { lat: 38.7139, lng: -9.1394 };
const AO_LADO = { lat: 38.71405, lng: -9.1394 }; // ~17 m
const LONGE = { lat: 38.7369, lng: -9.1427 }; // ~2,5 km

async function cenario() {
  const e = await Empresa.create({ nome: 'C' + ++n });
  const staff = (nome, extra = {}) =>
    Utilizador.create({
      nome, email: `${nome}${++n}@x.pt`, password_hash: 'x', empresa_id: e._id,
      role: 'staff', ativo: true, dias_folga: [], ...extra,
    });
  const casa = (nome, coordenadas, extra = {}) =>
    Propriedade.create({
      nome, empresa_id: e._id, smoobu_id: String(++n), ativo: true,
      capacidade_hospedes: 2, tempo_limpeza_minutos: 60, coordenadas, ...extra,
    });
  const limpeza = (p, u, iso, min = 60) =>
    Tarefa.create({
      empresa_id: e._id, propriedade_id: p._id, utilizador_id: u._id,
      data: new Date(iso), estado: 'atribuida', tempo_limpeza_minutos: min,
    });
  return { e, staff, casa, limpeza };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const range = () => obterRangeDia(new Date(`${DIA}T12:00:00Z`));

describe('carga semanal', () => {
  test('conta só a semana de segunda a domingo da limpeza', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const p = await casa('P', LONGE);
    await limpeza(p, ana, '2026-11-16T09:00:00Z', 120); // segunda: conta
    await limpeza(p, ana, '2026-11-22T09:00:00Z', 60); // domingo: conta
    await limpeza(p, ana, '2026-11-15T09:00:00Z', 300); // domingo anterior: não conta
    await limpeza(p, ana, '2026-11-23T09:00:00Z', 300); // segunda seguinte: não conta
    expect(await calcularCargaSemanal(e._id, ana._id, range().start)).toBe(180);
  });

  test('vai para quem tem menos horas na semana, mesmo que o outro comece à mesma hora', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const bia = await staff('Bia');
    const outra = await casa('Outra', LONGE);
    // Ana já tem 6 h noutros dias da semana; Bia nenhuma.
    for (const d of ['16', '17', '19']) await limpeza(outra, ana, `2026-11-${d}T09:00:00Z`, 120);
    const nova = await casa('Nova', PREDIO);
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(bia._id));
  });
});

describe('equipa preferida', () => {
  test('ganha sempre a quem está fora dela, e reparte pelo membro menos carregado', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const bia = await staff('Bia');
    await staff('Carla'); // fora da equipa e sem carga nenhuma
    const outra = await casa('Outra', LONGE);
    for (const d of ['16', '17']) await limpeza(outra, ana, `2026-11-${d}T09:00:00Z`, 180);
    await limpeza(outra, bia, '2026-11-16T09:00:00Z', 60);
    // Ana é a primeira da lista, mas tem mais horas: vai a Bia.
    const nova = await casa('Nova', PREDIO, { equipa_preferencial: [ana._id, bia._id] });
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(bia._id));
  });

  test('dentro da equipa, quem já está no mesmo prédio nesse dia fica com ela', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const bia = await staff('Bia');
    const vizinha = await casa('Vizinha', AO_LADO);
    await limpeza(vizinha, ana, `${DIA}T09:00:00Z`, 60);
    const nova = await casa('Nova', PREDIO, { equipa_preferencial: [bia._id, ana._id] });
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(ana._id));
  });

  test('casa com equipa preferida diferente: a preferida ganha a quem já está no prédio', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const bia = await staff('Bia');
    const vizinha = await casa('Vizinha', AO_LADO);
    await limpeza(vizinha, ana, `${DIA}T09:00:00Z`, 60);
    const nova = await casa('Nova', PREDIO, { equipa_preferencial: [bia._id] });
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(bia._id));
  });
});

describe('mesmo prédio', () => {
  test('a menos de 50 m conta; a 2,5 km não', async () => {
    const { staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    const vizinha = await casa('Vizinha', AO_LADO);
    await limpeza(vizinha, ana, `${DIA}T09:00:00Z`, 60);
    const nova = await casa('Nova', PREDIO);
    const longe = await casa('Longe', LONGE);
    expect(await temTarefaNoMesmoSitio(ana._id, nova._id, PREDIO, range())).toBe(true);
    expect(await temTarefaNoMesmoSitio(ana._id, longe._id, LONGE, range())).toBe(false);
  });

  test('sem preferida, quem está no prédio fica com a seguinte mesmo com mais horas na semana', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const ana = await staff('Ana');
    await staff('Bia');
    const outra = await casa('Outra', LONGE);
    await limpeza(outra, ana, '2026-11-16T09:00:00Z', 180);
    const vizinha = await casa('Vizinha', AO_LADO);
    await limpeza(vizinha, ana, `${DIA}T09:00:00Z`, 60);
    const nova = await casa('Nova', PREDIO);
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(ana._id));
  });

  test('o exclusivo de outras casas nunca recebe, mesmo estando no prédio', async () => {
    const { e, staff, casa, limpeza } = await cenario();
    const vizinha = await casa('Vizinha', AO_LADO);
    const ana = await staff('Ana', { exclusivo_preferenciais: true, propriedades_alocadas: [vizinha._id] });
    const bia = await staff('Bia');
    await limpeza(vizinha, ana, `${DIA}T09:00:00Z`, 60);
    const nova = await casa('Nova', PREDIO);
    const r = await determinarUtilizadorAtribuido(e._id, range(), PREDIO, 60, nova._id);
    expect(String(r.utilizadorId)).toBe(String(bia._id));
  });
});
