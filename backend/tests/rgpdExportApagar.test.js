/** RGPD (art. 28.º, n.º 3, al. e) e g)): exportar/apagar por pessoa e eliminação completa de uma empresa. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../utils/geocoding', () => ({ obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }) }));

const app = require('../server');
const { JWT_SECRET } = require('../middleware/auth');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Auditoria = require('../models/Auditoria');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const WebhookLog = require('../models/WebhookLog');
const ContactoHospede = require('../models/ContactoHospede');
const ModeloChecklist = require('../models/ModeloChecklist');
const { LockEmpresa, obterLock } = require('../utils/lockEmpresa');
const { executarEliminacaoEmpresas } = require('../jobs/eliminacaoEmpresas');
const rgpdEmpresa = require('../utils/rgpdEmpresa');
const { cenario, login, auth, SENHA, hash } = require('./helpersLote');

const DIA = 86400000;
let mongod;
let n = 0;

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); await Tarefa.init(); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const futuro = (d) => new Date(Date.now() + d * DIA);
const tokenDe = (u, empresaId) => jwt.sign({ id: String(u._id), role: u.role, empresa_id: String(empresaId || u.empresa_id) }, JWT_SECRET, { expiresIn: '1h' });

async function superAdmin() {
  const sis = await Empresa.create({ nome: 'Sistema' + ++n });
  const a = await Utilizador.create({ nome: 'SA', email: `sa${++n}@x.pt`, password_hash: hash, empresa_id: sis._id, role: 'admin', ativo: true });
  return { a, token: await login(app, a) };
}

/** Empresa cheia: dados em TODAS as coleções, para provar export e apagamento. */
async function empresaCheia() {
  const c = await cenario(app, { extra: 0, sn: 1 });
  await Utilizador.updateOne({ _id: c.bia._id }, { $set: { ativo: false } });
  await Empresa.updateOne({ _id: c.e._id }, { $set: { 'integracoes.smoobu.api_key': 'SEGREDO-SMOOBU-123' } });
  await Utilizador.updateOne({ _id: c.ana._id }, { $set: { telefone: '+351911111111', nif: '123456789', observacoes: 'nota interna', pushSubscription: { endpoint: 'https://push.example/xyz', keys: { p256dh: 'abc', auth: 'def' } } } });
  const t = await c.tarefa('2030-05-10', { utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id], detalhes_reserva: { nome_hospede: 'Hospede Secreto', notas_hospede: 'notas privadas do hospede' } });
  await Tarefa.updateOne({ _id: t._id }, { $set: { avarias: [{ descricao: 'Torneira avariada', fotos: ['data:image/png;base64,AAAA'], resolvido: false }] } });
  await TarefaArquivo.collection.insertOne({ empresa_id: c.e._id, propriedade_id: c.p._id, utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id], data: new Date('2020-01-01'), tempo_limpeza_minutos: 45, tipo: 'limpeza', estado: 'concluida', detalhes_reserva: { nome_hospede: 'Arquivo Hospede' } });
  await Ausencia.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, data_inicio: futuro(60), data_fim: futuro(62), tipo: 'ferias', estado: 'aprovada', justificacao: 'viagem' });
  await Notificacao.create({ utilizador_id: c.ana._id, empresa_id: c.e._id, mensagem: 'Foste escalado para a Casa X' });
  await Notificacao.collection.insertOne({ utilizador_id: c.ana._id, empresa_id: null, mensagem: 'antiga sem empresa', tipo: 'sistema', lida: false, data: new Date() });
  await Notificacao.create({ utilizador_id: c.g._id, empresa_id: c.e._id, mensagem: 'Ana faltou hoje' });
  await ContactoHospede.create({ tarefa_id: t._id, empresa_id: c.e._id, email: 'hospede@x.pt', telefone: '+351922222222', expira_em: futuro(30) });
  await WebhookLog.create({ payload: { action: 'newReservation', data: { id: 1, email: 'hospede@x.pt', departure: '2030-05-12' } }, empresa_id: c.e._id });
  await ModeloChecklist.create({ empresa_id: c.e._id, nome: 'Modelo', seccoes: [{ nome: 'Sala', items: ['Aspirar'] }] });
  await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: c.ana._id, empresa_id: c.e._id, check_in: futuro(5), check_out: futuro(7), nome_hospede: 'Manual Hospede', observacoes: 'obs da reserva' });
  await Auditoria.create({ utilizador_id: c.ana._id, utilizador_nome: 'Ana', empresa_id: c.e._id, acao: 'concluir', recurso: 'tarefa', descricao: 'Ana concluiu a limpeza da Casa X' });
  await Auditoria.create({ utilizador_id: c.g._id, utilizador_nome: 'gestor', empresa_id: c.e._id, acao: 'aprovar_ausencia', recurso: 'ausencia', recurso_id: 'x', descricao: 'Ausência de "Ana" aprovada', detalhes: { utilizador_id: String(c.ana._id) } });
  await Auditoria.collection.insertOne({ utilizador_id: c.ana._id, utilizador_nome: 'Ana', empresa_id: null, acao: 'login', recurso: 'sessao', descricao: 'sem empresa', createdAt: new Date(), updatedAt: new Date() });
  await LockEmpresa.create({ _id: `vagas:${c.e._id}`, expira_em: new Date(Date.now() - 1000), dono: 'x' });
  c.tarefaId = t._id;
  return c;
}

