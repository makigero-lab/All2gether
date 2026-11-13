/**
 * GET /api/gestor/tarefas/:id/disponiveis — o seletor da atribuição manual só mostra
 * quem o motor também aceitaria (ativo, sem ausência nem folga, equipa exclusiva,
 * limpeza cabe no horário), com a hora prevista; equipas de 2 (vaga); motivo real.
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
const Ausencia = require('../models/Ausencia');
const { cenario, login, auth } = require('./helpersLote');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const DIA = '2033-03-10'; // quinta-feira
const lista = (token, id, q = '') => request(app).get(`/api/gestor/tarefas/${id}/disponiveis${q}`).set(auth(token));
const nomes = (r) => r.body.disponiveis.map((d) => d.nome).sort();
const ausente = (e, u, tipo = 'ferias') =>
  Ausencia.create({ utilizador_id: u._id, empresa_id: e._id, data_inicio: new Date(`${DIA}T00:00:00Z`), data_fim: new Date(`${DIA}T00:00:00Z`), tipo, estado: 'aprovada' });
const limpeza = (e, p, extra = {}) =>
  Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: null, data: new Date(`${DIA}T10:00:00Z`), tempo_limpeza_minutos: 60, estado: 'por_atribuir', ...extra });

describe('disponíveis para atribuir à mão', () => {
  test('filtra ausência, folga, inativo, equipa exclusiva e agenda cheia; devolve a hora prevista', async () => {
    const { e, p, bia, mk, token } = await cenario(app, { extra: 1, sn: 1 });
    const cris = await mk('Cris', 'staff'); await cris.updateOne({ dias_folga: [4] });
    const dani = await mk('Dani', 'staff'); await dani.updateOne({ ativo: false });
    const eva = await mk('Eva', 'staff'); await eva.updateOne({ exclusivo_preferenciais: true });
    const fred = await mk('Fred', 'staff');
    await ausente(e, bia);
    const outra = await Propriedade.create({ nome: 'Outra', empresa_id: e._id, smoobu_id: 'o1', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60 });
    await limpeza(e, outra, { utilizador_id: fred._id, data: new Date(`${DIA}T09:00:00Z`), tempo_limpeza_minutos: 500, estado: 'atribuida' });
    const t = await limpeza(e, p);

    const r = await lista(token, t._id);
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('responsavel');
    expect(nomes(r)).toEqual(['Ana', 'Sub0']);
    expect(r.body.motivo).toBeNull();
    for (const d of r.body.disponiveis) expect(d.hora_prevista).toBe(`${DIA}T09:00:00.000Z`);
    // PATCH /atribuir mantém a hora que a limpeza já tem: a prevista é essa.
    const ra = await lista(token, t._id, '?acao=atribuir');
    expect(nomes(ra)).toEqual(['Ana', 'Sub0']);
    expect(ra.body.disponiveis[0].hora_prevista).toBe(`${DIA}T10:00:00.000Z`);
  });

  test('equipa exclusiva: quem a casa aceita (equipa preferencial) aparece', async () => {
    const { e, p, mk, token } = await cenario(app, { extra: 0, sn: 1 });
    const eva = await mk('Eva', 'staff'); await eva.updateOne({ exclusivo_preferenciais: true });
    const t = await limpeza(e, p);
    expect(nomes(await lista(token, t._id))).toEqual(['Ana', 'Bia']);
    await Propriedade.updateOne({ _id: p._id }, { $set: { equipa_preferencial: [eva._id] } });
    expect(nomes(await lista(token, t._id))).toEqual(['Ana', 'Bia', 'Eva']);
  });

  test('vaga de equipa de 2: não repete quem já está e só serve quem tem a hora livre', async () => {
    const { e, p, ana, subs, token } = await cenario(app, { extra: 2, sn: 2 });
    const [gil] = subs;
    const outra = await Propriedade.create({ nome: 'Outra', empresa_id: e._id, smoobu_id: 'o2', ativo: true, capacidade_hospedes: 2, tempo_limpeza_minutos: 60 });
    // Gil tem uma limpeza que choca com as 10:00.
    await limpeza(e, outra, { utilizador_id: gil._id, estado: 'atribuida' });
    const t = await limpeza(e, p, { utilizador_id: ana._id, equipa_atribuida: [ana._id], estado: 'atribuida', pessoas_em_falta: 1 });
    const r = await lista(token, t._id, '?acao=atribuir');
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('vaga');
    expect(nomes(r)).toEqual(['Bia', 'Sub1']);
    for (const d of r.body.disponiveis) expect(d.hora_prevista).toBe(`${DIA}T10:00:00.000Z`);
  });

  test('ninguém disponível: lista vazia e o motivo real (ausência; limpeza demasiado longa)', async () => {
    const { e, p, ana, bia, token } = await cenario(app, { extra: 0, sn: 1 });
    await ausente(e, ana, 'doenca');
    await ausente(e, bia, 'doenca');
    const r = await lista(token, (await limpeza(e, p))._id);
    expect(r.body.disponiveis).toEqual([]);
    expect(r.body.motivo).toMatch(/ausente|folga/i);

    const longa = await limpeza(e, p, { data: new Date('2033-03-11T10:00:00Z'), tempo_limpeza_minutos: 900 });
    const r2 = await lista(token, longa._id);
    expect(r2.body.disponiveis).toEqual([]);
    expect(r2.body.motivo).toMatch(/demasiado longa/);
  });

  test('permissões e isolamento: staff 403, outra empresa 404, id inválido 400, concluída 409', async () => {
    const { e, p, ana, token } = await cenario(app, { extra: 0, sn: 1 });
    const t = await limpeza(e, p);
    expect((await lista(await login(app, ana), t._id)).status).toBe(403);
    const outro = await cenario(app, { extra: 0, sn: 1 });
    expect((await lista(outro.token, t._id)).status).toBe(404);
    expect((await lista(token, 'xx')).status).toBe(400);
    await Tarefa.updateOne({ _id: t._id }, { $set: { estado: 'concluida' } });
    expect((await lista(token, t._id)).status).toBe(409);
  });
});

describe('pedido de ausência por aprovar', () => {
  test('a pessoa continua elegível e vem marcada com ausencia_pendente; sem pedido vem false', async () => {
    const c = await cenario(app, { extra: 0 });
    const p = await Propriedade.create({ nome: 'CasaP' + Math.random(), empresa_id: c.e._id, smoobu_id: String(Math.random()), ativo: true, tempo_limpeza_minutos: 60, staff_necessario: 1 });
    const t = await limpeza(c.e, p);
    await Ausencia.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, data_inicio: new Date(`${DIA}T00:00:00Z`), data_fim: new Date(`${DIA}T00:00:00Z`), tipo: 'ferias', estado: 'pendente' });
    const r = await lista(c.token, t._id);
    expect(r.status).toBe(200);
    const ana = r.body.disponiveis.find((d) => d.nome === 'Ana');
    const bia = r.body.disponiveis.find((d) => d.nome === 'Bia');
    expect(ana).toBeTruthy();
    expect(ana.ausencia_pendente).toBe(true);
    expect(bia.ausencia_pendente).toBe(false);
  });
});
