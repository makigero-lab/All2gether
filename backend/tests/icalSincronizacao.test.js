/**
 * Calendários externos (iCal): sincronização (criar, mudar datas, faltas, erros, suspeitas, duplicados, concorrência,
 * elegibilidade). Rede mockada (transporte falso); base de dados em memória.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const H = require('./helpersIcal');
const { configurarChaves, dia, calendario, PRODID_AIRBNB, PRODID_BOOKING, URL_AIRBNB, URL_BOOKING, urlAirbnb, urlBooking, criarTransporte, cenario } = H;
const Servico = require('../utils/calendarioExterno/servico');
const { sincronizarFonte } = require('../utils/calendarioExterno/sincronizar');
const Decisoes = require('../utils/calendarioExterno/decisoes');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const ReservaManual = require('../models/ReservaManual');
const LeituraCalendario = require('../models/LeituraCalendario');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Notificacao = require('../models/Notificacao');
const { LockEmpresa } = require('../utils/lockEmpresa');
const R = require('../utils/reservasParceiro');

let mongod;
beforeAll(async () => {
  configurarChaves();
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Tarefa.init(), ReservaManual.init(), FonteCalendario.init(), ReservaExterna.init(), LeituraCalendario.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(() => { configurarChaves(); Servico.limparLimiteTestar(); });

const AIRBNB = (evs) => ({ 'www.airbnb.pt': { corpo: calendario(PRODID_AIRBNB, evs) } });
const BOOKING = (evs) => ({ 'ical.booking.com': { corpo: calendario(PRODID_BOOKING, evs.map((e) => ({ summary: 'CLOSED - Not available', ...e }))) } });
const noticias = (u, re) => Notificacao.countDocuments({ utilizador_id: u._id, mensagem: re });
const limpezas = (c) => Tarefa.find({ propriedade_id: c.casa._id, tipo: 'limpeza', estado: { $ne: 'cancelada' } }).lean();

/** Liga um canal com o estado do feed (objeto mutável: muda-se o conteúdo entre leituras). */
async function ligar(c, urlBase, estado) {
  const url = urlBase === URL_BOOKING ? urlBooking() : urlBase === URL_AIRBNB ? urlAirbnb() : urlBase;
  const t = criarTransporte(estado);
  const r = await Servico.criarLigacao({ propriedadeId: c.casa._id, url, escopo: c.escopoP, ator: c.ator, transporte: t });
  expect(r.status).toBe(201);
  return { id: r.body.fonte._id, t, estado, resp: r.body, url };
}
const ler = (f, opcoes = {}) => sincronizarFonte(f.id, { transporte: f.t, ...opcoes });
const mudar = (f, host, evs, tipo = 'airbnb') => { f.estado[host] = tipo === 'airbnb' ? AIRBNB(evs)[host] : BOOKING(evs)[host]; };

describe('Airbnb: criar e idempotência', () => {
  test('14) primeira leitura cria ReservaManual origem ical e a limpeza no DTEND; a segunda igual não cria nada', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'u1@airbnb.com', ci: 20, co: 23 }, { uid: 'bloq@airbnb.com', ci: 30, co: 33, summary: 'Airbnb (Not available)' }]));
    expect(f.resp.leitura.alteracoes.criadas).toBe(1);
    const rs = await ReservaManual.find({ propriedade_id: c.casa._id }).lean();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ origem: 'ical', sincronizada: true, plataforma: 'Airbnb', hospedes: 4 });
    expect(rs[0].reserva_externa_id).toBeTruthy();
    const ls = await limpezas(c);
    expect(ls).toHaveLength(1);
    expect(ls[0].data.toISOString().slice(0, 10)).toBe(dia(23));
    expect(ls[0].origem_parceiro).toBe(true);
    const ex = await ReservaExterna.find({ propriedade_id: c.casa._id }).lean();
    expect(ex.map((x) => x.estado).sort()).toEqual(['bloqueio', 'confirmada']); // o bloqueio não cria limpeza
    const r2 = await ler(f);
    expect(r2.resultado).toBe('sem_alteracoes');
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(1);
    expect(await limpezas(c)).toHaveLength(1);
    // o proprietário foi avisado das limpezas novas
    expect(await noticias(c.dono, /Calendário/)).toBeGreaterThanOrEqual(1);
  });

  test('registo mínimo: leituras sem alterações fundem-se numa só; UID e amostra só quando o calendário muda', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a', ci: 20, co: 23 }, { uid: 'b', ci: 30, co: 32 }]));
    for (let i = 0; i < 4; i++) await ler(f);
    let ls = await LeituraCalendario.find({ fonte_id: f.id }).sort({ iniciada_em: 1 }).lean();
    expect(ls).toHaveLength(2); // a primeira (mudou) + uma fundida com 3 repetidas
    expect(ls[0].eventos.length).toBe(2);
    expect(ls[0].amostra_redigida).toMatch(/SUMMARY:airbnb_reserved/);
    expect(ls[1].resultado).toBe('sem_alteracoes');
    expect(ls[1].repetidas).toBe(3);
    expect(ls[1].eventos).toBeUndefined();
    expect(ls[1].amostra_redigida).toBeUndefined();
    // só as 3 amostras mais recentes
    for (let i = 0; i < 5; i++) { mudar(f, 'www.airbnb.pt', [{ uid: 'a', ci: 20, co: 23 }, { uid: 'b', ci: 30 + i + 1, co: 33 + i + 1 }]); await ler(f); }
    ls = await LeituraCalendario.find({ fonte_id: f.id, amostra_redigida: { $exists: true } }).lean();
    expect(ls.length).toBeLessThanOrEqual(3);
    // índices TTL
    const idx = await LeituraCalendario.collection.indexes();
    expect(idx.find((i) => i.key.iniciada_em === 1 && i.expireAfterSeconds === 30 * 86400)).toBeTruthy();
  });
});