const contagens = async (id) => ({
  empresas: await Empresa.countDocuments({ _id: id }),
  utilizadores: await Utilizador.countDocuments({ empresa_id: id }),
  propriedades: await Propriedade.countDocuments({ empresa_id: id }),
  tarefas: await Tarefa.countDocuments({ empresa_id: id }),
  arquivo: await TarefaArquivo.countDocuments({ empresa_id: id }),
  ausencias: await Ausencia.countDocuments({ empresa_id: id }),
  notificacoes: await Notificacao.countDocuments({ empresa_id: id }),
  reservas: await ReservaManual.countDocuments({ empresa_id: id }),
  contactos: await ContactoHospede.countDocuments({ empresa_id: id }),
  webhooks: await WebhookLog.countDocuments({ empresa_id: id }),
  modelos: await ModeloChecklist.countDocuments({ empresa_id: id }),
  auditoria: await Auditoria.countDocuments({ empresa_id: id }),
  locks: await LockEmpresa.countDocuments({ _id: { $regex: `:${id}$` } }),
});

/* ------------------------------------------------------------------ */
describe('Exportar dados de uma pessoa', () => {
  test('o próprio descarrega os seus dados: completos, sem segredos nem terceiros', async () => {
    const c = await empresaCheia();
    const tk = await login(app, c.ana);
    const res = await request(app).get('/api/auth/me/exportar-dados').set(auth(tk));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const txt = res.text;
    const d = JSON.parse(txt);
    expect(d.conta).toMatchObject({ nome: 'Ana', telefone: '+351911111111', nif: '123456789', role: 'staff' });
    expect(d.tarefas).toHaveLength(1);
    expect(d.tarefas_arquivadas).toHaveLength(1);
    expect(d.avarias_reportadas).toEqual([expect.objectContaining({ descricao: 'Torneira avariada', n_fotos: 1 })]);
    expect(d.ausencias).toHaveLength(1);
    expect(d.notificacoes.length).toBe(2);
    expect(d.auditoria.registos_sobre_a_pessoa.length).toBeGreaterThanOrEqual(1);
    // segredos e terceiros
    for (const proibido of ['password_hash', 'pushSubscription', 'push.example', 'p256dh', 'Hospede Secreto', 'notas privadas', 'Arquivo Hospede', 'AAAA', 'gestor', c.g.email, c.bia.email, String(c.bia._id), 'hospede@x.pt', 'Manual Hospede']) {
      expect(txt).not.toContain(proibido);
    }
    // ficou registado quem pediu, sem copiar dados
    const aud = await Auditoria.findOne({ acao: 'rgpd_exportar', recurso_id: String(c.ana._id) }).lean();
    expect(aud).toBeTruthy();
    expect(JSON.stringify(aud)).not.toContain('123456789');
  });

  test('proprietário: reservas manuais sem nome do hóspede nem observações', async () => {
    const c = await empresaCheia();
    const par = await Utilizador.create({ nome: 'Dono', email: `dono${++n}@x.pt`, password_hash: hash, empresa_id: c.e._id, role: 'parceiro', ativo: true });
    await ReservaManual.create({ propriedade_id: c.p._id, parceiro_id: par._id, empresa_id: c.e._id, check_in: futuro(5), check_out: futuro(7), hospedes: 3, nome_hospede: 'Convidado Secreto', observacoes: 'obs privadas' });
    await Propriedade.updateOne({ _id: c.p._id }, { $set: { parceiro_id: par._id, contacto: '+351933333333' } });
    const res = await request(app).get('/api/auth/me/exportar-dados').set(auth(await login(app, par)));
    expect(res.status).toBe(200);
    expect(res.body.reservas_manuais).toHaveLength(1);
    expect(res.body.reservas_manuais[0]).toMatchObject({ hospedes: 3, propriedade: c.p.nome });
    expect(res.text).not.toContain('Convidado Secreto');
    expect(res.text).not.toContain('obs privadas');
    expect(res.body.propriedades_associadas[0].contacto).toBe('+351933333333');
  });

  test('gestor da empresa exporta; gestor de outra empresa recebe 404; staff 403; sem token 401', async () => {
    const c = await empresaCheia();
    const outra = await cenario(app);
    const ok = await request(app).get(`/api/gestor/equipa/${c.ana._id}/exportar-dados`).set(auth(c.token));
    expect(ok.status).toBe(200);
    expect(ok.body.conta.nome).toBe('Ana');
    expect((await request(app).get(`/api/gestor/equipa/${c.ana._id}/exportar-dados`).set(auth(outra.token))).status).toBe(404);
    expect((await request(app).get(`/api/gestor/equipa/${c.ana._id}/exportar-dados`).set(auth(await login(app, c.ana)))).status).toBe(403);
    expect((await request(app).get(`/api/gestor/equipa/${c.ana._id}/exportar-dados`)).status).toBe(401);
    expect((await request(app).get('/api/gestor/equipa/nao-e-id/exportar-dados').set(auth(c.token))).status).toBe(400);
    const aud = await Auditoria.findOne({ acao: 'rgpd_exportar', utilizador_id: c.g._id }).lean();
    expect(aud).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
describe('Apagar dados de uma pessoa', () => {
  test('recusas: staff 403, o próprio 403, sem confirmação 400, outra empresa 404, administrador 403', async () => {
    const c = await empresaCheia();
    const outra = await cenario(app);
    const url = `/api/gestor/equipa/${c.ana._id}/apagar-dados-pessoais`;
    expect((await request(app).post(url).set(auth(await login(app, c.ana))).send({ confirmar: 'APAGAR' })).status).toBe(403);
    expect((await request(app).post(`/api/gestor/equipa/${c.g._id}/apagar-dados-pessoais`).set(auth(c.token)).send({ confirmar: 'APAGAR' })).status).toBe(403);
    expect((await request(app).post(url).set(auth(c.token)).send({})).status).toBe(400);
    expect((await request(app).post(url).set(auth(c.token)).send({ confirmar: 'apagar' })).status).toBe(400);
    expect((await request(app).post(url).set(auth(outra.token)).send({ confirmar: 'APAGAR' })).status).toBe(404);
    const sa = await Utilizador.create({ nome: 'AdmEmpresa', email: `ae${++n}@x.pt`, password_hash: hash, empresa_id: c.e._id, role: 'admin', ativo: true });
    expect((await request(app).post(`/api/gestor/equipa/${sa._id}/apagar-dados-pessoais`).set(auth(c.token)).send({ confirmar: 'APAGAR' })).status).toBe(403);
    expect((await Utilizador.findById(c.ana._id).lean()).nome).toBe('Ana'); // nada mudou
    expect((await request(app).post(url).send({ confirmar: 'APAGAR' })).status).toBe(401);
  });

  test('anonimiza, apaga notificações e ausências, retira das tarefas futuras e mantém as passadas', async () => {
    const c = await empresaCheia();
    const outra = await empresaCheia();
    const passada = await c.tarefa('2020-02-02', { estado: 'concluida', utilizador_id: c.ana._id, equipa_atribuida: [c.ana._id] });
    const tkAna = await login(app, c.ana);
    const res = await request(app).post(`/api/gestor/equipa/${c.ana._id}/apagar-dados-pessoais`).set(auth(c.token)).send({ confirmar: 'APAGAR' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ja_apagada: false, tarefas_retiradas: 1 });

    const u = await Utilizador.findById(c.ana._id).lean();
    expect(u.nome).toBe('Pessoa removida');
    expect(u.email).toBe(`eliminado-${c.ana._id}@invalido`);
    expect(u).toMatchObject({ telefone: '', nif: '', observacoes: '', ativo: false, pushSubscription: null });
    expect(u.password_hash).toBeUndefined();
    expect(u.eliminado_em).toBeTruthy();
    expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id })).toBe(0);
    expect(await Ausencia.countDocuments({ utilizador_id: c.ana._id })).toBe(0);

    const futura = await Tarefa.findById(c.tarefaId).lean();
    expect(futura.utilizador_id).toBeNull();
    expect(['por_atribuir', 'nao_atribuida']).toContain(futura.estado);
    expect(futura.equipa_atribuida).toHaveLength(0);
    const p = await Tarefa.findById(passada._id).lean();
    expect(String(p.utilizador_id)).toBe(String(c.ana._id)); // mantém-se, mas aponta para a conta anonimizada
    expect(p.estado).toBe('concluida');

    // nome removido da auditoria e de textos livres; sem login possível
    expect(await Auditoria.countDocuments({ utilizador_id: c.ana._id, utilizador_nome: 'Ana' })).toBe(0);
    expect((await Auditoria.findOne({ acao: 'aprovar_ausencia', empresa_id: c.e._id }).lean()).descricao).not.toContain('Ana');
    expect((await Notificacao.findOne({ utilizador_id: c.g._id, empresa_id: c.e._id }).lean()).mensagem).not.toContain('Ana');
    expect((await request(app).post('/api/auth/login').send({ email: c.ana.email, password: SENHA })).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(tkAna))).status).toBe(401);

    // auditoria de quem pediu, sem copiar os dados
    const aud = await Auditoria.findOne({ acao: 'rgpd_apagar', recurso_id: String(c.ana._id) }).lean();
    expect(aud.utilizador_id.toString()).toBe(String(c.g._id));
    expect(JSON.stringify(aud)).not.toMatch(/Ana|123456789|911111111/);

    // outra empresa intacta
    expect((await Utilizador.findById(outra.ana._id).lean()).nome).toBe('Ana');
    expect(await Notificacao.countDocuments({ utilizador_id: outra.ana._id })).toBe(2);
    expect(await Ausencia.countDocuments({ utilizador_id: outra.ana._id })).toBe(1);
  });

  test('idempotente: repetir devolve 200 sem mexer em nada', async () => {
    const c = await empresaCheia();
    const url = `/api/gestor/equipa/${c.ana._id}/apagar-dados-pessoais`;
    expect((await request(app).post(url).set(auth(c.token)).send({ confirmar: 'APAGAR' })).status).toBe(200);
    const antes = await Utilizador.findById(c.ana._id).lean();
    const r2 = await request(app).post(url).set(auth(c.token)).send({ confirmar: 'APAGAR' });
    expect(r2.status).toBe(200);
    expect(r2.body.ja_apagada).toBe(true);
    expect(await Utilizador.findById(c.ana._id).lean()).toEqual(antes);
    expect(await Auditoria.countDocuments({ acao: 'rgpd_apagar', recurso_id: String(c.ana._id) })).toBe(1);
  });

  test('recusa apagar o único gestor; só o administrador mexe em gestores', async () => {
    const c = await empresaCheia();
    const sa = await superAdmin();
    const tkAdmin = tokenDe(sa.a, c.e._id); // override do Super Admin sobre esta empresa
    const url = `/api/gestor/equipa/${c.g._id}/apagar-dados-pessoais`;
    const r = await request(app).post(url).set(auth(tkAdmin)).send({ confirmar: 'APAGAR' });
    expect(r.status).toBe(409);
    expect((await Utilizador.findById(c.g._id).lean()).nome).toBe('gestor');
    // com um segundo gestor já pode
    await Utilizador.create({ nome: 'Gestor2', email: `g2${++n}@x.pt`, password_hash: hash, empresa_id: c.e._id, role: 'gestor', ativo: true });
    expect((await request(app).post(url).set(auth(tkAdmin)).send({ confirmar: 'APAGAR' })).status).toBe(200);
    expect((await Utilizador.findById(c.g._id).lean()).nome).toBe('Pessoa removida');
  });
});

