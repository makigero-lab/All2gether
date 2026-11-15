/**
 * As listas de limpezas do gestor (tabela e calendário) trazem a morada curta da casa (rua/localidade) para
 * distinguir casas com o mesmo nome, só da empresa do próprio gestor, sem a morada estruturada completa.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { cenario, auth } = require('./helpersLote');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

test('GET /tarefas e /calendario/dados devolvem rua e localidade das casas homónimas', async () => {
  const c = await cenario(app, { sn: 1, extra: 0 });
  const mk = (rua, cidade, id) => Propriedade.create({ nome: 'Casa Azul', empresa_id: c.e._id, smoobu_id: id, ativo: true, tempo_limpeza_minutos: 60, morada_estruturada: { rua, cidade, codigo_postal: '1000-001' } });
  const a = await mk('Rua Augusta 10', 'Lisboa', 'm1');
  const b = await mk('Rua do Ouro 5', 'Lisboa', 'm2');
  const dia = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  for (const p of [a, b]) await Tarefa.create({ empresa_id: c.e._id, propriedade_id: p._id, data: new Date(`${dia}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir' });

  for (const url of ['/api/gestor/tarefas', `/api/gestor/calendario/dados?inicio=${dia}&fim=${dia}`]) {
    const r = await request(app).get(url).set(auth(c.token));
    expect(r.status).toBe(200);
    const casas = r.body.tarefas.map((t) => t.propriedade_id).filter((p) => p.nome === 'Casa Azul');
    expect(casas).toHaveLength(2);
    expect(casas.map((p) => p.morada_rua).sort()).toEqual(['Rua Augusta 10', 'Rua do Ouro 5']);
    expect(casas.every((p) => p.morada_localidade === 'Lisboa' && typeof p.morada_curta === 'string')).toBe(true);
    expect(casas.every((p) => p.morada_estruturada === undefined)).toBe(true);
  }
});