describe('Airbnb: mudança de datas', () => {
  test('15) dia da limpeza diferente: limpeza nova e antiga cancelada; dia com limpeza do proprietário: associa; só o check-in: mesma tarefa', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'u1', ci: 20, co: 23 }]));
    const antes = (await limpezas(c))[0];
    mudar(f, 'www.airbnb.pt', [{ uid: 'u1', ci: 20, co: 26 }]);
    const r = await ler(f);
    expect(r.alteracoes.datas_alteradas).toBe(1);
    const depois = await limpezas(c);
    expect(depois).toHaveLength(1);
    expect(String(depois[0]._id)).not.toBe(String(antes._id));
    expect(depois[0].data.toISOString().slice(0, 10)).toBe(dia(26));
    expect((await Tarefa.findById(antes._id)).estado).toBe('cancelada');
    expect((await ReservaExterna.findOne({ propriedade_id: c.casa._id })).check_out.toISOString().slice(0, 10)).toBe(dia(26));

    // só o check-in muda: mesma tarefa
    const t1 = (await limpezas(c))[0];
    mudar(f, 'www.airbnb.pt', [{ uid: 'u1', ci: 22, co: 26 }]);
    await ler(f);
    const t2 = await limpezas(c);
    expect(t2).toHaveLength(1);
    expect(String(t2[0]._id)).toBe(String(t1._id));
    expect(t2[0].detalhes_reserva.checkin).toBe(dia(22));

    // mudar para um dia que já tem uma limpeza de reserva do proprietário: junta-se a ela
    const manual = await R.criarReservaComLimpeza({ parceiroId: c.dono._id, empresaId: c.e._id, body: { propriedade_id: String(c.casa._id), check_in: dia(36), check_out: dia(40) } });
    expect(manual.status).toBe(201);
    mudar(f, 'www.airbnb.pt', [{ uid: 'u1', ci: 37, co: 40 }]);
    await ler(f);
    const t3 = await limpezas(c);
    expect(t3).toHaveLength(1);
    expect(String(t3[0]._id)).toBe(String(manual.body.tarefa._id));
    expect((await Tarefa.findById(t1._id)).estado).toBe('cancelada');
  });

  test('16) limpeza em curso ou concluída: fica intacta, conflito, aviso ao gestor', async () => {
    for (const estado of ['em_curso', 'concluida']) {
      const c = await cenario();
      const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'u1', ci: 20, co: 23 }]));
      const t = (await limpezas(c))[0];
      await Tarefa.updateOne({ _id: t._id }, { $set: { estado } });
      mudar(f, 'www.airbnb.pt', [{ uid: 'u1', ci: 20, co: 27 }]);
      const r = await ler(f);
      expect(r.alteracoes.conflitos).toBe(1);
      const ex = await ReservaExterna.findOne({ propriedade_id: c.casa._id });
      expect(ex.conflito).toBe(estado === 'em_curso' ? 'limpeza_em_curso' : 'limpeza_concluida');
      expect(ex.check_out.toISOString().slice(0, 10)).toBe(dia(23)); // as datas antigas mantêm-se
      expect((await Tarefa.findById(t._id)).data.toISOString().slice(0, 10)).toBe(dia(23));
      expect(await noticias(c.g, /mudou as datas/)).toBe(1);
    }
  });
});

