/**
 * Regressão (@Tester): com hora fixada pelo gestor o motor nunca liberta limpezas da pessoa preferida (VIP);
 * escolhe só entre quem já cabe. Nem em várias tentativas, nem limpezas com a hora fixada pelo gestor.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));
jest.mock('../utils/distancia', () => {
  const real = jest.requireActual('../utils/distancia');
  return { ...real, calcularTempoViagemReal: jest.fn(async () => ({ minutos: 0, origem: 'haversine', distanciaKm: 0 })) };
});
const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario } = require('./helpersLote');
const { atribuirTarefaEmFalta } = require('../utils/atribuicaoAutomatica');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
let n = 0;
const casa = (c) => Propriedade.create({ nome: 'T' + ++n, empresa_id: c.e._id, smoobu_id: 't' + ++n, ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1, coordenadas: { lat: 38.7, lng: -9.1 } });
const tar = (c, p, pessoa, dia, hora, ex = {}) =>
  Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, utilizador_id: pessoa ? pessoa._id : null, data: new Date(`${dia}T${hora}Z`), tempo_limpeza_minutos: ex.tempo_limpeza_minutos || 60, estado: pessoa ? 'atribuida' : 'por_atribuir', ...ex });

async function cena(dia, fixaHora, gestor) {
  const c = await cenario(app, { sn: 1, extra: 4 });
  const p = await casa(c);
  await Propriedade.updateOne({ _id: p._id }, { $set: { equipa_preferencial: [c.ana._id] } });
  const outra = await casa(c);
  const anaT = [];
  for (const h of ['10:00:00', '10:00:00', '10:00:00', '10:00:00']) anaT.push(await tar(c, outra, c.ana, dia, h, { tempo_limpeza_minutos: 450 }));
  for (const s of [c.bia, ...c.subs]) await tar(c, outra, s, dia, '11:00:00');
  const fixa = await tar(c, p, null, dia, fixaHora, gestor ? { data_ajustada_gestor: true } : {});
  const lean = await Tarefa.findById(fixa._id).populate('propriedade_id').lean();
  const r = await atribuirTarefaEmFalta(lean, new Date(`${dia}T00:00:00Z`));
  const depois = await Tarefa.find({ _id: { $in: anaT.map((t) => t._id) } }).lean();
  return { r, libertadas: depois.filter((t) => t.estado !== 'atribuida').length };
}
test('com hora fixa o motor não liberta nenhuma limpeza da preferida', async () => {
  const x = await cena('2036-03-13', '11:00:00', true);
  expect(x.libertadas).toBe(0); // com hora fixa o motor nao pode libertar limpezas da VIP (so escolhe quem cabe)
});

test('o ramo de libertação nunca toca numa limpeza com a hora fixada pelo gestor (mesmo sem hora fixa na nova)', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const p = await casa(c);
  await Propriedade.updateOne({ _id: p._id }, { $set: { equipa_preferencial: [c.ana._id] } });
  const outra = await casa(c);
  const fixada = await tar(c, outra, c.ana, '2036-03-14', '10:00:00', { tempo_limpeza_minutos: 450, data_ajustada_gestor: true });
  const nova = await tar(c, p, null, '2036-03-14', '00:00:00');
  const lean = await Tarefa.findById(nova._id).populate('propriedade_id').lean();
  await atribuirTarefaEmFalta(lean, new Date('2036-03-14T00:00:00Z'));
  const dep = await Tarefa.findById(fixada._id).lean();
  expect(dep.estado).toBe('atribuida');
  expect(String(dep.utilizador_id)).toBe(String(c.ana._id));
});
