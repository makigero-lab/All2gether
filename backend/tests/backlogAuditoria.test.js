/** Backlog da auditoria (2a-2k): cada teste falhava antes da correção correspondente. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

process.env.SMOOBU_WEBHOOK_AUTH_DISABLED = 'true';
const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const { executarArquivista, validarMeses } = require('../jobs/arquivista');
const { executarRetencao } = require('../jobs/retencao');
const { pseudonimizarContexto, construirContexto, construirPrompt } = require('../controllers/relatorioController');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const auth = (t) => ({ Authorization: 'Bearer ' + t });

async function cenario() {
  const e = await Empresa.create({ nome: 'B' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: 'p-de-teste-123' })).body.token;
  return { e, mk, login };
}
const casa = (e) => Propriedade.create({ nome: 'P' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60 });

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('2a segurança de contas', () => {
  test('um gestor não altera, desativa nem elimina outro gestor; pode editar-se a si próprio', async () => {
    const { mk, login } = await cenario();
    const g1 = await mk('g1', 'gestor');
    const g2 = await mk('g2', 'gestor');
    const t = await login(g1);
    const alt = await request(app).put(`/api/gestor/equipa/${g2._id}`).set(auth(t)).send({ password: 'nova-password-longa', email: 'tomada@x.pt' });
    expect(alt.status).toBe(403);
    expect((await Utilizador.findById(g2._id)).email).not.toBe('tomada@x.pt');
    expect((await request(app).patch(`/api/gestor/equipa/${g2._id}/estado`).set(auth(t)).send({ ativo: false })).status).toBe(403);
    expect((await request(app).delete(`/api/gestor/equipa/${g2._id}`).set(auth(t))).status).toBe(403);
    const criar = await request(app).post('/api/gestor/equipa').set(auth(t)).send({ nome: 'x', email: 'novo.g@x.pt', password: 'password-longa-123', role: 'gestor' });
    expect(criar.status).toBe(403);
    const eu = await request(app).put(`/api/gestor/equipa/${g1._id}`).set(auth(t)).send({ nome: 'Novo Nome' });
    expect(eu.status).toBe(200);
    const promover = await request(app).put(`/api/gestor/equipa/${g1._id}`).set(auth(t)).send({ role: 'staff' });
    expect(promover.status).toBe(403);
  });

  test('parceiro e fornecedor não cancelam ausências; staff só as suas', async () => {
    const { e, mk, login } = await cenario();
    const staff = await mk('s', 'staff');
    const outro = await mk('o', 'staff');
    const par = await mk('p', 'parceiro');
    const forn = await mk('f', 'fornecedor');
    const au = await Ausencia.create({ utilizador_id: staff._id, empresa_id: e._id, data_inicio: new Date('2090-01-10T00:00:00Z'), data_fim: new Date('2090-01-10T00:00:00Z'), tipo: 'ferias', estado: 'aprovada' });
    for (const u of [par, forn]) {
      expect((await request(app).patch(`/api/gestor/ausencias/${au._id}/cancelar`).set(auth(await login(u)))).status).toBe(403);
    }
    expect((await request(app).patch(`/api/gestor/ausencias/${au._id}/cancelar`).set(auth(await login(outro)))).status).toBe(404);
    expect((await Ausencia.findById(au._id)).estado).toBe('aprovada');
    expect((await request(app).get('/api/staff/ausencias').set(auth(await login(par)))).status).toBe(403);
    expect((await request(app).patch(`/api/gestor/ausencias/${au._id}/cancelar`).set(auth(await login(staff)))).status).toBe(200);
  });

  test('diagnóstico de ausências não lê utilizadores de outra empresa', async () => {
    const a = await cenario();
    const b = await cenario();
    const g = await a.mk('g', 'gestor');
    const alheio = await b.mk('alheio', 'staff');
    await Ausencia.create({ utilizador_id: alheio._id, empresa_id: b.e._id, data_inicio: new Date('2090-02-10T00:00:00Z'), data_fim: new Date('2090-02-10T00:00:00Z'), tipo: 'doenca', estado: 'aprovada' });
    const r = await request(app).get(`/api/gestor/ausencias/diagnostico/${alheio._id}`).set(auth(await a.login(g)));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/alheio/);
  });

  test('impersonation: sessão curta, claim do admin e auditoria', async () => {
    const jwt = require('jsonwebtoken');
    const Auditoria = require('../models/Auditoria');
    const { e, mk, login } = await cenario();
    const admin = await mk('adm', 'admin');
    await mk('gg', 'gestor');
    const r = await request(app).post(`/api/admin/empresas/${e._id}/impersonar`).set(auth(await login(admin))).send({});
    expect(r.status).toBe(200);
    const p = jwt.decode(r.body.token);
    expect(p.imp).toBe(String(admin._id));
    expect(p.exp - p.iat).toBeLessThanOrEqual(2 * 3600);
    expect(await Auditoria.countDocuments({ acao: 'impersonar', empresa_id: e._id })).toBe(1);
  });

  test('/api/auth/me/tarefas/:id/concluir exige fotos como o caminho do staff', async () => {
    const { e, mk, login } = await cenario();
    const s = await mk('st', 'staff');
    const p = await casa(e);
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: s._id, data: new Date(), estado: 'atribuida', tempo_limpeza_minutos: 60 });
    const tok = await login(s);
    const sem = await request(app).patch(`/api/auth/me/tarefas/${t._id}/concluir`).set(auth(tok)).send({});
    expect(sem.status).toBe(400);
    expect((await Tarefa.findById(t._id)).estado).toBe('atribuida');
    const com = await request(app).patch(`/api/auth/me/tarefas/${t._id}/concluir`).set(auth(tok)).send({ fotos_conclusao: ['data:image/jpeg;base64,AAAA'] });
    expect(com.status).toBe(200);
  });
});

describe('2b webhook Smoobu com limite de corpo', () => {
  test('corpo de 300 KB -> 413 claro; corpo normal continua a ser aceite (continua aberto)', async () => {
    const grande = await request(app).post('/api/smoobu/webhook').send({ action: 'updateRates', user: 1, data: { x: 'a'.repeat(300 * 1024) } });
    expect(grande.status).toBe(413);
    expect(grande.body.erro).toMatch(/webhook/i);
    const normal = await request(app).post('/api/smoobu/webhook').send({ action: 'updateRates', user: 1, data: {} });
    expect(normal.status).not.toBe(401);
    expect(normal.status).not.toBe(413);
    // as outras rotas mantêm os 10 MB (fotos)
    const fotos = await request(app).post('/api/auth/login').send({ email: 'a@b.pt', password: 'x'.repeat(300 * 1024) });
    expect(fotos.status).not.toBe(413);
  });
});

describe('2e listagens sem fotos', () => {
  test('/me/tarefas e /me/calendario não trazem fotos; o detalhe traz', async () => {
    const { e, mk, login } = await cenario();
    const s = await mk('st', 'staff');
    const p = await casa(e);
    const hoje = new Date(); hoje.setUTCHours(10, 0, 0, 0);
    const t = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: s._id, data: hoje, estado: 'concluida', tempo_limpeza_minutos: 60, fotos_conclusao: ['data:image/jpeg;base64,AAAA'], avarias: [{ descricao: 'x', fotos: ['data:image/jpeg;base64,BBBB'] }] });
    const tok = await login(s);
    const lista = await request(app).get('/api/auth/me/tarefas').set(auth(tok));
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toMatch(/base64/);
    const cal = await request(app).get('/api/auth/me/calendario').set(auth(tok));
    expect(JSON.stringify(cal.body)).not.toMatch(/base64/);
    const det = await request(app).get(`/api/auth/me/tarefas/${t._id}`).set(auth(tok));
    expect(det.status).toBe(200);
    expect(JSON.stringify(det.body)).toMatch(/base64/);
  });
});

describe('2g/2h baixa e falta com o tipo certo', () => {
  test('baixa regista o tipo escolhido (falta, doenca, ferias)', async () => {
    const { mk, login } = await cenario();
    const g = await mk('g', 'gestor');
    const s = await mk('st', 'staff');
    const tok = await login(g);
    for (const [tipo, dia] of [['falta', '2091-01-10'], ['doenca', '2091-02-10'], ['ferias', '2091-03-10']]) {
      const r = await request(app).post(`/api/gestor/equipa/${s._id}/baixa`).set(auth(tok)).send({ data_inicio: dia, data_fim: dia, tipo });
      expect([tipo, r.status]).toEqual([tipo, 200]);
      expect((await Ausencia.findOne({ utilizador_id: s._id, data_inicio: new Date(`${dia}T00:00:00Z`) })).tipo).toBe(tipo);
    }
    expect((await request(app).post(`/api/gestor/equipa/${s._id}/baixa`).set(auth(tok)).send({ data_inicio: '2091-04-10', data_fim: '2091-04-10', tipo: 'xpto' })).status).toBe(400);
  });

  test('falta de hoje (staff) e falta súbita (gestor) ficam como falta, nunca doenca', async () => {
    const { mk, login } = await cenario();
    const g = await mk('g', 'gestor');
    const s = await mk('st', 'staff');
    const s2 = await mk('st2', 'staff');
    const r1 = await request(app).post('/api/staff/falta-hoje').set(auth(await login(s))).send({ justificacao: 'não posso ir' });
    expect(r1.status).toBe(201);
    expect(r1.body.ausencia.tipo).toBe('falta');
    const r2 = await request(app).post(`/api/gestor/equipa/${s2._id}/falta-subita`).set(auth(await login(g))).send({});
    expect(r2.status).toBe(200);
    expect(await Ausencia.countDocuments({ utilizador_id: s2._id, tipo: 'falta' })).toBe(1);
    expect(await Ausencia.countDocuments({ tipo: 'doenca', utilizador_id: { $in: [s._id, s2._id] } })).toBe(0);
  });
});

describe('2i nomes não vão para a IA', () => {
  test('o prompt só leva Pessoa N e a resposta repõe os nomes', () => {
    const ctx = construirContexto({
      resumo: { total: 3, concluidas: 2 },
      porStaff: [
        { nome: 'Maria Silva', total: 2, concluidas: 2, taxaConclusao: 1, carga_minutos: 120 },
        { nome: 'João Costa', total: 1, concluidas: 0, taxaConclusao: 0, carga_minutos: 60 },
        { nome: 'Por atribuir', total: 1, concluidas: 0, taxaConclusao: 0, carga_minutos: 30 },
      ],
      porPropriedade: [{ nome: 'Casa do Mar', total: 3, carga_minutos: 210 }],
    });
    const { contexto, repor } = pseudonimizarContexto(ctx);
    const prompt = construirPrompt(contexto);
    expect(prompt).not.toMatch(/Maria|Silva|João|Costa/);
    expect(prompt).toMatch(/Pessoa 1/);
    expect(prompt).toMatch(/Por atribuir/);
    expect(repor('Pessoa 1 e Pessoa 2 foram os melhores; Pessoa 10 não existe.')).toBe('Maria Silva e João Costa foram os melhores; Pessoa 10 não existe.');
    // o contexto original mantém os nomes (placeholder local)
    expect(ctx.porStaff[0].nome).toBe('Maria Silva');
  });
});

describe('2j retenção', () => {
  test('anonimiza hóspedes e apaga ausências antigas; doença mais cedo', async () => {
    const { e, mk } = await cenario();
    const s = await mk('st', 'staff');
    const p = await casa(e);
    const velha = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date('2020-01-10T10:00:00Z'), estado: 'concluida', detalhes_reserva: { nome_hospede: 'Fulano', notas_hospede: 'alergia' } });
    const nova = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date(Date.now() + 5 * 86400000), estado: 'atribuida', detalhes_reserva: { nome_hospede: 'Beltrano' } });
    await Ausencia.create({ utilizador_id: s._id, empresa_id: e._id, data_inicio: new Date('2020-01-10'), data_fim: new Date('2020-01-10'), tipo: 'ferias', estado: 'aprovada' });
    const m18 = new Date(); m18.setMonth(m18.getMonth() - 18);
    const dRec = new Date(Date.UTC(m18.getUTCFullYear(), m18.getUTCMonth(), 1));
    await Ausencia.create({ utilizador_id: s._id, empresa_id: e._id, data_inicio: dRec, data_fim: dRec, tipo: 'doenca', estado: 'aprovada' });
    await Ausencia.create({ utilizador_id: s._id, empresa_id: e._id, data_inicio: dRec, data_fim: new Date(dRec.getTime() + 86400000), tipo: 'ferias', estado: 'aprovada' });
    const r = await executarRetencao();
    expect(r.erro).toBeUndefined();
    const v = await Tarefa.findById(velha._id).lean();
    expect(v.detalhes_reserva.nome_hospede).toBeNull();
    expect(v.detalhes_reserva.notas_hospede).toBeNull();
    expect((await Tarefa.findById(nova._id).lean()).detalhes_reserva.nome_hospede).toBe('Beltrano');
    expect(await Ausencia.countDocuments({ utilizador_id: s._id, tipo: 'doenca' })).toBe(0); // 18 meses > 12
    expect(await Ausencia.countDocuments({ utilizador_id: s._id, tipo: 'ferias' })).toBe(1); // a de 2020 apagada, a de 18 meses fica
  });
});

describe('2k arquivista valida a entrada', () => {
  test('meses inválidos são recusados; tarefa inválida não impede o resto nem é apagada', async () => {
    expect(validarMeses(undefined)).toBe(3);
    expect(validarMeses('6')).toBe(6);
    for (const x of [0, -1, 1.5, 'abc', 1000, NaN, {}]) expect(() => validarMeses(x)).toThrow(RangeError);
    expect((await executarArquivista({ meses: -3 })).erro).toMatch(/meses inválido/);

    const { e } = await cenario();
    const p = await casa(e);
    const boa = await Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date('2019-01-10T10:00:00Z'), estado: 'concluida' });
    // documento corrompido (sem propriedade_id), inserido por fora do schema
    const ruim = await Tarefa.collection.insertOne({ empresa_id: e._id, data: new Date('2019-01-11T10:00:00Z'), estado: 'concluida', tipo: 'limpeza', tempo_limpeza_minutos: 45 });
    const r = await executarArquivista();
    expect(r.erro).toBeUndefined();
    expect(r.invalidas).toBeGreaterThanOrEqual(1);
    expect(await TarefaArquivo.countDocuments({ tarefa_original_id: boa._id })).toBe(1);
    expect(await Tarefa.countDocuments({ _id: boa._id })).toBe(0);
    expect(await Tarefa.collection.countDocuments({ _id: ruim.insertedId })).toBe(1);
    // repetir não duplica
    await executarArquivista();
    expect(await TarefaArquivo.countDocuments({ tarefa_original_id: boa._id })).toBe(1);
  });
});