describe('Airbnb: faltas e cancelamento', () => {
  const doisEventos = [{ uid: 'a', ci: 20, co: 23 }, { uid: 'b', ci: 30, co: 33 }];

  test('17) 1 e 2 leituras sem o evento não cancelam; à 3.ª cancela com avisos ao proprietário e ao gestor; a linha fica cancelada', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    mudar(f, 'www.airbnb.pt', [{ uid: 'b', ci: 30, co: 33 }]);
    await ler(f);
    expect((await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id })).leituras_em_falta).toBe(1);
    await ler(f);
    expect(await limpezas(c)).toHaveLength(2);
    expect((await ReservaManual.findOne({ propriedade_id: c.casa._id, check_out: new Date(`${dia(23)}T00:00:00Z`) })).cancelada_em).toBeNull();
    const r = await ler(f);
    expect(r.alteracoes.canceladas).toBe(1);
    const rm = await ReservaManual.findOne({ propriedade_id: c.casa._id, check_out: new Date(`${dia(23)}T00:00:00Z`) });
    expect(rm.cancelada_em).toBeTruthy();
    expect(rm.cancelada_motivo).toBe('canal');
    expect(rm.sincronizada).toBe(false);
    expect((await Tarefa.findById(rm.tarefa_gerada_id)).estado).toBe('cancelada');
    expect(await limpezas(c)).toHaveLength(1);
    expect(await noticias(c.dono, /foi cancelada no Airbnb/)).toBe(1);
    expect(await noticias(c.g, /foi cancelada no Airbnb/)).toBe(1);
    // aparece na tabela do proprietário como cancelada
    const lista = await R.listarReservasServico(c.dono._id);
    expect(lista.body.reservas.find((x) => x.cancelada_em)).toBeTruthy();
  });

  test('17b) o mínimo de horas desde a primeira falta (≥ 2 h) também tem de passar', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    process.env.ICAL_HORAS_MINIMAS_FALTA = '2';
    mudar(f, 'www.airbnb.pt', [{ uid: 'b', ci: 30, co: 33 }]);
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await ler(f, { agora: new Date(t0 + i * 10 * 60000) }); // 4 leituras em 30 min
    expect((await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id })).estado).toBe('confirmada');
    await ler(f, { agora: new Date(t0 + 3 * 3600000) });
    expect((await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id })).estado).toBe('cancelada');
  });

  test('18) erro HTTP, timeout e feed cortado: nenhuma falta contada, nada cancelado; 3 erros põem a fonte em erro e um sucesso recupera', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    const bom = f.estado['www.airbnb.pt'];
    const falhas = [{ status: 500, corpo: '' }, { erro: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }, { corpo: calendario(PRODID_AIRBNB, doisEventos).replace('END:VCALENDAR', '') }];
    for (const x of falhas) { f.estado['www.airbnb.pt'] = x; const r = await ler(f); expect(r.resultado).toBe('erro'); }
    const ex = await ReservaExterna.find({ propriedade_id: c.casa._id }).lean();
    expect(ex.every((x) => x.estado === 'confirmada' && x.leituras_em_falta === 0)).toBe(true);
    expect(await limpezas(c)).toHaveLength(2);
    const fonte = await FonteCalendario.findById(f.id).lean();
    expect(fonte.estado).toBe('erro');
    expect(fonte.erros_consecutivos).toBe(3);
    expect(fonte.ultimo_erro.mensagem).not.toMatch(/https?:/);
    f.estado['www.airbnb.pt'] = bom;
    await ler(f);
    const rec = await FonteCalendario.findById(f.id).lean();
    expect(rec.estado).toBe('ativa');
    expect(rec.erros_consecutivos).toBe(0);
    // o erro repetido funde-se no registo
    expect(await LeituraCalendario.countDocuments({ fonte_id: f.id, resultado: 'erro' })).toBeLessThanOrEqual(3);
  });

  test('18b) sem sucesso há 24 h avisa uma só vez; há 14 dias a fonte é suspensa', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    f.estado['www.airbnb.pt'] = { status: 500, corpo: '' };
    await FonteCalendario.updateOne({ _id: f.id }, { $set: { ultimo_sucesso_em: new Date(Date.now() - 30 * 3600000) } });
    await ler(f); await ler(f);
    expect(await noticias(c.dono, /não responde há mais de 24 horas/)).toBe(1);
    expect(await noticias(c.g, /não responde há mais de 24 horas/)).toBe(1);
    await FonteCalendario.updateOne({ _id: f.id }, { $set: { ultimo_sucesso_em: new Date(Date.now() - 15 * 86400000) } });
    await ler(f);
    const fonte = await FonteCalendario.findById(f.id).lean();
    expect(fonte).toMatchObject({ estado: 'suspensa', motivo_estado: 'erros_persistentes' });
    expect(await limpezas(c)).toHaveLength(2);
  });

  test('19) leituras suspeitas (vazio repentino, queda > 50 %, muitas ausências, PRODID diferente): nada cancelado e faltas não mudam; «aceitar calendário» desbloqueia', async () => {
    const c = await cenario();
    const seis = Array.from({ length: 6 }, (_, i) => ({ uid: `e${i}`, ci: 20 + i * 5, co: 22 + i * 5 }));
    const f = await ligar(c, URL_AIRBNB, AIRBNB(seis));
    const cancelados = async () => ReservaManual.countDocuments({ propriedade_id: c.casa._id, cancelada_em: { $ne: null } });
    // queda grande: 6 → 2
    mudar(f, 'www.airbnb.pt', seis.slice(0, 2));
    for (let i = 0; i < 4; i++) expect((await ler(f)).motivos).toContain('queda_grande');
    expect(await cancelados()).toBe(0);
    expect((await ReservaExterna.find({ propriedade_id: c.casa._id }).lean()).every((x) => x.leituras_em_falta === 0)).toBe(true);
    // vazio repentino
    f.estado['www.airbnb.pt'] = { corpo: calendario(PRODID_AIRBNB, []) };
    expect((await ler(f)).motivos).toContain('vazio_repentino');
    // PRODID diferente
    f.estado['www.airbnb.pt'] = { corpo: calendario('-//Outra Coisa//EN', seis.slice(0, 5)) };
    expect((await ler(f)).motivos).toContain('prodid_diferente');
    expect(await cancelados()).toBe(0);
    // o gestor aceita o calendário como está (2 eventos): a leitura seguinte passa a contar faltas e cancela, ao fim de N
    mudar(f, 'www.airbnb.pt', seis.slice(0, 2));
    await FonteCalendario.updateOne({ _id: f.id }, { $set: { ultimo_n_futuros: 2 } });
    const ac = await Servico.mudarEstado({ id: f.id, acao: 'aceitar_calendario', escopo: c.escopoG });
    expect(ac.status).toBe(200);
    for (let i = 0; i < 3; i++) await ler(f);
    expect(await cancelados()).toBe(4);
  });

  test('19b) muitas ausências de uma só vez (sem queda de 50 %) também é suspeito', async () => {
    const c = await cenario();
    const cinco = Array.from({ length: 5 }, (_, i) => ({ uid: `m${i}`, ci: 20 + i * 5, co: 22 + i * 5 }));
    const f = await ligar(c, URL_AIRBNB, AIRBNB(cinco));
    mudar(f, 'www.airbnb.pt', cinco.slice(0, 1));
    expect((await ler(f)).motivos).toContain('muitas_ausencias');
  });

  test('20) reaparecer depois de cancelada recria a limpeza', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    mudar(f, 'www.airbnb.pt', [doisEventos[1]]);
    for (let i = 0; i < 3; i++) await ler(f);
    expect(await limpezas(c)).toHaveLength(1);
    mudar(f, 'www.airbnb.pt', doisEventos);
    const r = await ler(f);
    expect(r.alteracoes.reaparecidas).toBe(1);
    expect(await limpezas(c)).toHaveLength(2);
    const ex = await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id });
    expect(ex.estado).toBe('confirmada');
    expect(await noticias(c.g, /voltou a aparecer/)).toBe(1);
  });

  test('21) reserva que passa a «Not available» com o mesmo UID conta como falta e acaba em bloqueio depois de N', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB(doisEventos));
    mudar(f, 'www.airbnb.pt', [{ uid: 'a', ci: 20, co: 23, summary: 'Airbnb (Not available)' }, doisEventos[1]]);
    await ler(f); await ler(f);
    expect((await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id })).estado).toBe('confirmada');
    await ler(f);
    const ex = await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id });
    expect(ex.estado).toBe('bloqueio');
    expect(await limpezas(c)).toHaveLength(1);
    // e não volta a ser reserva nem a perguntar
    await ler(f);
    expect((await ReservaExterna.findOne({ uid: 'a', propriedade_id: c.casa._id })).estado).toBe('bloqueio');
  });

  test('22) estadia a decorrer que desaparece: só aviso, nunca cancela; check-out hoje/passado nunca conta', async () => {
    const c = await cenario();
    const evs = [{ uid: 'cur', ci: 0, co: 2 }, { uid: 'hoje', ci: -3, co: 0 }, { uid: 'fut', ci: 20, co: 23 }];
    const f = await ligar(c, URL_AIRBNB, AIRBNB(evs));
    mudar(f, 'www.airbnb.pt', [evs[2], { uid: 'fut2', ci: 30, co: 33 }]);
    for (let i = 0; i < 5; i++) await ler(f);
    const cur = await ReservaExterna.findOne({ uid: 'cur', propriedade_id: c.casa._id });
    expect(cur.estado).toBe('confirmada');
    expect((await ReservaManual.findById(cur.reserva_manual_id)).cancelada_em).toBeNull();
    expect(await noticias(c.dono, /a decorrer/)).toBe(1); // aviso uma só vez
    expect(await noticias(c.g, /a decorrer/)).toBe(1);
    const hoje = await ReservaExterna.findOne({ uid: 'hoje', propriedade_id: c.casa._id });
    expect(hoje.leituras_em_falta).toBe(0);
    expect(hoje.estado).toBe('confirmada');
  });

  test('23) UID trocado com as mesmas datas herda o estado; UID instável com 80 % de UID novos', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_BOOKING, BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 33 }]));
    const [e1, e2] = (await ReservaExterna.find({ propriedade_id: c.casa._id }).sort({ check_in: 1 }));
    expect((await Decisoes.confirmarExterna({ externaId: e1._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator })).status).toBe(200);
    expect((await Decisoes.marcarBloqueio({ externaId: e2._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator })).status).toBe(200);
    // o Booking troca os UID dos dois, com as mesmas datas
    mudar(f, 'ical.booking.com', [{ uid: 'novo1', ci: 20, co: 23 }, { uid: 'novo2', ci: 30, co: 33 }], 'booking');
    const r = await ler(f);
    expect(r.alteracoes.uid_trocados).toBe(2);
    const lista = await ReservaExterna.find({ propriedade_id: c.casa._id, estado: { $ne: 'substituida' } }).sort({ check_in: 1 }).lean();
    expect(lista.map((x) => x.estado)).toEqual(['confirmada', 'bloqueio']); // o bloqueio decidido não volta a perguntar
    expect(await limpezas(c)).toHaveLength(1); // a limpeza mantém-se
    expect(String((await ReservaManual.findOne({ propriedade_id: c.casa._id })).reserva_externa_id)).toBe(String(lista[0]._id));

    // UID instável: 5 eventos, todos com UID novo e datas conhecidas
    const c2 = await cenario();
    const base = Array.from({ length: 5 }, (_, i) => ({ uid: `x${i}`, ci: 20 + i * 5, co: 22 + i * 5 }));
    const f2 = await ligar(c2, URL_AIRBNB, AIRBNB(base));
    mudar(f2, 'www.airbnb.pt', base.map((e, i) => ({ ...e, uid: `y${i}` })));
    const r2 = await ler(f2);
    expect(r2.motivos).toContain('uids_todos_novos');
    expect((await FonteCalendario.findById(f2.id)).uid_instavel).toBe(true);
    expect(await limpezas(c2)).toHaveLength(5); // nada novo criado, nada cancelado
  });
});

