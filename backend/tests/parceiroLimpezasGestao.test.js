/**
 * O proprietário vê (só de leitura) as limpezas criadas pela All2gether e as do Smoobu nas casas dele;
 * recebe aviso quando o Smoobu as cancela/altera; o gestor recebe aviso quando o proprietário mexe em
 * limpezas das próximas 48 h; o Smoobu grava a origem e há um script de migração.
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
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const { processarReservaSmoobu } = require('../controllers/smoobuController');
const { migrarOrigemSmoobu } = require('../scripts/migrar-origem-smoobu');
const { dentroDas48h } = require('../utils/avisoGestorReserva');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function cenario() {
  const e = await Empresa.create({ nome: 'PL' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const dono = await mk('Dono', 'parceiro');
  const outro = await mk('Outro', 'parceiro');
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(2000 + ++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: dono._id });
  const alheia = await Propriedade.create({ nome: 'Alheia' + ++n, empresa_id: e._id, smoobu_id: String(3000 + ++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: outro._id });
  return { e, g, ana, dono, outro, p, alheia, tokG: await login(g), tokP: await login(dono), tokO: await login(outro) };
}
const reservaSmoobu = (id, p, extra = {}) => ({ action: 'newReservation', data: { id, type: 'reservation', arrival: '2031-06-01', departure: '2031-06-03', apartment: { id: Number(p.smoobu_id) }, 'guest-name': 'Nome Secreto', adults: 2, children: 0, ...extra } });
const msgs = (u, re) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: re });

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('tabela de Reservas do proprietário: limpezas da gestão (só leitura)', () => {
  test('mostra a limpeza criada pelo gestor e a do Smoobu, com origem, datas, tipo e estado; sem duplicar a que vem de uma reserva dele; sem dados do hóspede', async () => {
    const c = await cenario();
    // 1) «Nova limpeza» do gestor
    const nova = await request(app).post('/api/gestor/tarefas').set(auth(c.tokG)).send({ propriedade_id: String(c.p._id), data: dia(20), tipo: 'limpeza', nome_hospede: 'Ninguém Deve Ver' });
    expect(nova.status).toBe(201);
    // 2) Smoobu
    await processarReservaSmoobu(reservaSmoobu(9100 + n, c.p), c.e._id, c.e._id);
    // 3) reserva do próprio proprietário
    const dd = await request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(c.p._id), check_in: dia(30), check_out: dia(33), hospedes: 2 });
    expect(dd.status).toBe(201);
    // 4) casa de outro proprietário (não pode aparecer)
    await processarReservaSmoobu(reservaSmoobu(9500 + n, c.alheia), c.e._id, c.e._id);
    // 5) manutenção (não é limpeza)
    await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, data: new Date(Date.now() + 86400000), tipo: 'manutencao', estado: 'por_atribuir', tempo_limpeza_minutos: 30 });

    const r = await request(app).get('/api/parceiro/reservas').set(auth(c.tokP));
    expect(r.status).toBe(200);
    expect(r.body.reservas).toHaveLength(1);
    const l = r.body.limpezas_gestao;
    expect(l).toHaveLength(2);
    const porOrigem = Object.fromEntries(l.map((x) => [x.origem, x]));
    expect(porOrigem.all2gether.origem_texto).toBe('Criada pela All2gether');
    expect(porOrigem.smoobu.origem_texto).toBe('Smoobu');
    for (const x of l) {
      expect(x.somente_leitura).toBe(true);
      expect(x.tipo_limpeza).toBe('normal');
      expect(['por_atribuir', 'nao_atribuida', 'atribuida']).toContain(x.estado);
      expect(x.data).toBeTruthy();
      expect(x.propriedade.nome).toBe(c.p.nome);
    }
    // datas da reserva Smoobu
    expect(porOrigem.smoobu.check_in).toBe('2031-06-01');
    expect(porOrigem.smoobu.check_out).toBe('2031-06-03');
    // a limpeza gerada pela reserva dele não está duplicada
    expect(l.map((x) => x._id)).not.toContain(String(dd.body.tarefa._id));
    // nada de dados dos hóspedes nem de equipa
    expect(JSON.stringify(r.body.limpezas_gestao)).not.toMatch(/Nome Secreto|Ninguém Deve Ver|utilizador_id|equipa/);
    // o outro proprietário só vê as dele
    const ro = await request(app).get('/api/parceiro/reservas').set(auth(c.tokO));
    expect(ro.body.limpezas_gestao).toHaveLength(1);
    expect(ro.body.limpezas_gestao[0].propriedade.nome).toBe(c.alheia.nome);
  });

  test('editar ou apagar uma limpeza da gestão é recusado com 403; um id inexistente continua 404', async () => {
    const c = await cenario();
    const t = await Tarefa.create({ empresa_id: c.e._id, propriedade_id: c.p._id, data: new Date(Date.now() + 5 * 86400000), tipo: 'limpeza', estado: 'por_atribuir', tempo_limpeza_minutos: 60, origem: 'manual' });
    const put = await request(app).put(`/api/parceiro/reservas/${t._id}`).set(auth(c.tokP)).send({ observacoes: 'x' });
    expect(put.status).toBe(403);
    expect(put.body.codigo).toBe('LIMPEZA_DA_GESTAO');
    const del = await request(app).delete(`/api/parceiro/reservas/${t._id}`).set(auth(c.tokP));
    expect(del.status).toBe(403);
    expect(await Tarefa.findById(t._id)).not.toBeNull();
    expect((await Tarefa.findById(t._id)).estado).toBe('por_atribuir');
    // limpeza de outro proprietário: para ele nem existe (404)
    expect((await request(app).delete(`/api/parceiro/reservas/${t._id}`).set(auth(c.tokO))).status).toBe(404);
    expect((await request(app).delete(`/api/parceiro/reservas/${new mongoose.Types.ObjectId()}`).set(auth(c.tokP))).status).toBe(404);
  });
});

describe('origem do Smoobu', () => {
  test('as limpezas novas do Smoobu ficam com origem smoobu', async () => {
    const c = await cenario();
    await processarReservaSmoobu(reservaSmoobu(9700 + n, c.p), c.e._id, c.e._id);
    expect((await Tarefa.findOne({ propriedade_id: c.p._id })).origem).toBe('smoobu');
  });

  test('migração: simula por defeito, --aplicar corrige só as do Smoobu, e repetir não muda nada (idempotente)', async () => {
    const c = await cenario();
    const base = { empresa_id: c.e._id, propriedade_id: c.p._id, data: new Date(Date.now() + 86400000), tipo: 'limpeza', estado: 'por_atribuir', tempo_limpeza_minutos: 60 };
    const antigaSmoobu = await Tarefa.create({ ...base, smoobu_reserva_id: 'R-' + n, origem: 'manual' });
    const jaCerta = await Tarefa.create({ ...base, smoobu_reserva_id: 'R2-' + n, origem: 'smoobu' });
    const manual = await Tarefa.create({ ...base, origem: 'manual' });
    const doParceiro = await Tarefa.create({ ...base, origem: 'manual', origem_parceiro: true });

    const sim = await migrarOrigemSmoobu({});
    expect(sim).toMatchObject({ aplicado: false, atualizadas: 0 });
    expect(sim.candidatas).toBeGreaterThanOrEqual(1);
    expect((await Tarefa.findById(antigaSmoobu._id)).origem).toBe('manual'); // simulação não escreve

    const r1 = await migrarOrigemSmoobu({ aplicar: true });
    expect(r1.atualizadas).toBe(sim.candidatas);
    expect((await Tarefa.findById(antigaSmoobu._id)).origem).toBe('smoobu');
    expect((await Tarefa.findById(jaCerta._id)).origem).toBe('smoobu');
    expect((await Tarefa.findById(manual._id)).origem).toBe('manual');
    expect((await Tarefa.findById(doParceiro._id)).origem).toBe('manual');

    const r2 = await migrarOrigemSmoobu({ aplicar: true });
    expect(r2).toMatchObject({ candidatas: 0, atualizadas: 0 });
  });
});

describe('avisos ao proprietário (Smoobu cancela ou altera)', () => {
  test('Smoobu muda a data -> sino «alterada»; Smoobu cancela -> sino «cancelada»; reenvio não duplica', async () => {
    const c = await cenario();
    const id = 9800 + n;
    await processarReservaSmoobu(reservaSmoobu(id, c.p), c.e._id, c.e._id);
    expect(await msgs(c.dono, /Limpeza (alterada|cancelada)/)).toBe(0); // criar não avisa
    await processarReservaSmoobu({ ...reservaSmoobu(id, c.p, { departure: '2031-06-05' }), action: 'updateReservation' }, c.e._id, c.e._id);
    expect(await msgs(c.dono, /Limpeza alterada \(a reserva mudou no Smoobu\)/)).toBe(1);
    // update sem mudar a data: sem aviso novo
    await processarReservaSmoobu({ ...reservaSmoobu(id, c.p, { departure: '2031-06-05' }), action: 'updateReservation' }, c.e._id, c.e._id);
    expect(await msgs(c.dono, /Limpeza alterada/)).toBe(1);

    await processarReservaSmoobu({ ...reservaSmoobu(id, c.p), action: 'cancelReservation' }, c.e._id, c.e._id);
    expect(await msgs(c.dono, /Limpeza cancelada \(a reserva foi cancelada no Smoobu\)/)).toBe(1);
    await processarReservaSmoobu({ ...reservaSmoobu(id, c.p), action: 'cancelReservation' }, c.e._id, c.e._id);
    expect(await msgs(c.dono, /Limpeza cancelada/)).toBe(1);
    // outro proprietário não recebe nada
    expect(await msgs(c.outro, /Limpeza/)).toBe(0);
    // e o aviso é só no sino do proprietário (não o gestor)
    expect(await msgs(c.g, /Limpeza (alterada|cancelada)/)).toBe(0);
  });

  test('casa sem proprietário: ninguém a avisar e não falha', async () => {
    const c = await cenario();
    const semDono = await Propriedade.create({ nome: 'Sem' + ++n, empresa_id: c.e._id, smoobu_id: String(4000 + ++n), ativo: true, tempo_limpeza_minutos: 60 });
    const id = 9900 + n;
    await processarReservaSmoobu(reservaSmoobu(id, semDono), c.e._id, c.e._id);
    await processarReservaSmoobu({ ...reservaSmoobu(id, semDono), action: 'cancelReservation' }, c.e._id, c.e._id);
    expect((await Tarefa.findOne({ propriedade_id: semDono._id })).estado).toBe('cancelada');
  });
});

describe('avisos ao gestor quando o proprietário mexe em reservas (só limpezas das próximas 48 h)', () => {
  const reservar = (c, ci, co, extra = {}) => request(app).post('/api/parceiro/reservas').set(auth(c.tokP)).send({ propriedade_id: String(c.p._id), check_in: dia(ci), check_out: dia(co), hospedes: 2, ...extra });
  const sino = (c) => Notificacao.countDocuments({ utilizador_id: c.g._id, mensagem: /O proprietário/ });

  test('a janela: hoje e amanhã contam, daqui a 4 dias não', () => {
    expect(dentroDas48h(new Date())).toBe(true);
    expect(dentroDas48h(new Date(Date.now() + 86400000))).toBe(true);
    expect(dentroDas48h(new Date(Date.now() + 4 * 86400000))).toBe(false);
    expect(dentroDas48h(null)).toBe(false);
  });

  test('criar: avisa se a limpeza cai nas próximas 48 h; não avisa se é mais longe', async () => {
    const c = await cenario();
    expect((await reservar(c, 10, 14)).status).toBe(201);
    expect(await sino(c)).toBe(0);
    const perto = await reservar(c, 0, 1);
    expect(perto.status).toBe(201);
    expect(await sino(c)).toBe(1);
    expect(await msgs(c.g, /O proprietário criou uma reserva em .*limpeza a \d\d\/\d\d \(próximas 48 h\)/)).toBe(1);
  });

  test('alterar datas (para dentro ou para fora da janela) avisa; mudar só notas não avisa', async () => {
    const c = await cenario();
    const r = await reservar(c, 10, 14);
    const id = r.body.reserva._id;
    const put = (corpo) => request(app).put(`/api/parceiro/reservas/${id}`).set(auth(c.tokP)).send(corpo);
    expect((await put({ observacoes: 'só notas' })).status).toBe(200);
    expect(await sino(c)).toBe(0);
    // muda a limpeza para amanhã: entra na janela
    expect((await put({ check_in: dia(0), check_out: dia(1) })).status).toBe(200);
    expect(await sino(c)).toBe(1);
    expect(await msgs(c.g, /alterou uma reserva/)).toBe(1);
    // e agora afasta-a: a limpeza que estava nas próximas 48 h mexeu-se, avisa outra vez
    expect((await put({ check_in: dia(10), check_out: dia(14) })).status).toBe(200);
    expect(await sino(c)).toBe(2);
  });

  test('apagar: avisa quando a limpeza era das próximas 48 h', async () => {
    const c = await cenario();
    const longe = await reservar(c, 10, 14);
    const perto = await reservar(c, 0, 1);
    const before = await sino(c);
    expect((await request(app).delete(`/api/parceiro/reservas/${longe.body.reserva._id}`).set(auth(c.tokP))).status).toBe(200);
    expect(await sino(c)).toBe(before);
    expect((await request(app).delete(`/api/parceiro/reservas/${perto.body.reserva._id}`).set(auth(c.tokP))).status).toBe(200);
    expect(await sino(c)).toBe(before + 1);
    expect(await msgs(c.g, /apagou uma reserva .*foi cancelada/)).toBe(1);
  });

  test('reabrir uma limpeza que o gestor tinha cancelado: aviso próprio', async () => {
    const c = await cenario();
    const r = await reservar(c, 10, 14);
    const rm = await ReservaManual.findById(r.body.reserva._id);
    // o gestor cancela a limpeza
    await request(app).patch(`/api/gestor/tarefas/${rm.tarefa_gerada_id}/estado`).set(auth(c.tokG)).send({ estado: 'cancelada' });
    expect((await Tarefa.findById(rm.tarefa_gerada_id)).estado).toBe('cancelada');
    expect(await sino(c)).toBe(0);
    // o proprietário muda as datas para amanhã: nasce uma limpeza nova
    const put = await request(app).put(`/api/parceiro/reservas/${rm._id}`).set(auth(c.tokP)).send({ check_in: dia(0), check_out: dia(1) });
    expect(put.status).toBe(200);
    const nova = await ReservaManual.findById(rm._id);
    expect((await Tarefa.findById(nova.tarefa_gerada_id)).estado).not.toBe('cancelada');
    expect(await msgs(c.g, /limpeza que cancelaste foi reaberta/)).toBe(1);
  });
});