/* ------------------------------------------------------------------ */
describe('Empresa: exportar, agendar, cancelar', () => {
  test('só o Super Admin: gestor 403, sem token 401', async () => {
    const c = await empresaCheia();
    for (const [m, u, b] of [['get', 'exportar'], ['post', 'agendar-eliminacao', { confirmar: c.e.nome }], ['post', 'cancelar-eliminacao', {}]]) {
      expect((await request(app)[m](`/api/admin/empresas/${c.e._id}/${u}`).set(auth(c.token)).send(b)).status).toBe(403);
      expect((await request(app)[m](`/api/admin/empresas/${c.e._id}/${u}`).send(b)).status).toBe(401);
    }
  });

  test('export completo: todas as coleções da empresa, sem segredos e sem outras empresas', async () => {
    const c = await empresaCheia();
    const outra = await empresaCheia();
    const sa = await superAdmin();
    const res = await request(app).get(`/api/admin/empresas/${c.e._id}/exportar`).set(auth(sa.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const d = JSON.parse(res.text);
    const col = d.colecoes;
    expect(d.empresa.nome).toBe(c.e.nome);
    expect(col.utilizadors.length).toBe(3);
    expect(col.tarefas.length).toBe(1);
    expect(col.tarefas_arquivo).toHaveLength(1);
    expect(col.propriedades).toHaveLength(1);
    expect(col.ausencias).toHaveLength(1);
    expect(col.notificacaos).toHaveLength(2);
    expect(col['notificacaos__sem_empresa_id']).toHaveLength(1);
    expect(col.reservamanuals).toHaveLength(1);
    expect(col.contactohospedes).toHaveLength(1);
    expect(col.webhooklogs).toHaveLength(1);
    expect(col.modelochecklists).toHaveLength(1);
    expect(col.auditorias.length).toBeGreaterThanOrEqual(2);
    expect(col['auditorias__sem_empresa_id']).toHaveLength(1);
    for (const proibido of ['password_hash', 'pushSubscription', 'p256dh', 'SEGREDO-SMOOBU-123']) expect(res.text).not.toContain(proibido);
    expect(res.text).not.toContain(String(outra.e._id));
    expect(res.text).toContain('Hospede Secreto'); // a devolução inclui os dados dos hóspedes da empresa
    expect((await request(app).get(`/api/admin/empresas/${new mongoose.Types.ObjectId()}/exportar`).set(auth(sa.token))).status).toBe(404);
  });

  test('agendar: nome exato, mínimo 7 dias, desativa, impede entrar e reativar; cancelar repõe', async () => {
    const c = await empresaCheia();
    const sa = await superAdmin();
    const url = `/api/admin/empresas/${c.e._id}/agendar-eliminacao`;
    expect((await request(app).post(url).set(auth(sa.token)).send({ confirmar: 'nome errado' })).status).toBe(400);
    expect((await request(app).post(url).set(auth(sa.token)).send({})).status).toBe(400);
    expect((await request(app).post(url).set(auth(sa.token)).send({ confirmar: c.e.nome, dias: 3 })).status).toBe(400);
    expect((await request(app).post(url).set(auth(sa.token)).send({ confirmar: c.e.nome, dias: 'x' })).status).toBe(400);
    expect((await Empresa.findById(c.e._id).lean()).eliminacao_agendada_para).toBeNull();

    const r = await request(app).post(url).set(auth(sa.token)).send({ confirmar: c.e.nome });
    expect(r.status).toBe(200);
    const e = await Empresa.findById(c.e._id).lean();
    expect(e.ativa).toBe(false);
    expect(Math.abs(e.eliminacao_agendada_para.getTime() - (Date.now() + 30 * DIA))).toBeLessThan(60000);
    // utilizadores não entram: login novo e sessão antiga
    expect((await request(app).post('/api/auth/login').send({ email: c.g.email, password: SENHA })).status).toBe(403);
    expect((await request(app).get('/api/gestor/dashboard').set(auth(c.token))).status).toBe(401);
    // reagendar e reativar à mão estão bloqueados
    expect((await request(app).post(url).set(auth(sa.token)).send({ confirmar: c.e.nome })).status).toBe(409);
    expect((await request(app).patch(`/api/admin/empresas/${c.e._id}/toggle-status`).set(auth(sa.token)).send({ ativa: true })).status).toBe(409);

    const cancel = await request(app).post(`/api/admin/empresas/${c.e._id}/cancelar-eliminacao`).set(auth(sa.token)).send({});
    expect(cancel.status).toBe(200);
    const e2 = await Empresa.findById(c.e._id).lean();
    expect(e2.eliminacao_agendada_para).toBeNull();
    expect(e2.ativa).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email: c.g.email, password: SENHA })).status).toBe(200);
    expect((await request(app).post(`/api/admin/empresas/${c.e._id}/cancelar-eliminacao`).set(auth(sa.token)).send({})).status).toBe(409);
    expect(await Auditoria.countDocuments({ empresa_id: c.e._id, acao: { $in: ['agendar_eliminacao', 'cancelar_eliminacao'] } })).toBe(2);
  });

  test('prazo configurável (>= 7) e cancelar repõe uma empresa que já estava desativada', async () => {
    const c = await empresaCheia();
    const sa = await superAdmin();
    await Empresa.updateOne({ _id: c.e._id }, { $set: { ativa: false } });
    const r = await request(app).post(`/api/admin/empresas/${c.e._id}/agendar-eliminacao`).set(auth(sa.token)).send({ confirmar: c.e.nome, dias: 7 });
    expect(r.status).toBe(200);
    const e = await Empresa.findById(c.e._id).lean();
    expect(Math.abs(e.eliminacao_agendada_para.getTime() - (Date.now() + 7 * DIA))).toBeLessThan(60000);
    await request(app).post(`/api/admin/empresas/${c.e._id}/cancelar-eliminacao`).set(auth(sa.token)).send({});
    expect((await Empresa.findById(c.e._id).lean()).ativa).toBe(false);
  });

  test('empresa-sistema (com Super Admin) não pode ser eliminada', async () => {
    const sa = await superAdmin();
    const sis = await Empresa.findById(sa.a.empresa_id).lean();
    const r = await request(app).post(`/api/admin/empresas/${sis._id}/agendar-eliminacao`).set(auth(sa.token)).send({ confirmar: sis.nome });
    expect(r.status).toBe(409);
    expect((await Empresa.findById(sis._id).lean()).eliminacao_agendada_para).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
describe('Job de eliminação definitiva', () => {
  test('só apaga depois da data; apaga tudo da empresa e nada das outras; idempotente', async () => {
    const c = await empresaCheia();
    const outra = await empresaCheia();
    const sa = await superAdmin();
    const antesOutra = await contagens(outra.e._id);
    expect(Object.values(await contagens(c.e._id)).every((v) => v > 0)).toBe(true); // todas as coleções têm dados

    await request(app).post(`/api/admin/empresas/${c.e._id}/agendar-eliminacao`).set(auth(sa.token)).send({ confirmar: c.e.nome, dias: 10 });
    // antes da data: nada acontece
    let r = await executarEliminacaoEmpresas(new Date(Date.now() + 9 * DIA));
    expect(r.apagadas).toBe(0);
    expect((await contagens(c.e._id)).tarefas).toBe(1);
    // empresas sem agendamento nunca são tocadas, mesmo muito depois
    r = await executarEliminacaoEmpresas(new Date(Date.now() + 11 * DIA));
    expect(r).toMatchObject({ apagadas: 1, falhas: 0 });

    const depois = await contagens(c.e._id);
    expect(Object.values(depois).every((v) => v === 0)).toBe(true);
    expect(await Notificacao.countDocuments({ utilizador_id: c.ana._id })).toBe(0);
    expect(await Auditoria.countDocuments({ utilizador_id: { $in: [c.ana._id, c.g._id] } })).toBe(0);
    expect(await contagens(outra.e._id)).toEqual(antesOutra);
    expect(await Notificacao.countDocuments({ utilizador_id: outra.ana._id })).toBe(2);

    // registo mínimo na auditoria da plataforma, sem dados pessoais
    const reg = await Auditoria.findOne({ acao: 'empresa_apagada', recurso_id: String(c.e._id) }).lean();
    expect(reg).toBeTruthy();
    expect(reg.empresa_id).toBeNull();
    expect(reg.descricao).toBe(`Empresa "${c.e.nome}" apagada em ${new Date(Date.now() + 11 * DIA).toISOString().slice(0, 10)}.`);
    expect(JSON.stringify(reg)).not.toMatch(/Ana|911111111|hospede/i);

    // idempotência: voltar a correr não faz nada nem falha
    r = await executarEliminacaoEmpresas(new Date(Date.now() + 40 * DIA));
    expect(r).toMatchObject({ apagadas: 0, falhas: 0 });
    expect(await Auditoria.countDocuments({ acao: 'empresa_apagada', recurso_id: String(c.e._id) })).toBe(1);
    expect(await contagens(outra.e._id)).toEqual(antesOutra);
  });

  test('cancelada antes da data: o job não apaga', async () => {
    const c = await empresaCheia();
    const sa = await superAdmin();
    await request(app).post(`/api/admin/empresas/${c.e._id}/agendar-eliminacao`).set(auth(sa.token)).send({ confirmar: c.e.nome });
    await request(app).post(`/api/admin/empresas/${c.e._id}/cancelar-eliminacao`).set(auth(sa.token)).send({});
    const r = await executarEliminacaoEmpresas(new Date(Date.now() + 90 * DIA));
    expect(r.apagadas).toBe(0);
    expect((await contagens(c.e._id)).tarefas).toBe(1);
  });

  test('lock em curso: adia sem apagar nada; sem Super Admins na empresa-sistema nunca apaga', async () => {
    const c = await empresaCheia();
    const sa = await superAdmin();
    await request(app).post(`/api/admin/empresas/${c.e._id}/agendar-eliminacao`).set(auth(sa.token)).send({ confirmar: c.e.nome, dias: 7 });
    const dono = await obterLock(`eliminar-empresa:${c.e._id}`, { ttlMs: 60000, esperaMs: 0 });
    expect(dono).toBeTruthy();
    const r = await executarEliminacaoEmpresas(new Date(Date.now() + 8 * DIA));
    expect(r).toMatchObject({ apagadas: 0, adiadas: 1 });
    expect((await contagens(c.e._id)).tarefas).toBe(1);
    await LockEmpresa.deleteOne({ _id: `eliminar-empresa:${c.e._id}` });

    // Super Admin dentro da empresa (agendada à força): recusa e avisa
    await Utilizador.create({ nome: 'Intruso', email: `i${++n}@x.pt`, password_hash: hash, empresa_id: c.e._id, role: 'admin', ativo: true });
    const r2 = await executarEliminacaoEmpresas(new Date(Date.now() + 8 * DIA));
    expect(r2).toMatchObject({ apagadas: 0, falhas: 1 });
    expect((await contagens(c.e._id)).tarefas).toBe(1);
  });
});

describe('Cobertura de coleções', () => {
  test('todo o modelo com empresa_id ou utilizador_id está coberto pelo export e pelo apagamento', () => {
    const cobertas = rgpdEmpresa.coleccoesCobertas();
    const semCobertura = [];
    for (const M of Object.values(mongoose.models)) {
      if (M.modelName === 'Empresa' || M.modelName === 'LockEmpresa') continue;
      const liga = M.schema.path('empresa_id') || M.schema.path('utilizador_id');
      if (!liga || !cobertas.includes(M.collection.name)) semCobertura.push(M.modelName);
    }
    expect(semCobertura).toEqual([]);
    expect(cobertas).toEqual(expect.arrayContaining(['tarefas', 'tarefas_arquivo', 'webhooklogs', 'contactohospedes', 'auditorias', 'notificacaos', 'reservamanuals', 'ausencias', 'utilizadors', 'propriedades', 'modelochecklists']));
  });
});