describe('Booking: por confirmar e duplicados', () => {
  test('24) novo período = por_confirmar sem limpeza; confirmar cria a limpeza; dois cliques criam só uma; bloqueio não volta a perguntar', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_BOOKING, BOOKING([{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 33 }, { uid: 'longo', ci: 40, co: 80 }]));
    const ex = await ReservaExterna.find({ propriedade_id: c.casa._id }).sort({ check_in: 1 });
    expect(ex.map((x) => x.estado)).toEqual(['por_confirmar', 'por_confirmar', 'por_confirmar']);
    expect(ex[2].motivo).toBe('periodo_longo'); // mais de 30 noites: também é perguntado
    expect(await limpezas(c)).toHaveLength(0);
    const args = { externaId: ex[0]._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator };
    const [a, b] = await Promise.all([Decisoes.confirmarExterna(args), Decisoes.confirmarExterna(args)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await limpezas(c)).toHaveLength(1);
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(1);
    expect((await ReservaManual.findOne({ propriedade_id: c.casa._id })).plataforma).toBe('Booking.com');
    expect((await Decisoes.marcarBloqueio({ externaId: ex[1]._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator })).status).toBe(200);
    await ler(f); await ler(f);
    const depois = await ReservaExterna.find({ propriedade_id: c.casa._id }).sort({ check_in: 1 });
    expect(depois.map((x) => x.estado)).toEqual(['confirmada', 'bloqueio', 'por_confirmar']);
    expect(await limpezas(c)).toHaveLength(1);
    // reabrir um bloqueio decidido por engano
    expect((await Decisoes.reabrirBloqueio({ externaId: ex[1]._id, empresaId: c.e._id, parceiroId: c.dono._id, ator: c.ator })).status).toBe(200);
    expect((await ReservaExterna.findById(ex[1]._id)).estado).toBe('por_confirmar');
    // o gestor também pode decidir pelo proprietário (e o proprietário recebe aviso)
    const g = await Decisoes.confirmarExterna({ externaId: ex[1]._id, empresaId: c.e._id, ator: c.atorG });
    expect(g.status).toBe(200);
    expect(await noticias(c.dono, /A All2gether criou uma reserva tua/)).toBe(1);
    // desaparecer do feed um período por confirmar: cancela-se sozinho ao fim de N leituras
    mudar(f, 'ical.booking.com', [{ uid: 'b1', ci: 20, co: 23 }, { uid: 'b2', ci: 30, co: 33 }], 'booking');
    for (let i = 0; i < 3; i++) await ler(f);
    expect((await ReservaExterna.findOne({ uid: 'longo', propriedade_id: c.casa._id })).estado).toBe('cancelada');
    expect(await noticias(c.dono, /deixou de aparecer no Booking/)).toBe(1);
  });

  test('25) duplicados: Booking com as datas de um Airbnb «Reserved» = duplicada; com as de um «Not available» continua por_confirmar; Airbnb depois torna o Booking duplicada; Airbnb adota a manual; turnover; sobreposição', async () => {
    const c = await cenario();
    // Airbnb Reserved (20-23) e Not available (30-33)
    const fa = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }, { uid: 'a2', ci: 30, co: 33, summary: 'Airbnb (Not available)' }]));
    const fb = await ligar(c, URL_BOOKING, BOOKING([
      { uid: 'b1', ci: 20, co: 23 }, // = Reserved
      { uid: 'b2', ci: 30, co: 33 }, // = Not available (não deduplica)
      { uid: 'b3', ci: 23, co: 26 }, // turnover (sai e entra no mesmo dia): não é sobreposição
      { uid: 'b4', ci: 21, co: 25 }, // sobreposição com saída diferente
    ]));
    const por = async (u) => ReservaExterna.findOne({ propriedade_id: c.casa._id, uid: u });
    expect((await por('b1')).estado).toBe('duplicada');
    expect((await por('b2')).estado).toBe('por_confirmar');
    expect((await por('b3')).estado).toBe('por_confirmar');
    expect((await por('b3')).motivo).toBeNull();
    expect((await por('b4')).estado).toBe('por_confirmar');
    expect((await por('b4')).motivo).toBe('sobreposicao');
    expect(await limpezas(c)).toHaveLength(1);

    // Airbnb que chega DEPOIS de o Booking estar por confirmar torna-o duplicada
    mudar(fa, 'www.airbnb.pt', [{ uid: 'a1', ci: 20, co: 23 }, { uid: 'a2', ci: 30, co: 33, summary: 'Airbnb (Not available)' }, { uid: 'a3', ci: 23, co: 26 }]);
    await ler(fa);
    expect((await por('b3')).estado).toBe('duplicada');
    expect(await limpezas(c)).toHaveLength(2);
    void fb;
  });

  test('25b) Airbnb com a mesma estadia de uma reserva manual adota-a sem criar nova limpeza', async () => {
    const c = await cenario();
    const manual = await R.criarReservaComLimpeza({ parceiroId: c.dono._id, empresaId: c.e._id, body: { propriedade_id: String(c.casa._id), check_in: dia(20), check_out: dia(23), hospedes: 2 } });
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(1);
    expect(await limpezas(c)).toHaveLength(1);
    const rm = await ReservaManual.findById(manual.body.reserva._id);
    expect(rm.sincronizada).toBe(true);
    expect(rm.origem).toBe('manual');
    expect(String(rm.reserva_externa_id)).toBeTruthy();
    expect(await noticias(c.dono, /passou a ser atualizada pelo Airbnb/)).toBe(1);
    void f;
  });
});

