/**
 * Fecho automático às 20:00: job (só em_curso com pessoa, só limpezas, idempotente, corrida com a pessoa),
 * marca de fecho automático (sem aviso ao proprietário, sem hora de conclusão na prova, fora do tempo real),
 * confirmação tardia pela pessoa, lista do gestor e crons separados do Cão de Guarda (18:00 / 19:00).
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const { executarFechoAutomatico, diasParaFechar } = require('../jobs/fechoAutomatico');
const { avisarParceiro, aoConcluirTarefa } = require('../utils/cicloTarefa');
const { duracaoRealMinutos, calcularPorCasa } = require('../utils/tempoReal');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const FOTO = 'data:image/jpeg;base64,/9j/4AAQ';

// 10/05/2040 às 20:00 de Lisboa (verão = UTC+1) e a tarefa das 11:00 locais do mesmo dia.
const AGORA = new Date('2040-05-10T19:00:00Z');
const T_HOJE = new Date('2040-05-10T10:00:00Z');
const T_ONTEM = new Date('2040-05-09T10:00:00Z');
const T_AMANHA = new Date('2040-05-11T10:00:00Z');

async function cenario() {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const parc = await mk('Par', 'parceiro');
  const p = await Propriedade.create({
    nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4,
    tempo_limpeza_minutos: 60, parceiro_id: parc._id,
  });
  const tarefa = (data, ex = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, data, tempo_limpeza_minutos: 60, estado: 'em_curso', tipo: 'limpeza', ...ex });
  const reserva = (t) =>
    ReservaManual.create({ propriedade_id: p._id, parceiro_id: parc._id, empresa_id: e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
  return { e, g, ana, parc, p, tarefa, reserva, tokG: await login(g), tokAna: await login(ana), tokP: await login(parc) };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  await Notificacao.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Tarefa.deleteMany({});
  await Notificacao.deleteMany({});
});
afterEach(() => jest.restoreAllMocks());

describe('Job de fecho automático', () => {
  test('em_curso com pessoa fecha: marca automática, concluida_em = hora do fecho, sem hora_conclusao', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { inicio_origem: 'botao', iniciada_em: T_HOJE, iniciada_por: c.ana._id });
    const r = await executarFechoAutomatico(AGORA);
    expect(r.fechadas).toBe(1);
    const d = await Tarefa.findById(t._id).lean();
    expect(d.estado).toBe('concluida');
    expect(d.conclusao_origem).toBe('automatica');
    expect(d.concluida_em.toISOString()).toBe(AGORA.toISOString());
    expect(d.fechada_automaticamente_em.toISOString()).toBe(AGORA.toISOString());
    expect(d.hora_conclusao).toBeNull();
  });

  test('não fecha: sem pessoa, manutenção, atribuida, cancelada, concluída, outro dia', async () => {
    const c = await cenario();
    const semPessoa = await c.tarefa(T_HOJE, { utilizador_id: null });
    const manut = await c.tarefa(T_HOJE, { tipo: 'manutencao' });
    const atrib = await c.tarefa(T_HOJE, { estado: 'atribuida' });
    const canc = await c.tarefa(T_HOJE, { estado: 'cancelada' });
    const conc = await c.tarefa(T_HOJE, { estado: 'concluida', concluida_em: new Date('2040-05-10T15:00:00Z'), conclusao_origem: 'staff' });
    const amanha = await c.tarefa(T_AMANHA);
    const antiga = await c.tarefa(new Date('2040-05-05T10:00:00Z')); // além da janela de recuperação
    const r = await executarFechoAutomatico(AGORA);
    expect(r.fechadas).toBe(0);
    const estados = async (t) => (await Tarefa.findById(t._id).lean()).estado;
    expect(await estados(semPessoa)).toBe('em_curso');
    expect(await estados(manut)).toBe('em_curso');
    expect(await estados(atrib)).toBe('atribuida');
    expect(await estados(canc)).toBe('cancelada');
    expect(await estados(amanha)).toBe('em_curso');
    expect(await estados(antiga)).toBe('em_curso');
    const concDepois = await Tarefa.findById(conc._id).lean();
    expect(concDepois.conclusao_origem).toBe('staff');
    expect(concDepois.fechada_automaticamente_em).toBeNull();
  });

  test('antes das 20:00 não fecha o dia de hoje, mas recupera o dia anterior', async () => {
    const c = await cenario();
    const hoje = await c.tarefa(T_HOJE);
    const ontem = await c.tarefa(T_ONTEM);
    const as1959 = new Date('2040-05-10T18:59:00Z'); // 19:59 em Lisboa
    expect(diasParaFechar(as1959)).not.toContain('2040-05-10');
    const r = await executarFechoAutomatico(as1959);
    expect(r.fechadas).toBe(1);
    expect((await Tarefa.findById(hoje._id).lean()).estado).toBe('em_curso');
    expect((await Tarefa.findById(ontem._id).lean()).estado).toBe('concluida');
  });

  test('dupla execução é idempotente (não renova a hora do fecho)', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(1);
    const r2 = await executarFechoAutomatico(new Date(AGORA.getTime() + 3600000));
    expect(r2.fechadas).toBe(0);
    expect((await Tarefa.findById(t._id).lean()).concluida_em.toISOString()).toBe(AGORA.toISOString());
  });

  test('corrida: a pessoa fecha entre a leitura e a escrita e o job não lhe passa por cima', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    const realFind = Tarefa.find.bind(Tarefa);
    const horaPessoa = new Date('2040-05-10T18:59:30Z');
    jest.spyOn(Tarefa, 'find').mockImplementationOnce((...args) => {
      const q = realFind(...args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const docs = await exec();
        // a pessoa conclui depois de o job ter lido a lista
        await Tarefa.updateOne({ _id: t._id }, { $set: { estado: 'concluida', conclusao_origem: 'staff', concluida_em: horaPessoa, hora_conclusao: horaPessoa } });
        return docs;
      };
      return q;
    });
    const r = await executarFechoAutomatico(AGORA);
    expect(r.candidatas).toBe(1);
    expect(r.fechadas).toBe(0);
    const d = await Tarefa.findById(t._id).lean();
    expect(d.conclusao_origem).toBe('staff');
    expect(d.hora_conclusao.toISOString()).toBe(horaPessoa.toISOString());
    expect(d.fechada_automaticamente_em).toBeNull();
  });

  test('se o gestor a reabrir, o job não a volta a fechar', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const r = await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'em_curso' });
    expect(r.status).toBe(200);
    const d1 = await Tarefa.findById(t._id).lean();
    expect(d1.estado).toBe('em_curso');
    expect(d1.conclusao_origem).toBeNull();
    expect((await executarFechoAutomatico(new Date(AGORA.getTime() + 3600000))).fechadas).toBe(0);
  });
});

describe('Proprietário e tempo real', () => {
  test('o proprietário não recebe aviso de «concluída» no fecho automático', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await c.reserva(t);
    await executarFechoAutomatico(AGORA);
    const d = await Tarefa.findById(t._id).lean();
    expect(await avisarParceiro(d, 'concluida')).toBe(false);
    await aoConcluirTarefa(d);
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(0);
  });

  test('a prova do proprietário diz que foi fechada pelo sistema, sem hora nem «fotos expiradas»', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    const reserva = await c.reserva(t);
    await executarFechoAutomatico(AGORA);
    const r = await request(app).get(`/api/parceiro/reservas/${reserva._id}/limpeza`).set(auth(c.tokP));
    expect(r.status).toBe(200);
    expect(r.body.fechada_automaticamente).toBe(true);
    expect(r.body.hora_conclusao).toBeNull();
    expect(r.body.fotos_expiradas).toBe(false);
    const lista = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    const tarefa = lista.body.reservas[0].tarefa_gerada_id;
    expect(tarefa.fechada_automaticamente).toBe(true);
    expect(tarefa.hora_conclusao).toBeNull();
    expect(tarefa.concluida_em).toBeNull();
    // o gestor também vê que foi automática
    const prova = await request(app).get(`/api/gestor/tarefas/${t._id}/prova`).set(auth(c.tokG));
    expect(prova.body.fechada_automaticamente).toBe(true);
    expect(prova.body.hora_conclusao).toBeNull();
  });

  test('tempo real exclui o fecho automático, mesmo com «Comecei» e mesmo confirmado depois', () => {
    const base = {
      propriedade_id: new mongoose.Types.ObjectId(), tempo_limpeza_minutos: 60, tipo_limpeza: 'normal',
      inicio_origem: 'botao', iniciada_em: new Date('2040-05-10T10:00:00Z'), concluida_em: new Date('2040-05-10T11:00:00Z'),
    };
    expect(duracaoRealMinutos(base)).toBe(60);
    expect(duracaoRealMinutos({ ...base, conclusao_origem: 'automatica', concluida_em: new Date('2040-05-10T19:00:00Z') })).toBeNull();
    expect(duracaoRealMinutos({ ...base, conclusao_origem: 'staff', fechada_automaticamente_em: new Date('2040-05-10T19:00:00Z') })).toBeNull();
    const { casas, excluidas } = calcularPorCasa([{ ...base, conclusao_origem: 'automatica' }], new Map());
    expect(casas).toHaveLength(0);
    expect(excluidas).toBe(1);
  });

  test('relatório de tempo real da API ignora o fecho automático', async () => {
    const c = await cenario();
    const hoje = new Date();
    const dia = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 10));
    await c.tarefa(dia, {
      estado: 'concluida', inicio_origem: 'botao', iniciada_em: dia, concluida_em: new Date(dia.getTime() + 3600000),
      conclusao_origem: 'automatica', fechada_automaticamente_em: new Date(dia.getTime() + 3600000),
    });
    const r = await request(app).get('/api/gestor/relatorios/tempo-real').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.casas).toHaveLength(0);
    expect(r.body.inicios.botao).toBe(0);
  });
});

describe('Confirmação tardia pela pessoa', () => {
  test('a pessoa junta fotos e notas no dia seguinte: passa a conclusão dela, com a hora real, sem aviso ao proprietário', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await c.reserva(t);
    await executarFechoAutomatico(AGORA);
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna))
      .send({ fotos_conclusao: [FOTO], observacoes_staff: 'Deixei tudo pronto' });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id).lean();
    expect(d.estado).toBe('concluida');
    expect(d.conclusao_origem).toBe('staff');
    expect(d.confirmada_depois_em).toBeTruthy();
    // hora real da confirmação (agora), não a das 20:00 do fecho
    expect(d.hora_conclusao.getTime()).not.toBe(AGORA.getTime());
    expect(Math.abs(d.hora_conclusao.getTime() - Date.now())).toBeLessThan(60000);
    expect(d.fotos_conclusao).toHaveLength(1);
    expect(d.fechada_automaticamente_em.toISOString()).toBe(AGORA.toISOString());
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(0);
    // e um segundo clique já não repete
    const r2 = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(r2.status).toBe(400);
    // tempo real continua a excluí-la
    expect(duracaoRealMinutos({ ...d, inicio_origem: 'botao', iniciada_em: T_HOJE })).toBeNull();
  });

  test('colega de outra empresa não consegue confirmar (404)', async () => {
    const c = await cenario();
    const outro = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(outro.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(r.status).toBe(404);
  });
});

describe('Lista do gestor «Fechadas automaticamente»', () => {
  test('só os fechos recentes da empresa (7 dias por omissão), com pessoas, casa e o que a pessoa acrescentou', async () => {
    const c = await cenario();
    const outra = await cenario();
    const agora = new Date();
    const dia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10));
    const mk = (cen, ex) => cen.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, fechada_automaticamente_em: agora, ...ex });
    const t1 = await mk(c, {});
    const t2 = await mk(c, { conclusao_origem: 'staff', confirmada_depois_em: agora, fotos_conclusao: [FOTO] });
    await mk(outra, {});
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'staff', concluida_em: agora, hora_conclusao: agora }); // normal: não entra
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', fechada_automaticamente_em: new Date(agora.getTime() - 20 * 86400000) }); // antigo

    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const m = new Map(r.body.limpezas.map((l) => [l._id, l]));
    expect(m.get(String(t1._id)).acrescentou_algo).toBe(false);
    expect(m.get(String(t1._id)).pessoas.map((p) => p.nome)).toEqual(['Ana']);
    expect(m.get(String(t1._id)).casa.nome).toBe(c.p.nome);
    expect(m.get(String(t2._id)).confirmada_depois).toBe(true);
    expect(m.get(String(t2._id)).acrescentou_algo).toBe(true);
    expect(m.get(String(t2._id)).acrescentou.fotos).toBe(1);
    // 30 dias apanha o antigo
    const r30 = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente?dias=30').set(auth(c.tokG));
    expect(r30.body.total).toBe(3);
  });

  test('só o gestor acede', async () => {
    const c = await cenario();
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokAna))).status).toBe(403);
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente')).status).toBe(401);
  });
});

describe('Cão de Guarda: fases em horas diferentes', () => {
  test('18:00 atribuição de emergência e 19:00 lembrete de fecho', () => {
    const espiao = jest.spyOn(cron, 'schedule').mockImplementation(() => ({ stop() {} }));
    const { iniciarCaoGuarda } = require('../jobs/caoGuarda');
    iniciarCaoGuarda();
    const expr = espiao.mock.calls.map((c) => c[0]);
    expect(expr).toEqual(['0 18 * * *', '0 19 * * *']);
    expect(espiao.mock.calls.every((c) => c[2].timezone === 'Europe/Lisbon')).toBe(true);
  });

  test('o fecho automático agenda às 20:00 de Lisboa', () => {
    const espiao = jest.spyOn(cron, 'schedule').mockImplementation(() => ({ stop() {} }));
    require('../jobs/fechoAutomatico').iniciarFechoAutomatico();
    expect(espiao.mock.calls[0][0]).toBe('0 20 * * *');
    expect(espiao.mock.calls[0][2].timezone).toBe('Europe/Lisbon');
  });
});
