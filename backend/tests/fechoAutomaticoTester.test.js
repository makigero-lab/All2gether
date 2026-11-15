/**
 * @Tester — fecho automático: fusos/DST, recuperação, equipas, corridas, segurança da confirmação tardia,
 * endpoint da lista, arquivo e efeitos colaterais. Complementa fechoAutomatico.test.js (do @Dev).
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
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const { executarFechoAutomatico, diasParaFechar } = require('../jobs/fechoAutomatico');
const { executarArquivista } = require('../jobs/arquivista');
const { aoConcluirTarefa } = require('../utils/cicloTarefa');

let mongod;
let n = 0;
const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
const FOTO = 'data:image/jpeg;base64,/9j/4AAQ';
const AGORA = new Date('2040-05-10T19:00:00Z'); // 20:00 Lisboa (verão)
const T_HOJE = new Date('2040-05-10T10:00:00Z');

async function cenario() {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role, ex = {}) =>
    Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...ex });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const parc = await mk('Par', 'parceiro');
  const p = await Propriedade.create({
    nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4,
    tempo_limpeza_minutos: 60, parceiro_id: parc._id,
  });
  const tarefa = (data, ex = {}) =>
    Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, data, tempo_limpeza_minutos: 60, estado: 'em_curso', tipo: 'limpeza', ...ex });
  return { e, g, ana, bia, parc, p, mk, tarefa, tokG: await login(g), tokAna: await login(ana), tokBia: await login(bia), tokP: await login(parc) };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Tarefa.deleteMany({});
  await TarefaArquivo.deleteMany({});
  await Notificacao.deleteMany({});
});
afterEach(() => jest.restoreAllMocks());

describe('Fusos e mudança de hora', () => {
  test('mudança de março (25/03/2040): 20:00 locais = 19:00Z; 19:59 locais não fecha hoje', () => {
    expect(diasParaFechar(new Date('2040-03-25T19:00:00Z'))[0]).toBe('2040-03-25');
    expect(diasParaFechar(new Date('2040-03-25T18:59:00Z'))).not.toContain('2040-03-25');
    // dia anterior ao salto, ainda inverno: 20:00 = 20:00Z
    expect(diasParaFechar(new Date('2040-03-24T20:00:00Z'))[0]).toBe('2040-03-24');
    expect(diasParaFechar(new Date('2040-03-24T19:59:00Z'))).not.toContain('2040-03-24');
  });
  test('mudança de outubro (28/10/2040): 20:00 locais = 20:00Z; 19:00Z ainda é 19:00 locais', () => {
    expect(diasParaFechar(new Date('2040-10-28T20:00:00Z'))[0]).toBe('2040-10-28');
    expect(diasParaFechar(new Date('2040-10-28T19:00:00Z'))).not.toContain('2040-10-28');
    expect(diasParaFechar(new Date('2040-10-27T19:00:00Z'))[0]).toBe('2040-10-27'); // verão ainda
    expect(diasParaFechar(new Date('2040-10-27T18:59:00Z'))).not.toContain('2040-10-27');
  });
  test('perto da meia-noite UTC/Lisboa: 23:30Z de verão já é dia seguinte em Lisboa', () => {
    const d = diasParaFechar(new Date('2040-05-10T23:30:00Z')); // 00:30 do dia 11 em Lisboa
    expect(d[0]).toBe('2040-05-10'); // hoje (Lisboa) é 11, mas 20:00 do 10 já passou: 10 está na lista
    expect(d).not.toContain('2040-05-11');
    const d2 = diasParaFechar(new Date('2040-05-11T00:30:00Z')); // 01:30 do dia 11 em Lisboa
    expect(d2).not.toContain('2040-05-11');
    expect(d2[0]).toBe('2040-05-10');
  });
  test('limpeza das 17:30 locais no dia da mudança de março fecha às 20:00 desse dia', async () => {
    const c = await cenario();
    const t = await c.tarefa(new Date('2040-03-25T16:30:00Z')); // 17:30 BST
    expect((await executarFechoAutomatico(new Date('2040-03-25T18:59:00Z'))).fechadas).toBe(0);
    expect((await executarFechoAutomatico(new Date('2040-03-25T19:00:00Z'))).fechadas).toBe(1);
    expect((await Tarefa.findById(t._id).lean()).estado).toBe('concluida');
  });
  test('data com hora de Lisboa depois da meia-noite local (00:30 locais verão = 23:30Z do dia anterior)', async () => {
    // convenção: o dia é o dia UTC. Documenta o comportamento (limpeza às 00:30 = hora inválida <06:00).
    const c = await cenario();
    const t = await c.tarefa(new Date('2040-05-10T23:30:00Z')); // 00:30 de 11/05 em Lisboa
    const r = await executarFechoAutomatico(new Date('2040-05-10T23:45:00Z')); // 00:45 de 11/05 Lisboa
    // fecha 15 minutos depois de começar (dia UTC = 10): comportamento a reportar como baixo
    expect(r.fechadas).toBe(1);
    expect((await Tarefa.findById(t._id).lean()).estado).toBe('concluida');
  });
});

describe('Recuperação depois de o servidor dormir', () => {
  const dia = new Date('2040-05-10T10:00:00Z');
  const quando = {
    'acorda às 21:00 do mesmo dia': ['2040-05-10T20:00:00Z', 1],
    'acorda às 08:00 do dia seguinte': ['2040-05-11T07:00:00Z', 1],
    '2 dias depois': ['2040-05-12T09:00:00Z', 1],
    '3 dias depois (limite)': ['2040-05-13T09:00:00Z', 1],
    '3 dias depois às 21:00': ['2040-05-13T20:30:00Z', 1],
    '4 dias depois (fora da janela)': ['2040-05-14T09:00:00Z', 0],
    '19:59 do próprio dia': ['2040-05-10T18:59:00Z', 0],
  };
  for (const [nome, [iso, esperado]] of Object.entries(quando)) {
    test(nome, async () => {
      const c = await cenario();
      const t = await c.tarefa(dia);
      const r = await executarFechoAutomatico(new Date(iso));
      expect(r.fechadas).toBe(esperado);
      expect((await Tarefa.findById(t._id).lean()).estado).toBe(esperado ? 'concluida' : 'em_curso');
    });
  }
  test('na recuperação concluida_em é a hora da execução (e não 20:00): documentado', async () => {
    const c = await cenario();
    const t = await c.tarefa(dia);
    const acorda = new Date('2040-05-11T07:00:00Z');
    await executarFechoAutomatico(acorda);
    expect((await Tarefa.findById(t._id).lean()).concluida_em.toISOString()).toBe(acorda.toISOString());
  });
  test('erro na BD devolve erro visível e não lança', async () => {
    jest.spyOn(Tarefa, 'find').mockImplementationOnce(() => { throw new Error('boom'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await executarFechoAutomatico(AGORA);
    expect(r.erro).toBe('boom');
  });
});

describe('Quem é fechado', () => {
  test('equipa de 2: responsável + membro; fecha uma vez; o membro pode confirmar; o responsável depois já não', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { equipa_atribuida: [c.ana._id, c.bia._id] });
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(1);
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokBia)).send({ fotos_conclusao: [FOTO] });
    expect(r.status).toBe(200);
    const r2 = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(r2.status).toBe(400);
  });
  test('equipa preenchida mas sem utilizador_id (fantasma): não fecha', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { utilizador_id: null, equipa_atribuida: [c.ana._id, c.bia._id] });
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(0);
    expect((await Tarefa.findById(t._id).lean()).estado).toBe('em_curso');
  });
  test('avulsa (sem reserva), tipo_limpeza e iCal/Smoobu fecham da mesma maneira; check_in/out/outro não', async () => {
    const c = await cenario();
    const avulsa = await c.tarefa(T_HOJE);
    const smoobu = await c.tarefa(T_HOJE, { smoobu_reserva_id: 'abc' });
    const outro = await c.tarefa(T_HOJE, { tipo: 'outro' });
    const ci = await c.tarefa(T_HOJE, { tipo: 'check_in' });
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(2);
    expect((await Tarefa.findById(avulsa._id).lean()).estado).toBe('concluida');
    expect((await Tarefa.findById(smoobu._id).lean()).estado).toBe('concluida');
    expect((await Tarefa.findById(outro._id).lean()).estado).toBe('em_curso');
    expect((await Tarefa.findById(ci._id).lean()).estado).toBe('em_curso');
  });
  test('nao_atribuida/por_atribuir com utilizador (lixo) não fecham', async () => {
    const c = await cenario();
    await c.tarefa(T_HOJE, { estado: 'por_atribuir' });
    await c.tarefa(T_HOJE, { estado: 'nao_atribuida' });
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(0);
  });
  test('muitas tarefas: fecha todas, uma segunda execução paralela não duplica', async () => {
    const c = await cenario();
    for (let i = 0; i < 25; i++) await c.tarefa(T_HOJE);
    const [a, b] = await Promise.all([executarFechoAutomatico(AGORA), executarFechoAutomatico(AGORA)]);
    expect(a.fechadas + b.fechadas).toBe(25);
    expect(await Tarefa.countDocuments({ conclusao_origem: 'automatica' })).toBe(25);
  });
});

describe('Corridas', () => {
  test('o gestor cancela entre a leitura e a escrita: o job não ressuscita', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    const realFind = Tarefa.find.bind(Tarefa);
    jest.spyOn(Tarefa, 'find').mockImplementationOnce((...args) => {
      const q = realFind(...args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const docs = await exec();
        await Tarefa.updateOne({ _id: t._id }, { $set: { estado: 'cancelada', utilizador_id: null } });
        return docs;
      };
      return q;
    });
    const r = await executarFechoAutomatico(AGORA);
    expect(r.fechadas).toBe(0);
    expect((await Tarefa.findById(t._id).lean()).estado).toBe('cancelada');
  });
  test('o gestor reabre (por_atribuir sem pessoa) entre a leitura e a escrita: o job não fecha', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    const realFind = Tarefa.find.bind(Tarefa);
    jest.spyOn(Tarefa, 'find').mockImplementationOnce((...args) => {
      const q = realFind(...args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const docs = await exec();
        await Tarefa.updateOne({ _id: t._id }, { $set: { estado: 'por_atribuir', utilizador_id: null } });
        return docs;
      };
      return q;
    });
    expect((await executarFechoAutomatico(AGORA)).fechadas).toBe(0);
  });
  test('staff conclui à mão logo depois do job (leitura antiga) = confirmação tardia consistente', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] }),
      request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
  });
  test('o gestor reabre uma fechada auto, a pessoa conclui normal: continua a constar como «fechada automaticamente»?', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'em_curso' });
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(r.status).toBe(200);
    const d = await Tarefa.findById(t._id).lean();
    expect(d.conclusao_origem).toBe('staff');
    expect(d.confirmada_depois_em).toBeNull();
    // Esta limpeza foi feita e fechada de verdade pela pessoa: não devia aparecer na lista «Fechadas automaticamente».
    const l = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(l.body.limpezas.map((x) => x._id)).not.toContain(String(t._id));
  });
  test('o gestor reabre e volta a fechar à mão: não devia constar na lista nem ficar fora do tempo real', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'atribuida' });
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'concluida' });
    const l = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(l.body.limpezas.map((x) => x._id)).not.toContain(String(t._id));
  });
});

describe('Confirmação tardia: segurança', () => {
  async function fechada() {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    return { c, t };
  }
  test('outra pessoa da mesma empresa que não está atribuída: 404 e nada muda', async () => {
    const { c, t } = await fechada();
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokBia)).send({ fotos_conclusao: [FOTO] });
    expect(r.status).toBe(404);
    expect((await Tarefa.findById(t._id).lean()).conclusao_origem).toBe('automatica');
  });
  test('sem fotos / fotos vazias / fotos inválidas / tipos errados: 400 e continua automática', async () => {
    const { c, t } = await fechada();
    for (const body of [{}, { fotos_conclusao: [] }, { fotos_conclusao: ['  '] }, { fotos_conclusao: 'x' }, { fotos_conclusao: [123] }, { fotos_conclusao: null }]) {
      const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send(body);
      expect(r.status).toBe(400);
    }
    expect((await Tarefa.findById(t._id).lean()).conclusao_origem).toBe('automatica');
  });
  test('staff inativa/eliminada não confirma', async () => {
    const { c, t } = await fechada();
    await Utilizador.updateOne({ _id: c.ana._id }, { $set: { ativo: false } });
    const r = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect([401, 403]).toContain(r.status);
    expect((await Tarefa.findById(t._id).lean()).conclusao_origem).toBe('automatica');
  });
  test('sem sessão: 401; parceiro: não confirma; gestor da mesma empresa pela rota de staff: não é membro', async () => {
    const { c, t } = await fechada();
    expect((await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).send({ fotos_conclusao: [FOTO] })).status).toBe(401);
    const rp = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokP)).send({ fotos_conclusao: [FOTO] });
    expect([403, 404]).toContain(rp.status);
    const rg = await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokG)).send({ fotos_conclusao: [FOTO] });
    expect([403, 404]).toContain(rg.status);
    expect((await Tarefa.findById(t._id).lean()).conclusao_origem).toBe('automatica');
  });
  test('o gestor vê o estado certo depois da confirmação (prova e lista)', async () => {
    const { c, t } = await fechada();
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO], observacoes_staff: 'ok' });
    const prova = await request(app).get(`/api/gestor/tarefas/${t._id}/prova`).set(auth(c.tokG));
    expect(prova.body.fechada_automaticamente).toBe(false);
    expect(prova.body.confirmada_depois).toBe(true);
    expect(prova.body.hora_conclusao).toBeNull();
    expect(prova.body.fotos).toHaveLength(1);
    const l = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    const item = l.body.limpezas.find((x) => x._id === String(t._id));
    expect(item.confirmada_depois).toBe(true);
    expect(item.acrescentou.notas).toBe(true);
  });
  test('confirmar uma concluída normal continua a dar 400; manutenção concluída idem', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE, { estado: 'concluida', conclusao_origem: 'staff', hora_conclusao: AGORA, concluida_em: AGORA });
    expect((await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] })).status).toBe(400);
    const legada = await c.tarefa(T_HOJE, { estado: 'concluida', hora_conclusao: AGORA, concluida_em: AGORA }); // sem conclusao_origem (dados antigos)
    expect((await request(app).patch(`/api/staff/tarefas/${legada._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] })).status).toBe(400);
  });
  test('checklist e avaria numa fechada automática', async () => {
    const { c, t } = await fechada();
    const av = await request(app).post(`/api/staff/tarefas/${t._id}/avaria`).set(auth(c.tokAna)).send({ descricao: 'torneira' });
    expect([200, 400]).toContain(av.status);
  });
});

describe('Endpoint da lista', () => {
  async function comUma() {
    const c = await cenario();
    const agora = new Date();
    const dia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10));
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, fechada_automaticamente_em: agora });
    return c;
  }
  test('dias inválidos caem no padrão/limite sem 500', async () => {
    const c = await comUma();
    for (const q of ['dias=abc', 'dias=-5', 'dias=0', 'dias=1000', 'dias=7.9', 'dias[]=3', 'dias=', 'dias=1e9', 'dias=%00', 'dias=NaN', 'dias=Infinity']) {
      const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente?' + q).set(auth(c.tokG));
      expect(r.status).toBe(200);
      expect(r.body.dias).toBeGreaterThanOrEqual(1);
      expect(r.body.dias).toBeLessThanOrEqual(30);
    }
    const r1000 = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente?dias=1000').set(auth(c.tokG));
    expect(r1000.body.dias).toBe(30);
    const rneg = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente?dias=-5').set(auth(c.tokG));
    expect(rneg.body.dias).toBe(7);
  });
  test('staff 403, parceiro 403, sem sessão 401, token lixo 401', async () => {
    const c = await comUma();
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokAna))).status).toBe(403);
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokP))).status).toBe(403);
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente')).status).toBe(401);
    expect((await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth('lixo'))).status).toBe(401);
  });
  test('isolamento: gestor de outra empresa não vê estas', async () => {
    const c = await comUma();
    const o = await cenario();
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(o.tokG));
    expect(r.body.total).toBe(0);
    const r2 = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(r2.body.total).toBe(1);
  });
  test('formato: campos esperados e sem fotos em base64 na resposta', async () => {
    const c = await cenario();
    const agora = new Date();
    const dia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10));
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, fechada_automaticamente_em: agora, fotos_conclusao: [FOTO] });
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    const l = r.body.limpezas[0];
    // ajustado: a lista passou a trazer também os campos para abrir o modal da limpeza (tipo, tempo, origem, concluida_em...)
    expect(Object.keys(l).sort()).toEqual(['_id', 'acrescentou', 'acrescentou_algo', 'casa', 'concluida_em', 'conclusao_origem', 'confirmada_depois', 'confirmada_depois_em', 'data', 'fechada_em', 'pessoas', 'tempo_limpeza_minutos', 'tipo', 'tipo_limpeza'].sort());
    expect(JSON.stringify(r.body)).not.toContain('base64');
  });
  test('limpeza da casa apagada (propriedade nula) e pessoa apagada não rebentam', async () => {
    const c = await cenario();
    const agora = new Date();
    const dia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10));
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, fechada_automaticamente_em: agora });
    await Propriedade.deleteMany({ _id: c.p._id });
    await Utilizador.deleteMany({ _id: c.ana._id });
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });
  test('avarias registadas depois do fecho contam', async () => {
    const c = await cenario();
    const agora = new Date();
    const dia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 10));
    await c.tarefa(dia, {
      estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, fechada_automaticamente_em: new Date(agora.getTime() - 1000),
      avarias: [{ descricao: 'x', data_registo: agora }, { descricao: 'antes', data_registo: new Date(agora.getTime() - 5000) }],
    });
    const r = await request(app).get('/api/gestor/limpezas/fechadas-automaticamente').set(auth(c.tokG));
    expect(r.body.limpezas[0].acrescentou.avarias).toBe(1);
  });
});

describe('Efeitos colaterais', () => {
  test('nenhuma notificação para o parceiro por nenhuma via no fecho nem na confirmação', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.parc._id, empresa_id: c.e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
    await executarFechoAutomatico(AGORA);
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    await aoConcluirTarefa(await Tarefa.findById(t._id));
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(0);
    // ajustado: o fecho passou a avisar a PESSOA (sino, uma vez); ninguém mais recebe nada
    expect(await Notificacao.countDocuments({ utilizador_id: { $ne: c.ana._id } })).toBe(0);
    expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id, chave: `fecho_automatico:${t._id}` })).toBe(1);
  });
  test('conclusão normal pela pessoa CONTINUA a avisar o proprietário (regressão)', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.parc._id, empresa_id: c.e._id, check_in: new Date('2040-05-08T00:00:00Z'), check_out: new Date('2040-05-10T00:00:00Z'), tarefa_gerada_id: t._id });
    await request(app).patch(`/api/staff/tarefas/${t._id}/concluir`).set(auth(c.tokAna)).send({ fotos_conclusao: [FOTO] });
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(1);
  });
  test('gestor fecha à mão (concluida) avisa o proprietário (regressão)', async () => {
    const c = await cenario();
    const t = await c.tarefa(T_HOJE);
    await request(app).patch(`/api/gestor/tarefas/${t._id}/estado`).set(auth(c.tokG)).send({ estado: 'concluida' });
    expect(await Notificacao.countDocuments({ utilizador_id: c.parc._id })).toBe(1);
  });
  test('arquivo: tarefa fechada automaticamente arquivada conserva a origem', async () => {
    const c = await cenario();
    const velha = new Date('2020-01-10T10:00:00Z'); // ajustado: 2039 está no futuro e o arquivista nunca a apanhava
    await c.tarefa(velha, { estado: 'concluida', conclusao_origem: 'automatica', fechada_automaticamente_em: velha, concluida_em: velha });
    await executarArquivista({ meses: 3 });
    const a = await TarefaArquivo.findOne({}).lean();
    expect(a).toBeTruthy();
    expect(a.conclusao_origem).toBe('automatica');
    expect(a.fechada_automaticamente_em).toBeTruthy();
  });
  test('relatório de produtividade não conta fechadas automáticas (mesmo com hora_conclusao residual)', async () => {
    const c = await cenario();
    const hoje = new Date();
    const dia = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 10));
    await c.tarefa(dia, { estado: 'concluida', conclusao_origem: 'automatica', fechada_automaticamente_em: hoje, concluida_em: hoje, hora_conclusao: new Date(dia.getTime() + 3600000), data_conclusao: hoje });
    const r = await request(app).get('/api/gestor/relatorios/produtividade').set(auth(c.tokG));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/"minutos[^"]*":[1-9]/);
  });
  test('RGPD: exportação da pessoa funciona com tarefas fechadas automaticamente', async () => {
    const c = await cenario();
    await c.tarefa(T_HOJE);
    await executarFechoAutomatico(AGORA);
    const r = await request(app).get('/api/gestor/equipa/' + c.ana._id + '/exportar-dados').set(auth(c.tokG));
    expect([200, 404]).toContain(r.status);
  });
});
