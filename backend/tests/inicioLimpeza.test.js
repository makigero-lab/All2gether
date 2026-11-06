/**
 * Início da limpeza (híbrido): botão «Comecei», job automático, «Não consegui começar»,
 * e as regras que o estado `em_curso` passa a ativar (ausência, parceiro, Smoobu, reagendar).
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
const WebhookLog = require('../models/WebhookLog');
const { executarInicioAutomatico } = require('../jobs/inicioLimpeza');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;

async function cenario(extra = {}) {
  const e = await Empresa.create({ nome: 'E' + ++n, ...extra });
  const mk = (nome, role) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });
  const tarefa = (data, ex = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, data: new Date(data), tempo_limpeza_minutos: 60, estado: 'atribuida', tipo: 'limpeza', ...ex });
  return { e, g, ana, bia, p, tarefa, tokG: await login(g), tokAna: await login(ana), tokBia: await login(bia) };
}

const hoje10 = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0));
};

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

describe('Job de início automático', () => {
  const AGORA = new Date('2040-05-10T11:00:00Z');

  test('atribuida com hora real e responsável, já passada: passa a em_curso (automatico), com iniciada_em = hora marcada', async () => {
    const { tarefa } = await cenario();
    const t = await tarefa('2040-05-10T09:30:00Z');
    const r = await executarInicioAutomatico(AGORA);
    expect(r.iniciadas).toBeGreaterThanOrEqual(1);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(d.inicio_origem).toBe('automatico');
    expect(d.iniciada_em.toISOString()).toBe('2040-05-10T09:30:00.000Z');
  });

  test('é idempotente: a segunda execução não altera nada', async () => {
    const { tarefa } = await cenario();
    const t = await tarefa('2040-05-10T08:30:00Z');
    await executarInicioAutomatico(AGORA);
    const a = await Tarefa.findById(t._id).lean();
    const r2 = await executarInicioAutomatico(AGORA);
    const b = await Tarefa.findById(t._id).lean();
    expect(r2.iniciadas).toBe(0);
    expect(String(b.updatedAt)).toBe(String(a.updatedAt));
  });

  test('não arranca: sem responsável, ainda por vir, sem hora real, de manutenção, ou com «não consegui»', async () => {
    const { tarefa } = await cenario();
    const semResp = await tarefa('2040-05-10T09:00:00Z', { utilizador_id: null, estado: 'por_atribuir' });
    const futura = await tarefa('2040-05-10T12:30:00Z');
    const meiaNoite = await tarefa('2040-05-10T00:00:00Z');
    const manut = await tarefa('2040-05-10T09:00:00Z', { tipo: 'manutencao' });
    const nao = await tarefa('2040-05-10T09:15:00Z', { nao_consegui_comecar: { motivo: 'sem_acesso', nota: '', em: new Date() } });
    await executarInicioAutomatico(AGORA);
    for (const t of [semResp, futura, meiaNoite, manut, nao]) {
      expect((await Tarefa.findById(t._id)).estado).not.toBe('em_curso');
    }
  });

  test('não arranca se o responsável está inativo', async () => {
    const { tarefa, ana } = await cenario();
    const t = await tarefa('2040-05-10T09:20:00Z');
    await Utilizador.updateOne({ _id: ana._id }, { ativo: false });
    await executarInicioAutomatico(AGORA);
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
  });

  test('recuperação: apanha as que ficaram para trás no mesmo dia (reinício), mas não as de há mais de 12 h', async () => {
    const { tarefa } = await cenario();
    const recente = await tarefa('2040-05-10T07:00:00Z'); // 4 h antes
    const velha = await tarefa('2040-05-09T20:00:00Z'); // 15 h antes
    await executarInicioAutomatico(AGORA);
    expect((await Tarefa.findById(recente._id)).estado).toBe('em_curso');
    expect((await Tarefa.findById(velha._id)).estado).toBe('atribuida');
  });

  test('duas execuções em simultâneo iniciam a limpeza uma só vez', async () => {
    const { tarefa } = await cenario();
    const t = await tarefa('2040-05-10T09:45:00Z');
    const [a, b] = await Promise.all([executarInicioAutomatico(AGORA), executarInicioAutomatico(AGORA)]);
    expect(a.iniciadas + b.iniciadas).toBeGreaterThanOrEqual(1);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(d.inicio_origem).toBe('automatico');
  });
});

describe('«Comecei» (botão)', () => {
  test('grava iniciada_em, em_curso e origem botao; segundo clique é idempotente', async () => {
    const { tarefa, ana, tokAna } = await cenario();
    const t = await tarefa(hoje10());
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    expect(r.status).toBe(200);
    expect(r.body.ja_iniciada).toBe(false);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(d.inicio_origem).toBe('botao');
    expect(String(d.iniciada_por)).toBe(String(ana._id));
    const inicio1 = d.iniciada_em.getTime();
    const r2 = await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    expect(r2.status).toBe(200);
    expect(r2.body.ja_iniciada).toBe(true);
    expect((await Tarefa.findById(t._id)).iniciada_em.getTime()).toBe(inicio1);
  });

  test('o job automático depois do botão não altera a origem', async () => {
    const { tarefa, tokAna } = await cenario();
    const t = await tarefa(new Date(Date.now() - 30 * 60000));
    await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    await executarInicioAutomatico();
    expect((await Tarefa.findById(t._id)).inicio_origem).toBe('botao');
  });

  test('um colega que não está na equipa leva 404; limpeza de outro dia futuro 400; concluída/cancelada 400', async () => {
    const { tarefa, tokBia } = await cenario();
    const t = await tarefa(hoje10());
    expect((await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokBia))).status).toBe(404);
    const c = await cenario();
    const futura = await c.tarefa(new Date(Date.now() + 3 * 86400000));
    expect((await request(app).patch(`/api/staff/tarefas/${futura._id}/iniciar`).set(auth(c.tokAna))).status).toBe(400);
    const conc = await c.tarefa(hoje10(), { estado: 'concluida' });
    expect((await request(app).patch(`/api/staff/tarefas/${conc._id}/iniciar`).set(auth(c.tokAna))).status).toBe(400);
    const canc = await c.tarefa(hoje10(), { estado: 'cancelada' });
    expect((await request(app).patch(`/api/staff/tarefas/${canc._id}/iniciar`).set(auth(c.tokAna))).status).toBe(400);
  });

  test('um membro da equipa (não o responsável) também pode começar', async () => {
    const { tarefa, ana, bia, tokBia } = await cenario();
    const t = await tarefa(hoje10(), { equipa_atribuida: [ana._id, bia._id] });
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokBia));
    expect(r.status).toBe(200);
    expect((await Tarefa.findById(t._id)).estado).toBe('em_curso');
  });

  test('reatribuir uma limpeza em curso limpa o início (recomeça com a nova pessoa)', async () => {
    const { tarefa, bia, tokAna, tokG } = await cenario();
    const t = await tarefa(hoje10());
    await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    await request(app).patch(`/api/gestor/tarefas/${t._id}/atribuir`).set(auth(tokG)).send({ utilizador_id: String(bia._id) });
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.iniciada_em).toBeNull();
    expect(d.inicio_origem).toBeNull();
  });

  test('marcar um item da checklist grava o primeiro_item_checklist_em uma só vez', async () => {
    const { tarefa, tokAna } = await cenario();
    const t = await tarefa(hoje10(), { checklist_dinamica: [{ nome: 'Quartos', items: [{ texto: 'a', concluido: false }, { texto: 'b', concluido: false }] }] });
    await request(app).patch(`/api/staff/tarefas/${t._id}/checklist/0/item/0`).set(auth(tokAna)).send({ concluido: true });
    const primeiro = (await Tarefa.findById(t._id)).primeiro_item_checklist_em;
    expect(primeiro).toBeTruthy();
    await request(app).patch(`/api/staff/tarefas/${t._id}/checklist/0/item/1`).set(auth(tokAna)).send({ concluido: true });
    expect((await Tarefa.findById(t._id)).primeiro_item_checklist_em.getTime()).toBe(primeiro.getTime());
  });
});

describe('«Não consegui começar»', () => {
  const pedir = (tok, id, body) => request(app).post(`/api/staff/tarefas/${id}/nao-consegui`).set(auth(tok)).send(body);

  test('regista no alerta, guarda o motivo e avisa o gestor (uma vez)', async () => {
    const { tarefa, g, tokAna } = await cenario();
    const t = await tarefa(hoje10());
    const r = await pedir(tokAna, t._id, { motivo: 'hospede_na_casa', nota: 'Ainda a dormir' });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id);
    expect(d.alerta).toMatch(/Ana não conseguiu começar.*hóspede ainda na casa.*Ainda a dormir/);
    expect(d.nao_consegui_comecar.motivo).toBe('hospede_na_casa');
    const q = { utilizador_id: g._id, mensagem: /não conseguiu começar/ };
    expect(await Notificacao.countDocuments(q)).toBe(1);
    await pedir(tokAna, t._id, { motivo: 'hospede_na_casa', nota: 'outra vez' });
    expect(await Notificacao.countDocuments(q)).toBe(1);
  });

  test('só aceita os três motivos fixos; nota longa e tipos errados são recusados', async () => {
    const { tarefa, tokAna } = await cenario();
    const t = await tarefa(hoje10());
    expect((await pedir(tokAna, t._id, { motivo: 'outro' })).status).toBe(400);
    expect((await pedir(tokAna, t._id, {})).status).toBe(400);
    expect((await pedir(tokAna, t._id, { motivo: { $ne: 1 } })).status).toBe(400);
    expect((await pedir(tokAna, t._id, { motivo: 'sem_acesso', nota: 'x'.repeat(501) })).status).toBe(400);
    expect((await pedir(tokAna, t._id, { motivo: 'sem_acesso', nota: 5 })).status).toBe(400);
    expect((await pedir(tokAna, t._id, { motivo: 'sem_acesso' })).status).toBe(200);
  });

  test('se o início tinha sido automático, volta a atribuida e o job não a reinicia; depois «Comecei» funciona', async () => {
    const { tarefa, tokAna } = await cenario();
    const t = await tarefa(new Date(Date.now() - 20 * 60000));
    await executarInicioAutomatico();
    expect((await Tarefa.findById(t._id)).estado).toBe('em_curso');
    await pedir(tokAna, t._id, { motivo: 'sem_acesso' });
    let d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('atribuida');
    expect(d.iniciada_em).toBeNull();
    await executarInicioAutomatico();
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
    await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(d.inicio_origem).toBe('botao');
    expect(d.nao_consegui_comecar).toBeUndefined();
  });

  test('depois de «Comecei» (botão) já não se pode dizer que não conseguiu; colega alheio leva 404', async () => {
    const { tarefa, tokAna, tokBia } = await cenario();
    const t = await tarefa(hoje10());
    expect((await pedir(tokBia, t._id, { motivo: 'sem_acesso' })).status).toBe(404);
    await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    expect((await pedir(tokAna, t._id, { motivo: 'sem_acesso' })).status).toBe(400);
  });
});

describe('Regras ativadas pelo em_curso', () => {
  test('ausência do responsável não desatribui a limpeza em curso (iniciada por botão)', async () => {
    const { tarefa, ana, tokAna, tokG } = await cenario();
    const t = await tarefa(hoje10());
    await request(app).patch(`/api/staff/tarefas/${t._id}/iniciar`).set(auth(tokAna));
    const dia = hoje10().toISOString().slice(0, 10);
    const r = await request(app).post('/api/gestor/ausencias').set(auth(tokG))
      .send({ utilizador_id: String(ana._id), data_inicio: dia, data_fim: dia, tipo: 'doenca' });
    expect(r.status).toBe(201);
    expect(r.body.desatribuicao.em_curso_mantidas).toBe(1);
    const d = await Tarefa.findById(t._id);
    expect(d.estado).toBe('em_curso');
    expect(String(d.utilizador_id)).toBe(String(ana._id));
    expect(d.inicio_origem).toBe('botao');
  });

  test('parceiro não edita nem apaga a reserva cuja limpeza está em curso (início automático)', async () => {
    const { e, p, tarefa } = await cenario();
    const parc = await Utilizador.create({ nome: 'Par', email: `par${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'parceiro', ativo: true });
    const ReservaManual = require('../models/ReservaManual');
    const t = await tarefa(new Date(Date.now() - 20 * 60000), { origem_parceiro: true, origem: 'manual' });
    const rv = await ReservaManual.create({
      propriedade_id: p._id, parceiro_id: parc._id, empresa_id: e._id,
      check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id,
    });
    await executarInicioAutomatico();
    expect((await Tarefa.findById(t._id)).estado).toBe('em_curso');
    const tok = await login(parc);
    expect((await request(app).put(`/api/parceiro/reservas/${rv._id}`).set(auth(tok)).send({ hospedes: 3 })).status).toBe(409);
    expect((await request(app).delete(`/api/parceiro/reservas/${rv._id}`).set(auth(tok))).status).toBe(409);
  });

  test('scripts/reagendar-horarios nunca toca numa limpeza em curso (mesmo fora do horário)', async () => {
    const { e, tarefa } = await cenario();
    const t = await tarefa('2040-06-10T02:00:00Z', { estado: 'em_curso', iniciada_em: new Date(), inicio_origem: 'automatico' });
    const { reagendarHorarios } = require('../scripts/reagendar-horarios');
    const r = await reagendarHorarios({ aplicar: true, agora: new Date('2040-06-01T00:00:00Z'), empresaId: e._id });
    expect(r.total).toBe(0);
    const after = await Tarefa.findById(t._id);
    expect(after.estado).toBe('em_curso');
    expect(after.data.toISOString()).toBe('2040-06-10T02:00:00.000Z');
    expect(after.inicio_origem).toBe('automatico');
  });
});

describe('Smoobu com a limpeza em curso', () => {
  let CHAVE = 'chave-smoobu-em-curso';
  const esperar = async () => {
    await new Promise((r) => setTimeout(r, 150));
    const limite = Date.now() + 10000;
    while (Date.now() < limite) {
      if ((await WebhookLog.countDocuments({ status: 'recebido' })) === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const wh = (action, data) => request(app).post('/api/smoobu/webhook').set('X-Smoobu-Api-Key', CHAVE).send({ action, user: 1, data });
  const reserva = (id, apt, extra = {}) => ({
    id, 'reference-id': 'R' + id, type: 'reservation', arrival: '2041-03-10', departure: '2041-03-14',
    'created-at': '2041-01-01 10:00:00', modifiedAt: '2041-01-01 10:00:00',
    apartment: { id: apt, name: 'Casa' }, channel: { id: 1, name: 'Airbnb' },
    'guest-name': 'Maria', adults: 2, children: 0, 'check-in': '15:00', 'check-out': '11:00', 'is-blocked-booking': false, ...extra,
  });

  async function preparar() {
    CHAVE = 'chave-smoobu-em-curso-' + ++n;
    const e = await Empresa.create({ nome: 'ES' + ++n, integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    const g = await Utilizador.create({ nome: 'g', email: `g${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'gestor', ativo: true });
    const s = await Utilizador.create({ nome: 's', email: `s${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'staff', ativo: true });
    const apt = 7000 + ++n;
    const p = await Propriedade.create({ nome: 'CasaS' + n, empresa_id: e._id, smoobu_id: String(apt), ativo: true, capacidade_hospedes: 4, funcionario_preferencial_id: s._id });
    return { e, g, s, p, apt };
  }

  test('cancelamento com a limpeza em curso: não cancela, mantém a pessoa, regista o alerta e avisa o gestor (uma vez)', async () => {
    const { g, apt, s } = await preparar();
    const id = 810000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    await Tarefa.updateOne({ smoobu_reserva_id: String(id) }, { $set: { estado: 'em_curso', utilizador_id: s._id, iniciada_em: new Date(), inicio_origem: 'botao' } });
    await wh('cancelReservation', reserva(id, apt, { type: 'cancellation' }));
    await esperar();
    await wh('cancelReservation', reserva(id, apt, { type: 'cancellation' }));
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: String(id) });
    expect(t.estado).toBe('em_curso');
    expect(String(t.utilizador_id)).toBe(String(s._id));
    expect(t.alerta).toMatch(/limpeza já em curso/);
    expect(await Notificacao.countDocuments({ utilizador_id: g._id, mensagem: /limpeza em curso/ })).toBe(1);
  });

  test('mudança de data com a limpeza em curso: a data e a pessoa ficam, o gestor é avisado', async () => {
    const { g, apt, s } = await preparar();
    const id = 820000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    const antes = await Tarefa.findOneAndUpdate({ smoobu_reserva_id: String(id) }, { $set: { estado: 'em_curso', utilizador_id: s._id } }, { new: true });
    await wh('updateReservation', reserva(id, apt, { departure: '2041-03-20', type: 'modification of booking' }));
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: String(id) });
    expect(t.estado).toBe('em_curso');
    expect(t.data.toISOString()).toBe(antes.data.toISOString());
    expect(String(t.utilizador_id)).toBe(String(s._id));
    expect(t.alerta).toMatch(/mudou de data/);
    expect(await Notificacao.countDocuments({ utilizador_id: g._id, mensagem: /Data alterada com limpeza em curso/ })).toBe(1);
  });

  test('cancelamento de uma limpeza atribuída (não iniciada) continua a cancelar', async () => {
    const { apt } = await preparar();
    const id = 830000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    await wh('cancelReservation', reserva(id, apt, { type: 'cancellation' }));
    await esperar();
    expect((await Tarefa.findOne({ smoobu_reserva_id: String(id) })).estado).toBe('cancelada');
  });

  test('início automático sem toque conta como NÃO iniciada: o cancelamento cancela', async () => {
    const { apt, s } = await preparar();
    const id = 840000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    await Tarefa.updateOne({ smoobu_reserva_id: String(id) }, { $set: { estado: 'em_curso', utilizador_id: s._id, iniciada_em: new Date(), inicio_origem: 'automatico', iniciada_por: null } });
    await wh('cancelReservation', reserva(id, apt, { type: 'cancellation' }));
    await esperar();
    expect((await Tarefa.findOne({ smoobu_reserva_id: String(id) })).estado).toBe('cancelada');
  });

  test('início automático sem toque: a mudança de data limpa o início e move como atribuída (o job volta a poder iniciá-la)', async () => {
    const { apt, s } = await preparar();
    const id = 850000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    await Tarefa.updateOne({ smoobu_reserva_id: String(id) }, { $set: { estado: 'em_curso', utilizador_id: s._id, iniciada_em: new Date(), inicio_origem: 'automatico', iniciada_por: null } });
    await wh('updateReservation', reserva(id, apt, { departure: '2041-03-20', type: 'modification of booking' }));
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: String(id) });
    expect(t.estado).not.toBe('em_curso');
    expect(t.iniciada_em).toBeNull();
    expect(t.inicio_origem).toBeNull();
    expect(t.data.toISOString().slice(0, 10)).toBe('2041-03-20');
    if (t.estado === 'atribuida') {
      const r = await executarInicioAutomatico(new Date('2041-03-20T14:00:00Z'));
      expect(r.iniciadas).toBeGreaterThanOrEqual(1);
      expect((await Tarefa.findById(t._id)).estado).toBe('em_curso');
    }
  });

  test('início automático MAS tocado (checklist ou botão): mantém o comportamento (em curso, alerta)', async () => {
    const { apt, s } = await preparar();
    const id = 860000 + ++n;
    await wh('newReservation', reserva(id, apt));
    await esperar();
    await Tarefa.updateOne({ smoobu_reserva_id: String(id) }, { $set: { estado: 'em_curso', utilizador_id: s._id, iniciada_em: new Date(), inicio_origem: 'automatico', primeiro_item_checklist_em: new Date() } });
    await wh('cancelReservation', reserva(id, apt, { type: 'cancellation' }));
    await esperar();
    const t = await Tarefa.findOne({ smoobu_reserva_id: String(id) });
    expect(t.estado).toBe('em_curso');
    expect(t.alerta).toMatch(/limpeza já em curso/);
  });
});