describe('concorrência e elegibilidade', () => {
  test('26) duas leituras em paralelo na mesma casa (Airbnb e Booking) → uma só reserva e uma só limpeza; lock expirado é retomado', async () => {
    const c = await cenario();
    const ta = criarTransporte(AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    const tb = criarTransporte(BOOKING([{ uid: 'b1', ci: 20, co: 23 }]));
    const ra = await Servico.criarLigacao({ propriedadeId: c.casa._id, url: urlAirbnb(), escopo: c.escopoP, ator: c.ator, transporte: async (u) => ({ status: 500, headers: {}, corpo: Buffer.alloc(0) }) });
    const rb = await Servico.criarLigacao({ propriedadeId: c.casa._id, url: urlBooking(), escopo: c.escopoP, ator: c.ator, transporte: async () => ({ status: 500, headers: {}, corpo: Buffer.alloc(0) }) });
    const [x, y] = await Promise.all([sincronizarFonte(ra.body.fonte._id, { transporte: ta }), sincronizarFonte(rb.body.fonte._id, { transporte: tb })]);
    expect([x.resultado, y.resultado]).not.toContain('ocupado');
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(1);
    expect(await limpezas(c)).toHaveLength(1);
    // lock expirado de um processo morto é retomado
    await LockEmpresa.create({ _id: `ical:${c.casa._id}:${c.e._id}`, expira_em: new Date(Date.now() - 1000), dono: 'morto' });
    const z = await sincronizarFonte(ra.body.fonte._id, { transporte: ta });
    expect(z.resultado).not.toBe('ocupado');
    // lock ocupado (não expirado) → responde ocupado sem esperar
    await LockEmpresa.updateOne({ _id: `ical:${c.casa._id}:${c.e._id}` }, { $set: { expira_em: new Date(Date.now() + 60000), dono: 'vivo' } }, { upsert: true });
    expect((await sincronizarFonte(ra.body.fonte._id, { transporte: ta, esperaLockMs: 0 })).resultado).toBe('ocupado');
  });

  test('índice único: o mesmo evento nunca cria duas reservas', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    const ex = await ReservaExterna.findOne({ propriedade_id: c.casa._id });
    const r = await R.criarReservaComLimpeza({
      parceiroId: c.dono._id, empresaId: c.e._id, ator: { tipo: 'ical' }, camposReserva: { origem: 'ical', reserva_externa_id: ex._id, sincronizada: true },
      body: { propriedade_id: String(c.casa._id), check_in: dia(20), check_out: dia(23) },
    });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('EXTERNA_DUPLICADA');
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(1);
    void f;
  });

  test('27) casa com smoobu_id: não aceita; smoobu_id posto depois → suspensa; casa/proprietário inativos → pausada sem pedido HTTP; reativar não recria nada', async () => {
    const cs = await cenario({ smoobu: true });
    const rs = await Servico.criarLigacao({ propriedadeId: cs.casa._id, url: URL_AIRBNB, escopo: cs.escopoP, ator: cs.ator, transporte: criarTransporte({}) });
    expect(rs.status).toBe(400);
    expect(rs.body.codigo).toBe('CASA_SMOOBU');
    const ts = await Servico.testarLigacao({ propriedadeId: cs.casa._id, url: URL_AIRBNB, escopo: cs.escopoP, transporte: criarTransporte({}) });
    expect(ts.status).toBe(400);

    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { smoobu_id: '777' } });
    const antes = f.t.pedidos.length;
    expect((await ler(f)).resultado).toBe('suspensa');
    expect(f.t.pedidos.length).toBe(antes);
    expect(await FonteCalendario.findById(f.id)).toMatchObject({ estado: 'suspensa', motivo_estado: 'casa_ligada_smoobu' });
    expect(await noticias(c.g, /Smoobu/)).toBe(1);
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { smoobu_id: null } });
    expect((await ler(f)).resultado).toBe('suspensa'); // continua suspensa até ação humana
    // reativar uma fonte suspensa por Smoobu não é possível
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { smoobu_id: '777' } });
    await ler(f);
    expect((await Servico.reativarLigacao({ id: f.id, escopo: c.escopoP, transporte: f.t })).status).toBe(400);
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { smoobu_id: null } });
    await FonteCalendario.updateOne({ _id: f.id }, { $set: { estado: 'ativa', motivo_estado: null } });

    // casa inativa → pausada, sem pedido
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { ativo: false } });
    const n1 = f.t.pedidos.length;
    expect((await ler(f)).resultado).toBe('pausada');
    expect(f.t.pedidos.length).toBe(n1);
    expect(await FonteCalendario.findById(f.id)).toMatchObject({ estado: 'pausada', motivo_estado: 'casa_inativa' });
    // proprietário inativo
    await Propriedade.updateOne({ _id: c.casa._id }, { $set: { ativo: true } });
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: false } });
    expect((await ler(f)).resultado).toBe('pausada');
    expect(await FonteCalendario.findById(f.id)).toMatchObject({ motivo_estado: 'parceiro_inativo' });
    // reativação: volta a ler sozinha e NÃO recria nada
    const reservasAntes = await ReservaManual.countDocuments({ propriedade_id: c.casa._id });
    await Tarefa.updateMany({ propriedade_id: c.casa._id }, { $set: { estado: 'cancelada' } }); // o que a desativação fez às limpezas futuras
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { ativo: true } });
    const r = await ler(f);
    expect(r.resultado).toBe('sem_alteracoes');
    expect((await FonteCalendario.findById(f.id)).estado).toBe('ativa');
    expect(await ReservaManual.countDocuments({ propriedade_id: c.casa._id })).toBe(reservasAntes);
    expect(await limpezas(c)).toHaveLength(0);
  });

  test('proprietário eliminado ou casa que desaparece: a ligação é removida (o link é uma credencial)', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }]));
    await Utilizador.updateOne({ _id: c.dono._id }, { $set: { eliminado_em: new Date() } });
    expect((await ler(f)).resultado).toBe('removida');
    const fonte = await FonteCalendario.findById(f.id).select('+url_cifrada').lean();
    expect(fonte.removida).toBe(true);
    expect(fonte.url_cifrada).toBeUndefined();
    expect(fonte.apagar_apos).toBeTruthy();
  });
});

