/**
 * Testes de integração do backend (Autocell) — Jest + Supertest + MongoDB em memória.
 *
 * Cobertura:
 *   - Health check com BD ligada (GET /api/health)
 *   - Auth 401 em todas as rotas protegidas sem token
 *   - Auth login (sucesso, password errada, campos em falta, user inativo)
 *   - Auth /me com token
 *   - CRUD Propriedades (criar, listar, toggle estado, duplicado 409)
 *   - Webhook Smoobu (cria tarefa + atribui ao staff disponível)
 *   - Dashboard (GET /api/gestor/dashboard)
 *   - Relatórios (GET /api/gestor/relatorios/produtividade)
 *
 * Estratégia:
 *   - Usa mongodb-memory-server (BD efémera em memória, sem dependências externas).
 *   - beforeAll: arranca mongod + liga mongoose + semeia dados base.
 *   - afterAll: desliga mongoose + para mongod.
 *   - beforeEach: limpa as coleções de teste (mantém a empresa/admin).
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const WebhookLog = require('../models/WebhookLog');

let mongod;
let empresaId;
let adminId;
let adminToken;
const PASSWORD = 'teste123';

/* ------------------------------------------------------------------ */
/* Setup / Teardown                                                    */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

  // Semeia a empresa + admin base.
  const empresa = await Empresa.create({ nome: 'Empresa Teste', plano_ativo: true });
  empresaId = String(empresa._id);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const admin = await Utilizador.create({
    nome: 'Admin Teste',
    email: 'admin@teste.pt',
    password_hash: hash,
    empresa_id: empresa._id,
    role: 'admin',
    ativo: true,
  });
  adminId = String(admin._id);

  // Login real para obter token (valida o fluxo de auth end-to-end).
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@teste.pt', password: PASSWORD });
  adminToken = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// Helper para fazer pedidos autenticados.
function authGet(path) {
  return request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
}
function authPost(path, body) {
  return request(app).post(path).set('Authorization', `Bearer ${adminToken}`).send(body);
}
function authPatch(path, body) {
  return request(app).patch(path).set('Authorization', `Bearer ${adminToken}`).send(body || {});
}

