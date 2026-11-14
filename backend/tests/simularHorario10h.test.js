/**
 * scripts/simular-horario-10h.js (novo horário 10:00-17:30) em base em memória:
 * simula por defeito (não escreve), separa as limpezas postas à mão pelo gestor das automáticas,
 * só com `aplicar` reagenda as automáticas, e nunca mostra dados pessoais.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));
jest.mock('../utils/distancia', () => {
  const real = jest.requireActual('../utils/distancia');
  return { ...real, calcularTempoViagemReal: jest.fn(async () => ({ minutos: 0, origem: 'haversine', distanciaKm: 0 })) };
});

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario } = require('./helpersLote');
const { simularHorario10h } = require('../scripts/simular-horario-10h');
const { eMarcadaPeloGestor } = require('../utils/diaMudadoGestor');
const H = require('../utils/horario');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let n = 0;
const casa = (c) => Propriedade.create({ nome: 'S' + ++n, empresa_id: c.e._id, smoobu_id: 's' + ++n, ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 } });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa._id, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: 60, estado: 'atribuida', ...ex });
const AGORA = new Date('2036-02-01T12:00:00Z');
const hora = (t) => H.hhmm(H.minutosLocais(t.data));

test('eMarcadaPeloGestor: mudar dia/hora, dia posto numa data provisória e limpeza criada à mão contam; o resto não', () => {
  expect(eMarcadaPeloGestor({ data_ajustada_gestor: true })).toBe(true);
  expect(eMarcadaPeloGestor({ dia_mudado_pelo_gestor: { dia: '2036-02-04' } })).toBe(true);
  expect(eMarcadaPeloGestor({ origem: 'manual' })).toBe(true);
  expect(eMarcadaPeloGestor({ origem: 'smoobu', data_ajustada_gestor: false })).toBe(false);
  expect(eMarcadaPeloGestor({ origem: 'smoobu', dia_mudado_pelo_gestor: {} })).toBe(false);
  expect(eMarcadaPeloGestor(null)).toBe(false);
});

test('simula sem escrever: conta as do gestor e as automáticas fora do novo horário e só ids', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  const dentro = await tar(c, p, c.ana, '2036-02-04', '10:00:00', { origem: 'smoobu' });
  const cedoAuto = await tar(c, p, c.ana, '2036-02-04', '09:00:00', { origem: 'smoobu' }); // 09:00: já é antes das 10:00
  const tardeAuto = await tar(c, p, c.ana, '2036-02-04', '17:00:00', { origem: 'smoobu' }); // acaba às 18:00
  const cedoGestor = await tar(c, p, c.bia, '2036-02-04', '08:00:00', { origem: 'smoobu', data_ajustada_gestor: true });
  const tardeManual = await tar(c, p, c.bia, '2036-02-04', '19:00:00', { origem: 'manual' });
  const passada = await tar(c, p, c.ana, '2036-01-20', '08:00:00', { origem: 'smoobu' });

  const r = await simularHorario10h({ aplicar: false, agora: AGORA, empresaId: c.e._id });
  expect(r.aplicado).toBe(false);
  expect(r.janela).toBe('10:00-17:30');
  expect(r.foraDoNovoHorario).toBe(4);
  expect(r.marcadasPeloGestor).toBe(2);
  expect(r.automaticas).toBe(2);
  expect(r.idsMarcadasPeloGestor.sort()).toEqual([String(cedoGestor._id), String(tardeManual._id)].sort());
  expect(r.idsAutomaticas.sort()).toEqual([String(cedoAuto._id), String(tardeAuto._id)].sort());
  expect(r.reatribuicao.reagendadas + r.reatribuicao.passadasAOutraPessoa + r.reatribuicao.porAtribuir).toBe(2);
  // Só números e ids: nada de nomes, casas ou hóspedes.
  expect(JSON.stringify(r)).not.toMatch(/\b(Ana|Bia)\b|hospede|\bnome\b/i);

  // Nada foi escrito.
  for (const t of [dentro, cedoAuto, tardeAuto, cedoGestor, tardeManual, passada]) {
    expect((await Tarefa.findById(t._id)).data.toISOString()).toBe(t.data.toISOString());
  }
});

test('--aplicar reagenda só as automáticas; as do gestor (08:00, 19:00) ficam como ele as pôs', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  const dentro = await tar(c, p, c.ana, '2036-02-05', '10:00:00', { origem: 'smoobu' });
  const cedoAuto = await tar(c, p, c.ana, '2036-02-05', '09:00:00', { origem: 'smoobu' });
  const cedoGestor = await tar(c, p, c.bia, '2036-02-05', '08:00:00', { origem: 'smoobu', data_ajustada_gestor: true });
  const tardeManual = await tar(c, p, c.bia, '2036-02-05', '19:00:00', { origem: 'manual' });

  const r = await simularHorario10h({ aplicar: true, agora: AGORA, empresaId: c.e._id });
  expect(r.aplicado).toBe(true);
  expect(r.automaticas).toBe(1);

  expect((await Tarefa.findById(dentro._id)).data.toISOString()).toBe(dentro.data.toISOString());
  const dep = await Tarefa.findById(cedoAuto._id);
  const h = hora(dep);
  expect(h >= '10:00' || dep.estado !== 'atribuida').toBe(true); // reagendada para dentro do novo horário (ou passada a outra pessoa)
  expect(hora(await Tarefa.findById(cedoGestor._id))).toBe('08:00');
  expect(hora(await Tarefa.findById(tardeManual._id))).toBe('19:00');

  // Idempotente: depois de aplicado já não há automáticas fora do horário.
  const outra = await simularHorario10h({ aplicar: false, agora: AGORA, empresaId: c.e._id });
  expect(outra.automaticas).toBe(0);
  expect(outra.marcadasPeloGestor).toBe(2);
});