describe('remover a ligação', () => {
  test('cancela as limpezas futuras que vieram do calendário (não iniciadas), com aviso e número; as iniciadas ficam', async () => {
    const c = await cenario();
    const f = await ligar(c, URL_AIRBNB, AIRBNB([{ uid: 'a1', ci: 20, co: 23 }, { uid: 'a2', ci: 30, co: 33 }, { uid: 'a3', ci: 40, co: 43 }]));
    const manual = await R.criarReservaComLimpeza({ parceiroId: c.dono._id, empresaId: c.e._id, body: { propriedade_id: String(c.casa._id), check_in: dia(50), check_out: dia(53) } });
    const t3 = await Tarefa.findOne({ propriedade_id: c.casa._id, data: new Date(`${dia(43)}T09:00:00Z`) });
    void t3;
    const emCurso = (await limpezas(c)).find((t) => t.data.toISOString().slice(0, 10) === dia(43));
    await Tarefa.updateOne({ _id: emCurso._id }, { $set: { estado: 'em_curso' } });
    const imp = await Servico.impactoRemocao({ id: f.id, escopo: c.escopoP });
    expect(imp.body.limpezas_a_cancelar).toBe(2);
    const r = await Servico.removerLigacao({ id: f.id, escopo: c.escopoP, ator: c.ator });
    expect(r.status).toBe(200);
    expect(r.body.limpezas_canceladas).toBe(2);
    const ativas = await limpezas(c);
    expect(ativas.map((t) => String(t._id)).sort()).toEqual([String(emCurso._id), String(manual.body.tarefa._id)].sort());
    expect(await noticias(c.dono, /2 limpezas futuras foram canceladas/)).toBe(1);
    expect(await noticias(c.g, /2 limpezas futuras foram canceladas/)).toBe(1);
    const fonte = await FonteCalendario.findById(f.id).select('+url_cifrada +url_hash').lean();
    expect(fonte.url_cifrada).toBeUndefined();
    expect(fonte.url_hash).toBeUndefined();
    expect(fonte.removida).toBe(true);
    // a manual do proprietário não é tocada e a reserva em curso passa a ser uma reserva normal
    expect((await ReservaManual.findById(manual.body.reserva._id)).cancelada_em).toBeNull();
    expect((await ReservaManual.findById(emCurso && (await ReservaManual.findOne({ tarefa_gerada_id: emCurso._id }))._id)).sincronizada).toBe(false);
    // o mesmo link pode voltar a ser ligado
    const t = criarTransporte(AIRBNB([]));
    expect((await Servico.criarLigacao({ propriedadeId: c.casa._id, url: f.url, escopo: c.escopoP, ator: c.ator, transporte: t })).status).toBe(201);
  });
});