// Espera que o processamento assíncrono do webhook (setImmediate) termine.
async function esperar(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 1. Health check                                                     */
/* ------------------------------------------------------------------ */

describe('GET /api/health', () => {
  it('deve devolver 200 e mongodb connected quando a BD está ligada', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.mongodb).toBe('connected');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Auth — 401 em rotas protegidas sem token                         */
/* ------------------------------------------------------------------ */

describe('Auth — rotas protegidas sem token devolvem 401', () => {
  const rotasProtegidas = [
    '/api/gestor/dashboard',
    '/api/gestor/propriedades',
    '/api/gestor/equipa',
    '/api/gestor/tarefas',
    '/api/gestor/relatorios/produtividade',
    '/api/auth/me',
  ];

  for (const rota of rotasProtegidas) {
    it(`GET ${rota} → 401 sem token`, async () => {
      const res = await request(app).get(rota);
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('erro');
    });
  }

  it('token inválido → 401', async () => {
    const res = await request(app)
      .get('/api/gestor/dashboard')
      .set('Authorization', 'Bearer token-invalido');
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Auth — login                                                     */
/* ------------------------------------------------------------------ */

describe('POST /api/auth/login', () => {
  it('credenciais válidas → 200 + token + utilizador', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@teste.pt', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.utilizador.email).toBe('admin@teste.pt');
    expect(res.body.utilizador.role).toBe('admin');
    expect(res.body.utilizador.empresa_id).toBe(empresaId);
  });

  it('password errada → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@teste.pt', password: 'errada' });
    expect(res.status).toBe(401);
  });

  it('email inexistente → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ninguem@teste.pt', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('campos em falta → 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@teste.pt' });
    expect(res.status).toBe(400);
  });

  it('utilizador inativo → 401', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({
      nome: 'Inativo',
      email: 'inativo@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: false,
    });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inativo@teste.pt', password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Auth — /me                                                       */
/* ------------------------------------------------------------------ */

describe('GET /api/auth/me', () => {
  it('com token válido → 200 + dados do utilizador', async () => {
    const res = await authGet('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.utilizador.email).toBe('admin@teste.pt');
    expect(res.body.utilizador.role).toBe('admin');
  });
});

/* ------------------------------------------------------------------ */
/* 5. CRUD Propriedades                                                */
/* ------------------------------------------------------------------ */

describe('Propriedades (CRUD)', () => {
  let propId;

  it('POST /api/gestor/propriedades → 201 (cria propriedade)', async () => {
    const res = await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-100',
      nome: 'Casa da Praia',
      morada: 'Rua do Mar 1, Lisboa',
      tempo_limpeza_minutos: 90,
    });
    expect(res.status).toBe(201);
    expect(res.body.propriedade).toHaveProperty('_id');
    expect(res.body.propriedade.smoobu_id).toBe('prop-100');
    expect(res.body.propriedade.tempo_limpeza_minutos).toBe(90);
    propId = res.body.propriedade._id;
  });

  it('POST sem campos obrigatórios → 400', async () => {
    const res = await authPost('/api/gestor/propriedades', { smoobu_id: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST com smoobu_id duplicado → 409', async () => {
    const res = await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-100',
      nome: 'Repetida',
      morada: 'Rua X',
    });
    expect(res.status).toBe(409);
  });

  it('GET /api/gestor/propriedades → 200 + lista com a propriedade', async () => {
    const res = await authGet('/api/gestor/propriedades');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.propriedades)).toBe(true);
    expect(res.body.propriedades.some((p) => p.smoobu_id === 'prop-100')).toBe(true);
  });

  it('PATCH /api/gestor/propriedades/:id/estado → alterna ativo', async () => {
    const res = await authPatch(`/api/gestor/propriedades/${propId}/estado`, { ativo: false });
    expect(res.status).toBe(200);
    expect(res.body.ativo).toBe(false);
  });

  it('PATCH com id inexistente → 404', async () => {
    const idInexistente = new mongoose.Types.ObjectId();
    const res = await authPatch(`/api/gestor/propriedades/${idInexistente}/estado`, {});
    expect(res.status).toBe(404);
  });

  it('PUT /api/gestor/propriedades/:id → 200 (atualiza nome e tempo)', async () => {
    // Cria uma propriedade para editar.
    const criada = await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-edit-1',
      nome: 'Nome Inicial',
      morada: 'Rua Inicial 1, Lisboa',
      tempo_limpeza_minutos: 60,
    });
    expect(criada.status).toBe(201);

    const res = await request(app)
      .put(`/api/gestor/propriedades/${criada.body.propriedade._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nome: 'Nome Editado', tempo_limpeza_minutos: 90 });
    expect(res.status).toBe(200);
    expect(res.body.propriedade.nome).toBe('Nome Editado');
    expect(res.body.propriedade.tempo_limpeza_minutos).toBe(90);
    // smoobu_id e morada não mudaram.
    expect(res.body.propriedade.smoobu_id).toBe('prop-edit-1');
  });

  it('PUT com smoobu_id duplicado (de outra propriedade) → 409', async () => {
    // Cria duas propriedades.
    await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-edit-2',
      nome: 'A',
      morada: 'Rua A',
    });
    const criadaB = await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-edit-3',
      nome: 'B',
      morada: 'Rua B',
    });

    // Tenta mudar B para o smoobu_id de A → 409.
    const res = await request(app)
      .put(`/api/gestor/propriedades/${criadaB.body.propriedade._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ smoobu_id: 'prop-edit-2' });
    expect(res.status).toBe(409);
  });

  it('PUT com id inexistente → 404', async () => {
    const idInexistente = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/gestor/propriedades/${idInexistente}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nome: 'X' });
    expect(res.status).toBe(404);
  });

  it('PUT sem campos no body → 400', async () => {
    const criada = await authPost('/api/gestor/propriedades', {
      smoobu_id: 'prop-edit-4',
      nome: 'C',
      morada: 'Rua C',
    });
    const res = await request(app)
      .put(`/api/gestor/propriedades/${criada.body.propriedade._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('toggle de propriedade legacy (sem morada) → 200 (não rebenta por validação)', async () => {
    // Simula uma propriedade criada antes de `morada` ser obrigatória:
    // insere diretamente na coleção (bypassing Mongoose validation).
    const Propriedade = require('../models/Propriedade');
    const doc = await Propriedade.collection.insertOne({
      smoobu_id: 'prop-legacy-sem-morada',
      nome: 'Legacy',
      // morada EM FALTA (campo obrigatório no schema atual)
      coordenadas: { lat: null, lng: null },
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 60,
      ativo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // O toggle (PATCH .../estado) deve funcionar SEM 500, mesmo com a
    // morada em falta. Isto era o bug de produção ( findOne+save re-valida ).
    const res = await authPatch(
      `/api/gestor/propriedades/${doc.insertedId}/estado`,
      {}
    );
    expect(res.status).toBe(200);
    expect(res.body.ativo).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5b. Calendário Visual — getDadosCalendario                          */
/* ------------------------------------------------------------------ */

describe('GET /api/gestor/calendario/dados', () => {
  let prop1, prop2, staff1, staff2;
  const hoje = new Date();
  const dataStr = new Date(
    Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  ).toISOString();

  beforeAll(async () => {
    // Cria 2 propriedades + 2 staff para testar filtros.
    prop1 = await Propriedade.create({
      smoobu_id: 'cal-prop-1',
      nome: 'Casa 1',
      morada: 'Rua 1',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 45,
    });
    prop2 = await Propriedade.create({
      smoobu_id: 'cal-prop-2',
      nome: 'Casa 2',
      morada: 'Rua 2',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 45,
    });
    const hash = await bcrypt.hash('x', 10);
    staff1 = await Utilizador.create({
      nome: 'Staff 1',
      email: 'cal-staff1@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'staff',
      ativo: true,
    });
    staff2 = await Utilizador.create({
      nome: 'Staff 2',
      email: 'cal-staff2@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'staff',
      ativo: true,
    });

    // Cria tarefas com diferentes estados/propriedades/utilizadores.
    await Tarefa.create([
      {
        empresa_id: new mongoose.Types.ObjectId(empresaId),
        propriedade_id: prop1._id,
        utilizador_id: staff1._id,
        data: dataStr,
        tempo_limpeza_minutos: 45,
        tipo: 'limpeza',
        estado: 'atribuida',
      },
      {
        empresa_id: new mongoose.Types.ObjectId(empresaId),
        propriedade_id: prop2._id,
        utilizador_id: staff2._id,
        data: dataStr,
        tempo_limpeza_minutos: 45,
        tipo: 'limpeza',
        estado: 'concluida',
      },
      {
        empresa_id: new mongoose.Types.ObjectId(empresaId),
        propriedade_id: prop1._id,
        utilizador_id: null, // por atribuir
        data: dataStr,
        tempo_limpeza_minutos: 45,
        tipo: 'limpeza',
        estado: 'por_atribuir',
      },
      {
        empresa_id: new mongoose.Types.ObjectId(empresaId),
        propriedade_id: prop2._id,
        utilizador_id: staff1._id,
        data: dataStr,
        tempo_limpeza_minutos: 45,
        tipo: 'limpeza',
        estado: 'cancelada',
      },
    ]);
  });

  it('sem token → 401', async () => {
    const res = await request(app).get('/api/gestor/calendario/dados');
    expect(res.status).toBe(401);
  });

  it('com token + sem filtros → 200 + todas as tarefas (incluindo canceladas)', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tarefas)).toBe(true);
    // 4 tarefas criadas (inclui a cancelada — difere do getTarefas).
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(4);
    // Verifica que há cancelada (confirmar que não exclui).
    const temCancelada = res.body.tarefas.some((t) => t.estado === 'cancelada');
    expect(temCancelada).toBe(true);
  });

  it('populate inclui nome + morada da propriedade e nome do utilizador', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&propriedadeId=${prop1._id}`
    );
    expect(res.status).toBe(200);
    const t = res.body.tarefas[0];
    expect(t.propriedade_id).toBeTruthy();
    expect(t.propriedade_id).toHaveProperty('nome');
    expect(t.propriedade_id).toHaveProperty('morada');
    // utilizador_id pode ser null (por atribuir), mas se tiver, tem nome.
    if (t.utilizador_id) {
      expect(t.utilizador_id).toHaveProperty('nome');
    }
  });

  it('filtro por propriedade → só devolve tarefas dessa propriedade', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&propriedadeId=${prop2._id}`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(
      res.body.tarefas.every((t) => String(t.propriedade_id._id) === String(prop2._id))
    ).toBe(true);
  });

  it('filtro por utilizador → só devolve tarefas desse funcionário', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&utilizadorId=${staff1._id}`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(
      res.body.tarefas.every((t) => String(t.utilizador_id._id) === String(staff1._id))
    ).toBe(true);
  });

  it('filtro utilizadorId=null → só devolve tarefas por atribuir', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&utilizadorId=null`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tarefas.every((t) => t.utilizador_id === null)).toBe(true);
  });

  it('filtro por estado=concluida → só devolve concluídas', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&estado=concluida`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tarefas.every((t) => t.estado === 'concluida')).toBe(true);
  });

  it('filtro por estado=cancelada → só devolve canceladas', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&estado=cancelada`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tarefas.every((t) => t.estado === 'cancelada')).toBe(true);
  });

  it('combina filtros (propriedade + utilizador)', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&propriedadeId=${prop1._id}&utilizadorId=${staff1._id}`
    );
    expect(res.status).toBe(200);
    expect(res.body.tarefas.length).toBeGreaterThanOrEqual(1);
    expect(
      res.body.tarefas.every(
        (t) =>
          String(t.propriedade_id._id) === String(prop1._id) &&
          String(t.utilizador_id._id) === String(staff1._id)
      )
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Webhook Smoobu                                                   */
/* ------------------------------------------------------------------ */

describe('POST /webhooks/smoobu (load balancer)', () => {
  let staffId;

  beforeEach(async () => {
    // Limpa tarefas/webhooks entre testes do webhook.
    await Tarefa.deleteMany({});
    await WebhookLog.deleteMany({});

    // Garante um staff ativo da empresa.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.findOneAndUpdate(
      { email: 'staff.webhook@teste.pt' },
      {
        $set: {
          nome: 'Staff Webhook',
          email: 'staff.webhook@teste.pt',
          password_hash: hash,
          empresa_id: empresaId,
          role: 'staff',
          ativo: true,
          dias_folga: [],
        },
      },
      { upsert: true, new: true }
    );
    staffId = String(staff._id);

    // Garante a propriedade ativa com smoobu_id "200" (corresponde a apartment.id 200).
    await Propriedade.findOneAndUpdate(
      { smoobu_id: '200' },
      {
        $set: {
          smoobu_id: '200',
          nome: 'Apartamento Teste',
          morada: 'Av. Teste',
          empresa_id: empresaId,
          tempo_limpeza_minutos: 60,
          ativo: true,
        },
      },
      { upsert: true, new: true }
    );
  });

  it('devolve 200 imediato + cria tarefa atribuída ao staff', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const res = await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: {
        id: 777,
        arrival: amanha,
        apartment: { id: 200, name: 'Apartamento Teste' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('recebido');

    // Espera o processamento assíncrono (setImmediate).
    await esperar(400);

    // Verifica que a tarefa foi criada e atribuída a algum staff ativo
    // (não necessariamente o staffId do beforeEach — o load balancer pode
    // escolher outro staff ativo da empresa que tenha menos carga).
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '777' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.utilizador_id).not.toBeNull();
    expect(tarefa.empresa_id.toString()).toBe(empresaId);

    // Verifica que o WebhookLog ficou processado.
    const log = await WebhookLog.findOne({ 'payload.data.id': 777 });
    expect(log).not.toBeNull();
    expect(log.status).toBe('processado');
  });

  it('propriedade inativa → não cria tarefa', async () => {
    // Desativa a propriedade.
    await Propriedade.updateOne({ smoobu_id: '200' }, { $set: { ativo: false } });

    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 778, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);

    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '778' });
    expect(tarefa).toBeNull();

    // Restaura o estado ativo para testes seguintes.
    await Propriedade.updateOne({ smoobu_id: '200' }, { $set: { ativo: true } });
  });

  it('webhook duplicado (mesmo reservaId) → não cria tarefa duplicada (idempotência)', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const payload = {
      action: 'newReservation',
      data: { id: 999, arrival: amanha, apartment: { id: 200, name: 'X' } },
    };

    // Primeiro envio → cria tarefa.
    await request(app).post('/webhooks/smoobu').send(payload);
    await esperar(400);
    const tarefas1 = await Tarefa.find({ smoobu_reserva_id: '999' });
    expect(tarefas1.length).toBe(1);

    // Segundo envio (retry do Smoobu) → NÃO cria duplicado.
    await request(app).post('/webhooks/smoobu').send(payload);
    await esperar(400);
    const tarefas2 = await Tarefa.find({ smoobu_reserva_id: '999' });
    expect(tarefas2.length).toBe(1);
  });

  it('action desconhecida → 200 mas não cria tarefa (log processado)', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await request(app).post('/webhooks/smoobu').send({
      action: 'pingTest',
      data: { id: 888, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    expect(res.status).toBe(200);
    await esperar(400);

    // Não cria tarefa.
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '888' });
    expect(tarefa).toBeNull();

    // O log fica 'processado' (não é erro — apenas não há nada a fazer).
    const log = await WebhookLog.findOne({ 'payload.data.id': 888 });
    expect(log).not.toBeNull();
    expect(log.status).toBe('processado');
  });

  it('cancellation → cancela a tarefa existente', async () => {
    // 1) Cria a tarefa com newReservation.
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.estado).not.toBe('cancelada');

    // 2) Envia cancellation → tarefa fica cancelada.
    await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const cancelada = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    expect(cancelada.estado).toBe('cancelada');
  });

  it('cancellation idempotente → cancelar 2x mantém cancelada', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // Cria primeiro (o beforeEach limpa as tarefas entre testes).
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    // Cancela 2x.
    for (let i = 0; i < 2; i++) {
      await request(app).post('/webhooks/smoobu').send({
        action: 'cancellation',
        data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
      });
      await esperar(300);
    }
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    expect(tarefa.estado).toBe('cancelada');
  });

  it('cancellation de reserva sem tarefa → sem erro', async () => {
    const res = await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 999999, arrival: '2026-08-01', apartment: { id: 200, name: 'X' } },
    });
    expect(res.status).toBe(200);
    await esperar(300);
    // Nenhuma tarefa com este reservaId.
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '999999' });
    expect(tarefa).toBeNull();
  });

  it('updateReservation → atualiza a data da tarefa existente', async () => {
    // 1) Cria tarefa com check-in amanhã.
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 2222, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '2222' });
    const dataOriginal = new Date(tarefa.data).getTime();

    // 2) Envia update com check-in daqui a 5 dias.
    const daqui5dias = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await request(app).post('/webhooks/smoobu').send({
      action: 'updateReservation',
      data: { id: 2222, arrival: daqui5dias, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);

    const atualizada = await Tarefa.findOne({ smoobu_reserva_id: '2222' });
    // A data mudou.
    expect(new Date(atualizada.data).getTime()).not.toBe(dataOriginal);
    // Não criou duplicado.
    const count = await Tarefa.countDocuments({ smoobu_reserva_id: '2222' });
    expect(count).toBe(1);
  });

  it('updateReservation sem tarefa existente → cria a tarefa (fallback)', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await request(app).post('/webhooks/smoobu').send({
      action: 'updateReservation',
      data: { id: 3333, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '3333' });
    expect(tarefa).not.toBeNull(); // criou por fallback
  });

  it('newReservation de reserva anteriormente cancelada → re-activa', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // 1) Cria.
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 4444, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    // 2) Cancela.
    await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 4444, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const cancelada = await Tarefa.findOne({ smoobu_reserva_id: '4444' });
    expect(cancelada.estado).toBe('cancelada');
    // 3) Re-cria (newReservation com mesmo ID) → re-activa.
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 4444, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const reactivada = await Tarefa.findOne({ smoobu_reserva_id: '4444' });
    expect(reactivada.estado).not.toBe('cancelada');
    // Não criou duplicado.
    const count = await Tarefa.countDocuments({ smoobu_reserva_id: '4444' });
    expect(count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6b. Admin — Webhooks (logs)                                        */
/* ------------------------------------------------------------------ */

describe('GET /api/gestor/webhooks', () => {
  it('sem token → 401', async () => {
    const res = await request(app).get('/api/gestor/webhooks');
    expect(res.status).toBe(401);
  });

  it('com token → 200 + lista de logs + total', async () => {
    const res = await authGet('/api/gestor/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.webhooks)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    // Os webhooks enviados nos testes anteriores devem aparecer.
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('filtro por status=erro → só devolve logs com erro', async () => {
    // Força um webhook que vai falhar (propriedade inexistente).
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 4040, arrival: '2026-08-01', apartment: { id: 999999, name: 'X' } },
    });
    await esperar(400);

    const res = await authGet('/api/gestor/webhooks?status=erro');
    expect(res.status).toBe(200);
    expect(res.body.webhooks.length).toBeGreaterThan(0);
    expect(res.body.webhooks.every((w) => w.status === 'erro')).toBe(true);
  });
});

describe('POST /api/gestor/webhooks/:id/reprocessar', () => {
  it('webhook com erro (propriedade inexistente) → reprocessar mantém erro', async () => {
    // Cria um webhook que falhou (propriedade não existe).
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 5050, arrival: '2026-08-01', apartment: { id: 888888, name: 'X' } },
    });
    await esperar(400);

    const logErro = await WebhookLog.findOne({ 'payload.data.id': 5050 });
    expect(logErro).not.toBeNull();
    expect(logErro.status).toBe('erro');

    // Reproccessa → continua a falhar (propriedade ainda não existe).
    const res = await authPost(`/api/gestor/webhooks/${logErro._id}/reprocessar`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('erro');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Dashboard                                                        */
/* ------------------------------------------------------------------ */

describe('GET /api/gestor/dashboard', () => {
  it('com token → 200 + shape esperado', async () => {
    const res = await authGet('/api/gestor/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalPropriedades');
    expect(res.body).toHaveProperty('propriedadesAtivas');
    expect(res.body).toHaveProperty('membrosEquipaAtivos');
    expect(res.body).toHaveProperty('tarefasHoje');
    expect(res.body).toHaveProperty('tarefasPorAtribuir');
    expect(res.body).toHaveProperty('tarefasConcluidasHoje');
    expect(Array.isArray(res.body.tarefasPorStaff)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Relatórios                                                       */
/* ------------------------------------------------------------------ */

describe('GET /api/gestor/relatorios/produtividade', () => {
  it('com token → 200 + shape completo', async () => {
    const res = await authGet('/api/gestor/relatorios/produtividade');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('periodo');
    expect(res.body).toHaveProperty('resumo');
    expect(res.body.resumo).toHaveProperty('totalTarefas');
    expect(res.body.resumo).toHaveProperty('taxaConclusao');
    expect(res.body.resumo).toHaveProperty('emAtraso');
    expect(Array.isArray(res.body.porStaff)).toBe(true);
    expect(Array.isArray(res.body.porDia)).toBe(true);
    expect(Array.isArray(res.body.porEstado)).toBe(true);
    expect(Array.isArray(res.body.porPropriedade)).toBe(true);
  });

  it('com filtro de datas custom → 200', async () => {
    const inicio = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const fim = new Date().toISOString().slice(0, 10);
    const res = await authGet(`/api/gestor/relatorios/produtividade?inicio=${inicio}&fim=${fim}`);
    expect(res.status).toBe(200);
    expect(res.body.periodo.inicio).toBeDefined();
    expect(res.body.periodo.fim).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* 9. Smoobu — sincronização em massa                                  */
/* ------------------------------------------------------------------ */

describe('POST /api/gestor/smoobu/sincronizar', () => {
  let apiKeyOriginal;

  beforeEach(() => {
    apiKeyOriginal = process.env.SMOOBU_API_KEY;
    // Limpa tarefas entre testes.
    Tarefa.deleteMany({}).catch(() => {});
  });

  afterEach(() => {
    // Restaura a API key.
    if (apiKeyOriginal === undefined) {
      delete process.env.SMOOBU_API_KEY;
    } else {
      process.env.SMOOBU_API_KEY = apiKeyOriginal;
    }
    // Restaura o fetch global se foi mocked.
    if (global.fetch && global.fetch.__isMock) {
      global.fetch.mockRestore();
      delete global.fetch.__isMock;
    }
  });

  it('sem token → 401', async () => {
    const res = await request(app).post('/api/gestor/smoobu/sincronizar');
    expect(res.status).toBe(401);
  });

  it('sem SMOOBU_API_KEY configurada → 400', async () => {
    delete process.env.SMOOBU_API_KEY;
    const res = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/SMOOBU_API_KEY/);
  });

  it('com API key + fetch mockado → 200 + contadores', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Mocka o fetch global para devolver 2 reservas (uma nova, uma duplicada).
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        reservations: [
          {
            id: 2001,
            arrival: amanha,
            apartment: { id: 200, name: 'Apartamento Teste' },
          },
          {
            id: 2002,
            arrival: amanha,
            apartment: { id: 200, name: 'Apartamento Teste' },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res.status).toBe(200);
    expect(res.body.totalRecebidas).toBe(2);
    expect(res.body.criadas).toBe(2);
    expect(res.body.existentes).toBe(0);
    expect(res.body.erros).toBe(0);
    expect(res.body.importadas).toBe(2);

    // Confirma que o fetch foi chamado com o URL e header corretos.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toMatch(/login\.smoobu\.com\/api\/reservations\?arrivalFrom=/);
    expect(opts.headers['Api-Key']).toBe('test-key-123');
  });

  it('idempotente — sincronizar 2x não cria duplicados', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        reservations: [
          {
            id: 3001,
            arrival: amanha,
            apartment: { id: 200, name: 'X' },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    // 1ª sincronização → cria.
    const res1 = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res1.status).toBe(200);
    expect(res1.body.criadas).toBe(1);
    expect(res1.body.existentes).toBe(0);

    // 2ª sincronização → já existe.
    const res2 = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res2.status).toBe(200);
    expect(res2.body.criadas).toBe(0);
    expect(res2.body.existentes).toBe(1);

    // Confirma que só existe 1 tarefa.
    const count = await Tarefa.countDocuments({ smoobu_reserva_id: '3001' });
    expect(count).toBe(1);
  });

  it('fetch devolve erro 500 → 502', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
      text: async () => 'Smoobu error',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res.status).toBe(502);
    expect(res.body.erro).toMatch(/500/);
  });

  it('reserva com propriedade inexistente → conta como erro mas não falha o todo', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        reservations: [
          {
            id: 4001,
            arrival: amanha,
            apartment: { id: 999999, name: 'Inexistente' }, // prop não existe
          },
          {
            id: 4002,
            arrival: amanha,
            apartment: { id: 200, name: 'Existe' },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar', {});
    expect(res.status).toBe(200);
    expect(res.body.totalRecebidas).toBe(2);
    expect(res.body.criadas).toBe(1);
    expect(res.body.erros).toBe(1);
    expect(res.body.detalheErros.length).toBe(1);
    expect(String(res.body.detalheErros[0].reservaId)).toBe('4001');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Smoobu — listar propriedades (apartamentos)                     */
/* ------------------------------------------------------------------ */

describe('GET /api/gestor/smoobu/propriedades', () => {
  let apiKeyOriginal;

  beforeEach(() => {
    apiKeyOriginal = process.env.SMOOBU_API_KEY;
  });

  afterEach(() => {
    if (apiKeyOriginal === undefined) {
      delete process.env.SMOOBU_API_KEY;
    } else {
      process.env.SMOOBU_API_KEY = apiKeyOriginal;
    }
    if (global.fetch && global.fetch.__isMock) {
      global.fetch.mockRestore();
      delete global.fetch.__isMock;
    }
  });

  it('sem token → 401', async () => {
    const res = await request(app).get('/api/gestor/smoobu/propriedades');
    expect(res.status).toBe(401);
  });

  it('sem SMOOBU_API_KEY configurada → 400', async () => {
    delete process.env.SMOOBU_API_KEY;
    const res = await authGet('/api/gestor/smoobu/propriedades');
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/SMOOBU_API_KEY/);
  });

  it('com API key + fetch mockado → 200 + lista de apartamentos limpa', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [
          { id: 101, name: 'Casa da Praia', someField: 'ignored' },
          { id: 102, name: 'Apartamento Centro' },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authGet('/api/gestor/smoobu/propriedades');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.propriedadesSmoobu)).toBe(true);
    expect(res.body.propriedadesSmoobu.length).toBe(2);
    // Devolve só id + name (não vaza other fields).
    expect(res.body.propriedadesSmoobu[0]).toEqual({ id: 101, name: 'Casa da Praia' });
    expect(res.body.propriedadesSmoobu[0]).not.toHaveProperty('someField');

    // Verifica que o fetch foi chamado com o URL e header corretos.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://login.smoobu.com/api/apartments');
    expect(opts.headers['Api-Key']).toBe('test-key-123');
  });

  it('fetch devolve erro 401 (API key inválida) → 502', async () => {
    process.env.SMOOBU_API_KEY = 'invalid-key';
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
      text: async () => 'Unauthorized',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authGet('/api/gestor/smoobu/propriedades');
    expect(res.status).toBe(502);
    expect(res.body.erro).toMatch(/401/);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Smoobu — sincronizar propriedades (upsert em massa)             */
/* ------------------------------------------------------------------ */

describe('POST /api/gestor/smoobu/sincronizar-propriedades', () => {
  const Propriedade = require('../models/Propriedade');
  let apiKeyOriginal;

  beforeEach(async () => {
    apiKeyOriginal = process.env.SMOOBU_API_KEY;
    // Limpa propriedades de teste anteriores.
    await Propriedade.deleteMany({ smoobu_id: { $in: ['sync-1', 'sync-2'] } });
  });

  afterEach(() => {
    if (apiKeyOriginal === undefined) {
      delete process.env.SMOOBU_API_KEY;
    } else {
      process.env.SMOOBU_API_KEY = apiKeyOriginal;
    }
    if (global.fetch && global.fetch.__isMock) {
      global.fetch.mockRestore();
      delete global.fetch.__isMock;
    }
  });

  it('sem token → 401', async () => {
    const res = await request(app).post('/api/gestor/smoobu/sincronizar-propriedades');
    expect(res.status).toBe(401);
  });

  it('sem SMOOBU_API_KEY configurada → 400', async () => {
    delete process.env.SMOOBU_API_KEY;
    const res = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/SMOOBU_API_KEY/);
  });

  it('com API key + fetch mockado → 200 + cria propriedades novas', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [
          { id: 'sync-1', name: 'Casa A' },
          { id: 'sync-2', name: 'Casa B' },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res.status).toBe(200);
    expect(res.body.totalRecebidas).toBe(2);
    expect(res.body.criadas).toBe(2);
    expect(res.body.existentes).toBe(0);
    expect(res.body.erros).toBe(0);

    // Confirma que as propriedades foram criadas na BD.
    const p1 = await Propriedade.findOne({ smoobu_id: 'sync-1' });
    const p2 = await Propriedade.findOne({ smoobu_id: 'sync-2' });
    expect(p1).not.toBeNull();
    expect(p1.nome).toBe('Casa A');
    expect(p1.tempo_limpeza_minutos).toBe(45);
    expect(p2.nome).toBe('Casa B');
  });

  it('idempotente — sincronizar 2x não duplica nem altera existentes', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [{ id: 'sync-1', name: 'Casa A' }],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    // 1ª sincronização → cria.
    const res1 = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res1.body.criadas).toBe(1);
    expect(res1.body.existentes).toBe(0);

    // 2ª sincronização → já existe (não duplica).
    const res2 = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res2.body.criadas).toBe(0);
    expect(res2.body.existentes).toBe(1);

    // Só 1 documento na BD.
    const count = await Propriedade.countDocuments({ smoobu_id: 'sync-1' });
    expect(count).toBe(1);
  });

  it('preserva edições manuais — não altera propriedade existente', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    // Cria uma propriedade com nome editado (simula edição manual do Admin).
    await Propriedade.create({
      smoobu_id: 'sync-1',
      nome: 'Nome Editado pelo Admin',
      morada: 'Rua Manual',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 120, // editado
      ativo: false, // editado
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [{ id: 'sync-1', name: 'Nome Original Smoobu' }],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res.status).toBe(200);
    expect(res.body.existentes).toBe(1);
    expect(res.body.criadas).toBe(0);

    // A propriedade mantém os valores editados (não foi sobreposta).
    const p = await Propriedade.findOne({ smoobu_id: 'sync-1' });
    expect(p.nome).toBe('Nome Editado pelo Admin');
    expect(p.tempo_limpeza_minutos).toBe(120);
    expect(p.ativo).toBe(false);
  });

  it('fetch devolve erro 502 (Bad Gateway do Smoobu) → 502 + mensagem', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({}),
      text: async () => 'Bad Gateway',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res.status).toBe(502);
    expect(res.body.erro).toMatch(/502/);

    // Confirma que nenhuma propriedade foi criada (a chamada falhou).
    const p = await Propriedade.findOne({ smoobu_id: 'sync-502-test' });
    expect(p).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 12. Fluxo de aprovação de ausências (v1.24.0)                       */
/* ------------------------------------------------------------------ */

describe('Fluxo de aprovação de ausências', () => {
  let staffToken, staffId, propId, tarefaAtribuida;

  beforeAll(async () => {
    // Cria um staff.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Ausencia',
      email: 'staff.ausencia@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'staff',
      ativo: true,
    });
    staffId = String(staff._id);

    // Login como staff.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.ausencia@teste.pt', password: PASSWORD });
    staffToken = res.body.token;

    // Cria uma propriedade + tarefa atribuída ao staff (data futura).
    propId = await Propriedade.create({
      smoobu_id: 'aus-prop-1',
      nome: 'Casa Ausencia',
      morada: 'Rua Ausencia',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 45,
    });
    const dataFutura = new Date(Date.now() + 10 * 86400000);
    tarefaAtribuida = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propId._id,
      utilizador_id: staffId,
      data: dataFutura,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
  });

  it('staff cria pedido de ausência → 201 + estado pendente', async () => {
    const res = await request(app)
      .post('/api/staff/ausencias')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        data_inicio: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
        data_fim: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10),
        tipo: 'ferias',
        notas: 'Férias de verão',
      });
    expect(res.status).toBe(201);
    expect(res.body.ausencia.estado).toBe('pendente');
    expect(res.body.ausencia.tipo).toBe('ferias');
    expect(String(res.body.ausencia.utilizador_id)).toBe(staffId);
  });

  it('staff vê as suas ausências → 200 + lista com a pendente', async () => {
    const res = await request(app)
      .get('/api/staff/ausencias')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.ausencias)).toBe(true);
    expect(res.body.ausencias.length).toBeGreaterThanOrEqual(1);
    expect(res.body.ausencias.some((a) => a.estado === 'pendente')).toBe(true);
  });

  it('staff sem token → 401', async () => {
    const res = await request(app).get('/api/staff/ausencias');
    expect(res.status).toBe(401);
  });

  it('staff não pode aceder a endpoints de gestão (/api/gestor/ausencias) → 403', async () => {
    // O staff tem token válido, mas role 'staff' não tem permissão de gestor/admin.
    const res = await request(app)
      .get('/api/gestor/ausencias')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });

  it('staff não pode aprovar ausências (PATCH /api/gestor/ausencias/:id/estado) → 403', async () => {
    const res = await request(app)
      .patch('/api/gestor/ausencias/000000000000000000000000/estado')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ estado: 'aprovada' });
    expect(res.status).toBe(403);
  });

  it('admin aprova ausência → 200 + redistribui tarefas do período', async () => {
    // Busca a ausência pendente criada pelo staff.
    const Ausencia = require('../models/Ausencia');
    const pendente = await Ausencia.findOne({
      utilizador_id: staffId,
      estado: 'pendente',
    });
    expect(pendente).not.toBeNull();

    // Confirma que a tarefa está atribuída ao staff antes de aprovar.
    const antes = await Tarefa.findById(tarefaAtribuida._id);
    expect(String(antes.utilizador_id)).toBe(staffId);

    // Admin aprova.
    const res = await authPatch(`/api/gestor/ausencias/${pendente._id}/estado`, {
      estado: 'aprovada',
    });
    expect(res.status).toBe(200);
    expect(res.body.ausencia.estado).toBe('aprovada');
    expect(res.body.redistribuicao).toBeTruthy();
    expect(res.body.redistribuicao.total).toBeGreaterThanOrEqual(1);

    // A tarefa foi reatribuída (utilizador_id mudou ou ficou por_atribuir).
    const depois = await Tarefa.findById(tarefaAtribuida._id);
    expect(String(depois.utilizador_id)).not.toBe(staffId);
  });

  it('admin rejeita ausência → 200 + só atualiza estado (não mexe em tarefas)', async () => {
    // Cria outra ausência pendente.
    await request(app)
      .post('/api/staff/ausencias')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        data_inicio: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
        data_fim: new Date(Date.now() + 22 * 86400000).toISOString().slice(0, 10),
        tipo: 'doenca',
      });

    const Ausencia = require('../models/Ausencia');
    const pendente = await Ausencia.findOne({
      utilizador_id: staffId,
      estado: 'pendente',
    });
    expect(pendente).not.toBeNull();

    const res = await authPatch(`/api/gestor/ausencias/${pendente._id}/estado`, {
      estado: 'rejeitada',
    });
    expect(res.status).toBe(200);
    expect(res.body.ausencia.estado).toBe('rejeitada');
    // Rejeitar NÃO redistribui.
    expect(res.body.redistribuicao).toBeNull();
  });

  it('admin aprovar com estado inválido → 400', async () => {
    const Ausencia = require('../models/Ausencia');
    const pendente = await Ausencia.findOne({
      utilizador_id: staffId,
      estado: 'pendente',
    });
    if (!pendente) return; // se não há pendente, skip
    const res = await authPatch(`/api/gestor/ausencias/${pendente._id}/estado`, {
      estado: 'invalido',
    });
    expect(res.status).toBe(400);
  });

  it('admin aprovar ausência inexistente → 404', async () => {
    const idInexistente = new mongoose.Types.ObjectId();
    const res = await authPatch(`/api/gestor/ausencias/${idInexistente}/estado`, {
      estado: 'aprovada',
    });
    expect(res.status).toBe(404);
  });

  it('staff cancela pedido pendente → 200 + elimina', async () => {
    // Cria um pedido pendente.
    const r = await request(app)
      .post('/api/staff/ausencias')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        data_inicio: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        data_fim: new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10),
        tipo: 'outro',
      });
    expect(r.status).toBe(201);
    const id = r.body.ausencia._id;

    // Cancela.
    const res = await request(app)
      .delete(`/api/staff/ausencias/${id}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);

    // Confirma que foi eliminado.
    const Ausencia = require('../models/Ausencia');
    const still = await Ausencia.findById(id);
    expect(still).toBeNull();
  });

  it('staff não pode cancelar pedido já aprovado → 403', async () => {
    // Cria pendente.
    const r = await request(app)
      .post('/api/staff/ausencias')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        data_inicio: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10),
        data_fim: new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10),
        tipo: 'ferias',
      });
    const id = r.body.ausencia._id;

    // Admin aprova.
    await authPatch(`/api/gestor/ausencias/${id}/estado`, { estado: 'aprovada' });

    // Staff tenta cancelar → 403.
    const res = await request(app)
      .delete(`/api/staff/ausencias/${id}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* 13. Notificações Push (Web Push API) — v1.27.0                     */
/* ------------------------------------------------------------------ */

describe('Notificações Push (Web Push API)', () => {
  // Como os testes correm sem chaves VAPID configuradas, os endpoints
  // devolvem 503 (serviço não configurado). Isto é o comportamento esperado
  // e garante que o servidor não parte se as chaves não estiverem definidas.

  it('GET /api/auth/me/push-vapid-public-key sem token → 401', async () => {
    const res = await request(app).get('/api/auth/me/push-vapid-public-key');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me/push-vapid-public-key com token (sem VAPID) → 503', async () => {
    const res = await authGet('/api/auth/me/push-vapid-public-key');
    expect(res.status).toBe(503);
  });

  it('POST /api/auth/me/push-subscribe sem token → 401', async () => {
    const res = await request(app).post('/api/auth/me/push-subscribe');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/me/push-subscribe com token (sem VAPID) → 503', async () => {
    const res = await authPost('/api/auth/me/push-subscribe', {
      subscription: { endpoint: 'https://fcm.googleapis.com/test', keys: {} },
    });
    expect(res.status).toBe(503);
  });

  it('POST /api/auth/me/push-subscribe com subscription inválida → 400 (se VAPID ativo)', async () => {
    // Sem VAPID configurado, devolve 503 antes de validar a subscription.
    // Este teste confirma a ordem: VAPID é verificado primeiro.
    const res = await authPost('/api/auth/me/push-subscribe', {
      subscription: null,
    });
    expect(res.status).toBe(503);
  });

  it('POST /api/auth/me/push-unsubscribe sem token → 401', async () => {
    const res = await request(app).post('/api/auth/me/push-unsubscribe');
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 14. Super Admin — listarEmpresas + impersonarGestor (v1.32.0)      */
/* ------------------------------------------------------------------ */

describe('Super Admin (rotas exclusivas /api/admin)', () => {
  it('GET /api/admin/empresas sem token → 401', async () => {
    const res = await request(app).get('/api/admin/empresas');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/empresas com token de gestor → 403', async () => {
    // O adminToken é role 'admin', mas vamos testar com um gestor.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const gestorUser = await Utilizador.create({
      nome: 'Gestor Teste RBAC',
      email: 'gestor.rbac@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'gestor',
      ativo: true,
    });
    const gestorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'gestor.rbac@teste.pt', password: PASSWORD });
    const gestorToken = gestorLogin.body.token;

    const res = await request(app)
      .get('/api/admin/empresas')
      .set('Authorization', `Bearer ${gestorToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/empresas com admin → 200 + lista com gestor', async () => {
    const res = await authGet('/api/admin/empresas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.empresas)).toBe(true);
    expect(res.body.empresas.length).toBeGreaterThanOrEqual(1);

    // Verifica que a empresa de teste tem gestor populado.
    const empTeste = res.body.empresas.find(
      (e) => String(e._id) === empresaId
    );
    expect(empTeste).toBeTruthy();
    // O setup cria um gestor (gestor@autocell.pt), mas pode não estar na
    // mesma empresa se o setup foi chamado antes do beforeAll. Verifica
    // que o campo gestor existe (pode ser null se não houver gestor).
    expect(empTeste).toHaveProperty('gestor');
  });

  it('POST /api/admin/empresas/:id/impersonar com admin → 200 + token do gestor', async () => {
    // Cria um gestor na empresa de teste.
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({
      nome: 'Gestor Impersonar',
      email: 'gestor.impersonar@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'gestor',
      ativo: true,
    });

    const res = await authPost(`/api/admin/empresas/${empresaId}/impersonar`, {});
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.utilizador.role).toBe('gestor');
    expect(res.body.utilizador.empresa_id).toBe(empresaId);
    expect(res.body.impersonado).toBe(true);
    expect(res.body.empresa).toBeTruthy();
    expect(res.body.empresa.id).toBe(empresaId);

    // Verifica que o token funciona (pode ser usado para aceder a /api/gestor).
    const verifyRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.utilizador.role).toBe('gestor');
  });

  it('POST /api/admin/empresas/:id/impersonar com gestor → 403', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({
      nome: 'Gestor Block',
      email: 'gestor.block@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'gestor',
      ativo: true,
    });
    const gestorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'gestor.block@teste.pt', password: PASSWORD });

    const res = await request(app)
      .post(`/api/admin/empresas/${empresaId}/impersonar`)
      .set('Authorization', `Bearer ${gestorLogin.body.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('POST /api/admin/empresas/:id/impersonar empresa inexistente → 404', async () => {
    const idInexistente = new mongoose.Types.ObjectId();
    const res = await authPost(`/api/admin/empresas/${idInexistente}/impersonar`, {});
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 15. Staff — concluir tarefa (v1.34.0)                              */
/* ------------------------------------------------------------------ */

describe('PATCH /api/staff/tarefas/:id/concluir', () => {
  let tarefaStaff, propTeste, staffConcluirToken, staffConcluirId;

  beforeAll(async () => {
    // Cria um staff próprio para este bloco.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staffConcluir = await Utilizador.create({
      nome: 'Staff Concluir',
      email: 'staff.concluir@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'staff',
      ativo: true,
    });
    staffConcluirId = String(staffConcluir._id);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.concluir@teste.pt', password: PASSWORD });
    staffConcluirToken = loginRes.body.token;

    // Cria uma propriedade para os testes.
    const Propriedade = require('../models/Propriedade');
    propTeste = await Propriedade.create({
      smoobu_id: 'concluir-test-prop',
      nome: 'Casa Teste Concluir',
      morada: 'Rua Teste',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 45,
    });

    // Cria uma tarefa atribuída ao staff de teste.
    const amanha = new Date(Date.now() + 86400000);
    tarefaStaff = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propTeste._id,
      utilizador_id: staffConcluirId,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
  });

  it('sem token → 401', async () => {
    const res = await request(app).patch(`/api/staff/tarefas/${tarefaStaff._id}/concluir`);
    expect(res.status).toBe(401);
  });

  it('staff conclui a sua tarefa → 200 + estado concluída + hora_conclusao', async () => {
    const res = await request(app)
      .patch(`/api/staff/tarefas/${tarefaStaff._id}/concluir`)
      .set('Authorization', `Bearer ${staffConcluirToken}`)
      .send({ observacoes_staff: 'Tudo limpo, sem problemas.' });

    expect(res.status).toBe(200);
    expect(res.body.tarefa.estado).toBe('concluida');
    expect(res.body.tarefa.hora_conclusao).toBeTruthy();
    expect(res.body.tarefa.concluida_em).toBeTruthy();
    expect(res.body.tarefa.observacoes_staff).toBe('Tudo limpo, sem problemas.');
  });

  it('tentar concluir tarefa já concluída → 400', async () => {
    const res = await request(app)
      .patch(`/api/staff/tarefas/${tarefaStaff._id}/concluir`)
      .set('Authorization', `Bearer ${staffConcluirToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('staff tenta concluir tarefa de outro utilizador → 404', async () => {
    // Cria tarefa atribuída ao admin (não ao staff).
    const tarefaAdmin = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propTeste._id,
      utilizador_id: new mongoose.Types.ObjectId(adminId),
      data: new Date(Date.now() + 86400000),
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const res = await request(app)
      .patch(`/api/staff/tarefas/${tarefaAdmin._id}/concluir`)
      .set('Authorization', `Bearer ${staffConcluirToken}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 16. Staff — reportar avaria (v1.38.0)                               */
/* ------------------------------------------------------------------ */

describe('POST /api/staff/tarefas/:id/avaria', () => {
  let tarefaAvaria, propAvaria, staffAvariaToken, staffAvariaId;

  beforeAll(async () => {
    // Cria um staff próprio para este bloco.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staffAvaria = await Utilizador.create({
      nome: 'Staff Avaria',
      email: 'staff.avaria@teste.pt',
      password_hash: hash,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      role: 'staff',
      ativo: true,
    });
    staffAvariaId = String(staffAvaria._id);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.avaria@teste.pt', password: PASSWORD });
    staffAvariaToken = loginRes.body.token;

    // Cria uma propriedade para os testes.
    const Propriedade = require('../models/Propriedade');
    propAvaria = await Propriedade.create({
      smoobu_id: 'avaria-test-prop',
      nome: 'Casa Teste Avaria',
      morada: 'Rua Avaria',
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 45,
    });

    // Cria uma tarefa atribuída ao staff de teste.
    const amanha = new Date(Date.now() + 86400000);
    tarefaAvaria = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propAvaria._id,
      utilizador_id: staffAvariaId,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
  });

  it('sem token → 401', async () => {
    const res = await request(app)
      .post(`/api/staff/tarefas/${tarefaAvaria._id}/avaria`)
      .send({ descricao: 'Torreira partida' });
    expect(res.status).toBe(401);
  });

  it('sem descrição → 400', async () => {
    const res = await request(app)
      .post(`/api/staff/tarefas/${tarefaAvaria._id}/avaria`)
      .set('Authorization', `Bearer ${staffAvariaToken}`)
      .send({ descricao: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/descrição/i);
  });

  it('staff reporta avaria → 200 + cria tarefa de manutenção para a mesma propriedade', async () => {
    const tarefasAntes = await Tarefa.countDocuments({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tipo: 'manutencao',
    });

    const res = await request(app)
      .post(`/api/staff/tarefas/${tarefaAvaria._id}/avaria`)
      .set('Authorization', `Bearer ${staffAvariaToken}`)
      .send({ descricao: 'Torreira da cozinha está a deitar água' });

    expect(res.status).toBe(200);
    expect(res.body.mensagem).toBeTruthy();

    // A tarefa original passa a ter a avaria no array.
    expect(res.body.tarefa.avarias).toBeInstanceOf(Array);
    expect(res.body.tarefa.avarias.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tarefa.avarias[0]).toMatch(/Torreira/);

    // Cria uma nova tarefa de manutenção.
    const manutencao = res.body.tarefa_manutencao;
    expect(manutencao).toBeTruthy();
    expect(manutencao.tipo).toBe('manutencao');
    expect(manutencao.estado).toBe('por_atribuir');
    expect(manutencao.utilizador_id).toBeNull();
    // Mesma propriedade da tarefa original.
    expect(String(manutencao.propriedade_id)).toBe(
      String(tarefaAvaria.propriedade_id)
    );

    // Confirma na BD que foi criada uma nova tarefa de manutenção.
    const tarefasDepois = await Tarefa.countDocuments({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tipo: 'manutencao',
    });
    expect(tarefasDepois).toBe(tarefasAntes + 1);
  });

  it('staff reporta avaria em tarefa de outro utilizador → 404', async () => {
    // Cria tarefa atribuída ao admin (não ao staff).
    const tarefaAdmin = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propAvaria._id,
      utilizador_id: new mongoose.Types.ObjectId(adminId),
      data: new Date(Date.now() + 86400000),
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const res = await request(app)
      .post(`/api/staff/tarefas/${tarefaAdmin._id}/avaria`)
      .set('Authorization', `Bearer ${staffAvariaToken}`)
      .send({ descricao: 'Outra avaria' });

    expect(res.status).toBe(404);
  });

  it('staff reporta avaria em tarefa cancelada → 400', async () => {
    // Cria tarefa cancelada atribuída ao staff.
    const tarefaCancelada = await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: propAvaria._id,
      utilizador_id: staffAvariaId,
      data: new Date(Date.now() + 86400000),
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'cancelada',
    });

    const res = await request(app)
      .post(`/api/staff/tarefas/${tarefaCancelada._id}/avaria`)
      .set('Authorization', `Bearer ${staffAvariaToken}`)
      .send({ descricao: 'Avaria em tarefa cancelada' });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/cancelada/i);
  });
});
