/**
 * Reatribuição automática depois de uma ausência (falta súbita, baixa, registo
 * pelo gestor): sem clique, a pessoa ausente nunca recebe tarefas, quem recebe
 * é avisado, sem ninguém disponível ficam por atribuir e o gestor é avisado,
 * e uma falha na reatribuição não parte a operação principal.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Notificacao = require('../models/Notificacao');
const Ausencia = require('../models/Ausencia');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);

async function cenario({ comBia = true } = {}) {
  const e = await Empresa.create({ nome: 'R' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = comBia ? await mk('Bia', 'staff') : null;
  const p = await Propriedade.create({ nome: 'Casa Azul', empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const token = (await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' })).body.token;
  const tarefa = (dia, hora, estado = 'atribuida') =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, data: new Date(`${dia}T${hora}:00Z`), estado });
  return { e, g, ana, bia, p, token, tarefa };
}
const auth = (t) => ({ Authorization: 'Bearer ' + t });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
afterEach(() => jest.restoreAllMocks());

describe('reatribuição automática após ausência', () => {
  test('falta súbita (hoje): vai para outra pessoa, nunca para a ausente, e quem recebe é avisado', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const { ana, bia, token, tarefa } = await cenario();
    const t1 = await tarefa(hoje, '09:00');
    const t2 = await tarefa(hoje, '12:00');
    const r = await request(app).post(`/api/gestor/equipa/${ana._id}/falta-subita`).set(auth(token)).send({});
    expect(r.status).toBe(200);
    expect(r.body.desatribuidas).toBe(2);
    expect(r.body.reatribuicao).toMatchObject({ reatribuidas: 2, orfas: 0 });
    expect(r.body.reatribuicao.erro).toBeUndefined();
    for (const t of [t1, t2]) {
      const d = await Tarefa.findById(t._id);
      expect(String(d.utilizador_id)).toBe(String(bia._id));
      expect(d.estado).toBe('atribuida');
    }
    const notif = await Notificacao.find({ utilizador_id: bia._id, tipo: 'tarefa_reatribuida' });
    expect(notif.length).toBe(1); // uma notificação por pessoa
    expect(notif[0].mensagem).toMatch(/2 limpezas/);
  });

  test('baixa de vários dias: nenhum dia do período vai para a pessoa ausente', async () => {
    const { ana, bia, token, tarefa } = await cenario();
    const ts = [
      await tarefa('2032-05-10', '10:00'),
      await tarefa('2032-05-11', '10:00'),
      await tarefa('2032-05-12', '10:00'),
    ];
    const r = await request(app)
      .post(`/api/gestor/equipa/${ana._id}/baixa`)
      .set(auth(token))
      .send({ data_inicio: '2032-05-10', data_fim: '2032-05-12', tipo: 'doenca' });
    expect(r.status).toBe(200);
    expect(r.body.reatribuicao).toMatchObject({ reatribuidas: 3, orfas: 0 });
    for (const t of ts) {
      const d = await Tarefa.findById(t._id);
      expect(String(d.utilizador_id)).toBe(String(bia._id));
    }
    expect(await Tarefa.countDocuments({ utilizador_id: ana._id, estado: 'atribuida' })).toBe(0);
  });

  test('registo de ausência pelo gestor reatribui logo', async () => {
    const { ana, bia, token, tarefa } = await cenario();
    const t = await tarefa('2032-06-10', '10:00');
    const r = await request(app)
      .post('/api/gestor/ausencias')
      .set(auth(token))
      .send({ utilizador_id: String(ana._id), data_inicio: '2032-06-10', data_fim: '2032-06-10', tipo: 'ferias' });
    expect(r.status).toBe(201);
    expect(r.body.desatribuicao.reatribuicao).toMatchObject({ reatribuidas: 1, orfas: 0 });
    expect(String((await Tarefa.findById(t._id)).utilizador_id)).toBe(String(bia._id));
  });

  test('a outra pessoa também está ausente: não recebe; fica por atribuir e o gestor é avisado', async () => {
    const { e, ana, bia, g, token, tarefa } = await cenario();
    await Ausencia.create({ utilizador_id: bia._id, empresa_id: e._id, data_inicio: new Date('2032-07-10T00:00:00Z'), data_fim: new Date('2032-07-10T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    const t = await tarefa('2032-07-10', '10:00');
    const r = await request(app)
      .post(`/api/gestor/equipa/${ana._id}/baixa`)
      .set(auth(token))
      .send({ data_inicio: '2032-07-10', data_fim: '2032-07-10', tipo: 'doenca' });
    expect(r.status).toBe(200);
    expect(r.body.reatribuicao).toMatchObject({ reatribuidas: 0, orfas: 1 });
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('por_atribuir');
    expect(d.utilizador_id).toBeNull();
    const avisos = await Notificacao.find({ utilizador_id: g._id, mensagem: /por atribuir/ });
    expect(avisos.length).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: bia._id, tipo: 'tarefa_reatribuida' })).toBe(0);
  });

  test('sem mais ninguém na equipa: fica por atribuir e o gestor é avisado', async () => {
    const { ana, g, token, tarefa } = await cenario({ comBia: false });
    const t = await tarefa('2032-08-10', '10:00');
    const r = await request(app)
      .post(`/api/gestor/equipa/${ana._id}/baixa`)
      .set(auth(token))
      .send({ data_inicio: '2032-08-10', data_fim: '2032-08-10', tipo: 'doenca' });
    expect(r.body.reatribuicao).toMatchObject({ reatribuidas: 0, orfas: 1 });
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
    expect(await Notificacao.countDocuments({ utilizador_id: g._id, tipo: 'aviso', mensagem: /por atribuir/ })).toBe(1);
  });

  test('se a reatribuição falhar, a baixa sucede, as tarefas ficam por atribuir e a resposta traz o erro', async () => {
    const { ana, g, token, tarefa } = await cenario();
    const t = await tarefa('2032-09-10', '10:00');
    const original = Tarefa.find.bind(Tarefa);
    jest.spyOn(Tarefa, 'find').mockImplementation((filtro, ...resto) => {
      // a pesquisa de "por atribuir" da reatribuição rebenta; as restantes seguem normalmente
      if (filtro && filtro.estado && Array.isArray(filtro.estado.$in) && filtro.estado.$in.includes('nao_atribuida')) {
        throw new Error('falha simulada');
      }
      return original(filtro, ...resto);
    });
    const r = await request(app)
      .post(`/api/gestor/equipa/${ana._id}/baixa`)
      .set(auth(token))
      .send({ data_inicio: '2032-09-10', data_fim: '2032-09-10', tipo: 'doenca' });
    jest.restoreAllMocks();
    expect(r.status).toBe(200);
    expect(r.body.desatribuidas).toBe(1);
    expect(r.body.reatribuicao.erro).toMatch(/falha simulada/);
    expect(await Ausencia.countDocuments({ utilizador_id: ana._id, estado: 'aprovada' })).toBe(1);
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
    expect(await Notificacao.countDocuments({ utilizador_id: g._id, mensagem: /não foi possível reatribuir/ })).toBe(1);
  });

  test('em curso não é tocada: fica com a pessoa e os gestores são avisados', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const { ana, bia, g, token, tarefa } = await cenario();
    const te = await tarefa(hoje, '11:00', 'em_curso');
    const ta = await tarefa(hoje, '14:00');
    const r = await request(app).post(`/api/gestor/equipa/${ana._id}/falta-subita`).set(auth(token)).send({});
    expect(r.status).toBe(200);
    expect(r.body.em_curso_mantidas).toBe(1);
    const e = await Tarefa.findById(te._id);
    expect(e.estado).toBe('em_curso');
    expect(String(e.utilizador_id)).toBe(String(ana._id));
    expect(String((await Tarefa.findById(ta._id)).utilizador_id)).toBe(String(bia._id));
    expect(await Notificacao.countDocuments({ utilizador_id: g._id, mensagem: /em curso/ })).toBe(1);
  });

  test('repetir a falta súbita no mesmo dia não duplica a ausência nem dá erro', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const { ana, token, tarefa } = await cenario();
    await tarefa(hoje, '09:00');
    const r1 = await request(app).post(`/api/gestor/equipa/${ana._id}/falta-subita`).set(auth(token)).send({});
    const r2 = await request(app).post(`/api/gestor/equipa/${ana._id}/falta-subita`).set(auth(token)).send({});
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.desatribuidas).toBe(0);
    expect(await Ausencia.countDocuments({ utilizador_id: ana._id })).toBe(1);
  });

  test('repetir a mesma baixa não duplica a ausência', async () => {
    const { ana, token, tarefa } = await cenario();
    await tarefa('2032-06-10', '10:00');
    const corpo = { data_inicio: '2032-06-10', data_fim: '2032-06-12', tipo: 'doenca' };
    const r1 = await request(app).post(`/api/gestor/equipa/${ana._id}/baixa`).set(auth(token)).send(corpo);
    const r2 = await request(app).post(`/api/gestor/equipa/${ana._id}/baixa`).set(auth(token)).send(corpo);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await Ausencia.countDocuments({ utilizador_id: ana._id })).toBe(1);
  });
});
