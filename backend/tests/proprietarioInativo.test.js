/**
 * Desativar proprietário (casas + limpezas futuras), casas inativas sem limpezas, inativos nas listas,
 * "Nova limpeza" e "Apagar limpezas futuras".
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const { processarReservaSmoobu } = require('../controllers/smoobuController');
const { executarGeradorRotinas } = require('../jobs/geradorRotinas');
const { abrirOferta } = require('../utils/ofertaVaga');
const { impactoDesativar } = require('../utils/estadoProprietario');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const diaUTC = (offset = 0) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
};
const dia = (offset) => diaUTC(offset).toISOString().slice(0, 10);
const futuro = (offset, h = 10) => new Date(diaUTC(offset).getTime() + h * 3600000);

async function cenario() {
  const e = await Empresa.create({ nome: 'PI' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const adm = await mk('admin', 'admin');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const dono = await mk('Dono', 'parceiro');
  const outro = await mk('Outro', 'parceiro');
  const lav = await mk('Lav', 'fornecedor');
  const casa = (parceiro, x = {}) => Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(1000 + ++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: parceiro ? parceiro._id : null, ...x });
  const tarefa = (p, data, x = {}) => Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data, tempo_limpeza_minutos: 60, estado: 'por_atribuir', tipo: 'limpeza', ...x });
  return { e, g, adm, ana, bia, dono, outro, lav, mk, casa, tarefa, tokG: await login(g), tokA: await login(adm) };
}
const patch = (c, u, corpo) => request(app).patch(`/api/gestor/equipa/${u._id}/estado`).set(auth(c.tokG)).send(corpo);

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('desativar e reativar proprietário', () => {
  test('desativa as casas, cancela as limpezas futuras não iniciadas, avisa a equipa e fecha as ofertas; não toca em em_curso nem concluídas', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const B = await c.casa(c.dono);
    const alheia = await c.casa(c.outro);
    const t1 = await c.tarefa(A, futuro(3), { estado: 'atribuida', utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id] });
    const t2 = await c.tarefa(B, futuro(4)); // por_atribuir
    const t3 = await c.tarefa(B, futuro(5), { estado: 'nao_atribuida', oferta_estado: 'aberta', oferta_dia: dia(5), oferta_expira_em: futuro(4) });
    const emCurso = await c.tarefa(A, new Date(Date.now() + 3600000), { estado: 'em_curso', utilizador_id: c.bia._id, iniciada_em: new Date() });
    const concluida = await c.tarefa(A, futuro(-1), { estado: 'concluida', utilizador_id: c.ana._id });
    const passada = await c.tarefa(A, futuro(-3), { estado: 'por_atribuir' });
    const doOutro = await c.tarefa(alheia, futuro(3), { estado: 'atribuida', utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id] });

    // os números ANTES de confirmar
    const prev = await request(app).get(`/api/gestor/equipa/${c.dono._id}/impacto-desativar`).set(auth(c.tokG));
    expect(prev.status).toBe(200);
    expect(prev.body).toEqual({ casas: 2, limpezas: 3 });
    expect((await Utilizador.findById(c.dono._id)).ativo).toBe(true); // a consulta não altera nada

    const r = await patch(c, c.dono, { ativo: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ativo: false, casas_desativadas: 2, limpezas_canceladas: 3 });

    expect((await Utilizador.findById(c.dono._id)).ativo).toBe(false);
    for (const p of [A, B]) {
      const x = await Propriedade.findById(p._id).lean();
      expect(x.ativo).toBe(false);
      expect(x.inativa_por_proprietario).toBe(true);
    }
    expect((await Propriedade.findById(alheia._id)).ativo).toBe(true);

    for (const t of [t1, t2, t3]) {
      const x = await Tarefa.findById(t._id).lean();
      expect(x.estado).toBe('cancelada');
      expect(x.utilizador_id).toBeNull();
      expect(x.equipa_atribuida).toHaveLength(0);
    }
    expect((await Tarefa.findById(t3._id)).oferta_estado).toBe('fechada');
    expect((await Tarefa.findById(emCurso._id)).estado).toBe('em_curso');
    expect((await Tarefa.findById(concluida._id)).estado).toBe('concluida');
    expect((await Tarefa.findById(passada._id)).estado).toBe('por_atribuir'); // passada: fora do âmbito
    expect((await Tarefa.findById(doOutro._id)).estado).toBe('atribuida');

    // a pessoa que tinha uma limpeza recebe aviso (1 por pessoa); quem não perdeu nada não recebe
    expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id, mensagem: /cancelada/ })).toBe(1);
    expect(await Notificacao.countDocuments({ utilizador_id: c.bia._id, mensagem: /cancelada/ })).toBe(0);

    // o ecrã de confirmação, depois de desativado, já mostra zero casas ativas
    expect(await impactoDesativar(c.e._id, c.dono._id)).toEqual({ casas: 0, limpezas: 0 });
  });

  test('reativar repõe as casas (só as desativadas com o proprietário) e NÃO recria as limpezas canceladas', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const B = await c.casa(c.dono, { ativo: false }); // desativada pelo gestor antes, por outra razão
    const t = await c.tarefa(A, futuro(3));
    await patch(c, c.dono, { ativo: false });
    expect((await Tarefa.findById(t._id)).estado).toBe('cancelada');

    const r = await patch(c, c.dono, { ativo: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ativo: true, casas_reativadas: 1 });
    expect((await Propriedade.findById(A._id)).ativo).toBe(true);
    expect((await Propriedade.findById(A._id)).inativa_por_proprietario).toBe(false);
    expect((await Propriedade.findById(B._id)).ativo).toBe(false);
    expect((await Tarefa.findById(t._id)).estado).toBe('cancelada');
    expect(await Tarefa.countDocuments({ propriedade_id: A._id, estado: { $ne: 'cancelada' } })).toBe(0);
  });

  test('desativar staff não mexe em casas e o impacto de quem não é proprietário é zero', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const r = await patch(c, c.ana, { ativo: false });
    expect(r.status).toBe(200);
    expect(r.body.casas_desativadas).toBeUndefined();
    expect((await Propriedade.findById(A._id)).ativo).toBe(true);
    const prev = await request(app).get(`/api/gestor/equipa/${c.ana._id}/impacto-desativar`).set(auth(c.tokG));
    expect(prev.body).toEqual({ casas: 0, limpezas: 0 });
  });
});

describe('casas inativas não geram limpezas', () => {
  const reserva = (id, p, extra = {}) => ({ action: 'newReservation', data: { id, type: 'reservation', arrival: '2031-06-01', departure: '2031-06-03', apartment: { id: Number(p.smoobu_id) }, 'guest-name': 'G', adults: 1, children: 0, ...extra } });

  test('Smoobu: webhook de casa de proprietário inativo não cria limpeza; uma cancelada não renasce com update', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const id = 7000 + n;
    await processarReservaSmoobu(reserva(id, A), c.e._id, c.e._id);
    const t = await Tarefa.findOne({ propriedade_id: A._id });
    expect(t.origem).toBe('smoobu'); // o Smoobu grava a origem certa
    await patch(c, c.dono, { ativo: false });
    expect((await Tarefa.findById(t._id)).estado).toBe('cancelada');

    // update do Smoobu: a limpeza cancelada não é reativada
    await processarReservaSmoobu({ ...reserva(id, A), action: 'updateReservation' }, c.e._id, c.e._id);
    expect((await Tarefa.findById(t._id)).estado).toBe('cancelada');
    // reserva nova: recusada
    await expect(processarReservaSmoobu(reserva(id + 1, A, { arrival: '2031-07-01', departure: '2031-07-03' }), c.e._id, c.e._id)).rejects.toThrow(/inativ|suspensa/);
    expect(await Tarefa.countDocuments({ propriedade_id: A._id })).toBe(1);
  });

  test('Smoobu: casa ATIVA mas com proprietário inativo (dados antigos) também é recusada', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } }); // sem passar pelo ecrã
    await expect(processarReservaSmoobu(reserva(8000 + n, A), c.e._id, c.e._id)).rejects.toThrow(/proprietário/);
    expect(await Tarefa.countDocuments({ propriedade_id: A._id })).toBe(0);
  });

  test('rotina de dias fixos, auto-atribuição e ofertas ignoram a casa inativa', async () => {
    const c = await cenario();
    const todos = [0, 1, 2, 3, 4, 5, 6];
    const A = await c.casa(c.dono, { dias_fixos_limpeza: todos });
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } }); // dono inativo, casa ainda ativa
    const r = await executarGeradorRotinas();
    expect(r.criadas || 0).toBe(0);
    expect(await Tarefa.countDocuments({ propriedade_id: A._id })).toBe(0);

    // auto-atribuição manual: uma limpeza por atribuir na casa não recebe ninguém
    const t = await c.tarefa(A, futuro(2));
    const aa = await request(app).post('/api/gestor/tarefas/auto-atribuir').set(auth(c.tokG)).send({});
    expect(aa.status).toBe(200);
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
    expect((await Tarefa.findById(t._id)).utilizador_id).toBeNull();

    // ofertas
    expect(await abrirOferta(t._id)).toMatchObject({ aberta: false, motivo: 'casa_inativa' });
  });

  test('preenchimento de vagas depois de uma ausência também ignora a casa inativa (e continua a atribuir as ativas)', async () => {
    const c = await cenario();
    const inativa = await c.casa(c.dono, { ativo: false });
    const ativa = await c.casa(null);
    const d = futuro(6);
    const t1 = await c.tarefa(inativa, d);
    const t2 = await c.tarefa(ativa, d);
    const { reatribuirTarefasPeriodo } = require('../controllers/ausenciaController');
    await reatribuirTarefasPeriodo(c.e._id, c.bia._id, d, d);
    expect((await Tarefa.findById(t1._id)).utilizador_id).toBeNull();
    expect((await Tarefa.findById(t1._id)).estado).toBe('por_atribuir');
    expect((await Tarefa.findById(t2._id)).estado).toBe('atribuida');
  });

  test('reservas do parceiro: casa inativa não aceita reservas novas', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const tok = await login(c.dono);
    await Propriedade.updateOne({ _id: A._id }, { $set: { ativo: false } });
    const r = await request(app).post('/api/parceiro/reservas').set(auth(tok)).send({ propriedade_id: String(A._id), check_in: dia(5), check_out: dia(7), hospedes: 2 });
    expect(r.status).toBe(404);
    expect(await ReservaManual.countDocuments({ propriedade_id: A._id })).toBe(0);
  });
});

describe('«Nova limpeza» e «Apagar limpezas futuras»', () => {
  test('Nova limpeza recusa casa inativa e casa de proprietário inativo, com 400 e mensagem clara', async () => {
    const c = await cenario();
    const inativa = await c.casa(null, { ativo: false });
    const A = await c.casa(c.dono);
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } });
    const nova = (p) => request(app).post('/api/gestor/tarefas').set(auth(c.tokG)).send({ propriedade_id: String(p._id), data: dia(4), tipo: 'limpeza' });
    const r1 = await nova(inativa);
    expect(r1.status).toBe(400);
    expect(r1.body.erro).toMatch(/inativa/i);
    const r2 = await nova(A);
    expect(r2.status).toBe(400);
    expect(r2.body.erro).toMatch(/proprietário/i);
    const r3 = await request(app).post('/api/gestor/tarefas/espontanea').set(auth(c.tokG)).send({ propriedade_id: String(A._id), data: dia(4) });
    expect(r3.status).toBe(400);
    expect(await Tarefa.countDocuments({ empresa_id: c.e._id })).toBe(0);
    // casa ativa continua a funcionar
    const ok = await c.casa(null);
    expect((await nova(ok)).status).toBe(201);
  });

  test('Apagar limpezas futuras poupa as de reservas de proprietários e diz quantas', async () => {
    const c = await cenario();
    const A = await c.casa(c.dono);
    const B = await c.casa(null);
    const doDono = await c.tarefa(A, futuro(3), { origem_parceiro: true });
    await ReservaManual.create({ propriedade_id: A._id, parceiro_id: c.dono._id, empresa_id: c.e._id, check_in: futuro(1), check_out: futuro(3), tarefa_gerada_id: doDono._id });
    const s1 = await c.tarefa(B, futuro(3));
    const s2 = await c.tarefa(B, futuro(4));
    const r = await request(app).delete('/api/gestor/tarefas/futuras').set(auth(c.tokA));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ apagadas: 2, poupadas: 1 });
    expect(r.body.mensagem).toMatch(/poupadas/);
    expect(await Tarefa.findById(doDono._id)).not.toBeNull();
    expect(await Tarefa.findById(s1._id)).toBeNull();
    expect(await Tarefa.findById(s2._id)).toBeNull();
  });
});

describe('inativos nas listas e associações', () => {
  test('o backend recusa associar proprietário ou lavandaria inativos (400), ao criar e ao editar; manter o atual é permitido', async () => {
    const c = await cenario();
    const donoInativo = await c.mk('DonoIn', 'parceiro', { ativo: false });
    const lavInativa = await c.mk('LavIn', 'fornecedor', { ativo: false });
    const p = await c.casa(null);
    const put = (corpo) => request(app).put(`/api/gestor/propriedades/${p._id}`).set(auth(c.tokG)).send(corpo);

    const r1 = await put({ parceiro_id: String(donoInativo._id) });
    expect(r1.status).toBe(400);
    expect(r1.body.erro).toMatch(/proprietário está inativo/i);
    const r2 = await put({ fornecedor_id: String(lavInativa._id) });
    expect(r2.status).toBe(400);
    expect(r2.body.erro).toMatch(/lavandaria está inativa/i);
    expect((await Propriedade.findById(p._id)).parceiro_id).toBeNull();

    const r3 = await request(app).post('/api/gestor/propriedades').set(auth(c.tokG)).send({ nome: 'Nova', morada: 'Rua 1', parceiro_id: String(donoInativo._id) });
    expect(r3.status).toBe(400);

    // ativos continuam a poder ser associados
    expect((await put({ parceiro_id: String(c.dono._id), fornecedor_id: String(c.lav._id) })).status).toBe(200);
    // e quem já está associado e ficou inativo mantém-se (o ecrã reenvia o mesmo valor)
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } });
    const r4 = await put({ parceiro_id: String(c.dono._id), nome: 'Outro nome' });
    expect(r4.status).toBe(200);
    expect(String((await Propriedade.findById(p._id)).parceiro_id)).toBe(String(c.dono._id));
  });

  test('GET /propriedades devolve o estado do proprietário (para o ecrã mostrar «inativo»)', async () => {
    const c = await cenario();
    await c.casa(c.dono);
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } });
    const r = await request(app).get('/api/gestor/propriedades').set(auth(c.tokG));
    expect(r.status).toBe(200);
    const prop = (r.body.propriedades || r.body).find((x) => x.parceiro_id);
    expect(prop.parceiro_id.ativo).toBe(false);
  });

  test('calendário: folgas fixas e ausências de pessoas inativas já não aparecem', async () => {
    const c = await cenario();
    const ativa = await c.mk('Ativa', 'staff', { dias_folga: [0, 1, 2, 3, 4, 5, 6] });
    const inativa = await c.mk('Inativa', 'staff', { dias_folga: [0, 1, 2, 3, 4, 5, 6], ativo: false });
    const ini = dia(1);
    const fim = dia(3);
    for (const u of [ativa, inativa]) {
      await Ausencia.create({ utilizador_id: u._id, empresa_id: c.e._id, data_inicio: new Date(`${ini}T00:00:00Z`), data_fim: new Date(`${ini}T00:00:00Z`), tipo: 'ferias', estado: 'aprovada' });
    }
    const r = await request(app).get(`/api/gestor/calendario/dados?inicio=${ini}&fim=${fim}`).set(auth(c.tokG));
    expect(r.status).toBe(200);
    const eventos = r.body.tarefas;
    const nomes = (tipo) => eventos.filter((x) => x.tipo === tipo).map((x) => (x.utilizador_id && x.utilizador_id.nome) || x.title);
    const folgas = nomes('folga_fixa').join('|');
    expect(folgas).toMatch(/Ativa/);
    expect(folgas).not.toMatch(/Inativa/);
    const aus = nomes('ausencia').join('|');
    expect(aus).toMatch(/Ativa/);
    expect(aus).not.toMatch(/Inativa/);
  });
});
