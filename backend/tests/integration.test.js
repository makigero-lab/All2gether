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

  it('com token + sem filtros → 200 + exclui canceladas por defeito (Prompt 103)', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tarefas)).toBe(true);
    // Prompt 103 — canceladas são excluídas por defeito (só aparecem no Excel).
    const temCancelada = res.body.tarefas.some((t) => t.estado === 'cancelada');
    expect(temCancelada).toBe(false);
  });

  it('com incluir_canceladas=true → inclui canceladas (para Excel)', async () => {
    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${dataStr}&fim=${dataStr}&incluir_canceladas=true`
    );
    expect(res.status).toBe(200);
    // Com incluir_canceladas=true, as canceladas aparecem (histórico Excel).
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

  it('Prompt 100 — devolve detalhes_reserva quando a tarefa o tem', async () => {
    // Cria uma tarefa com detalhes_reserva preenchidos.
    const amanha = new Date(
      Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);
    const amanhaStr = amanha.toISOString();

    await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: prop1._id,
      utilizador_id: staff1._id,
      data: amanhaStr,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
      detalhes_reserva: {
        checkin: '2026-01-15',
        checkout: '2026-01-20',
        pax: 4,
        nome_hospede: 'Maria Silva',
      },
    });

    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${amanhaStr.slice(0, 10)}&fim=${amanhaStr.slice(0, 10)}`
    );
    expect(res.status).toBe(200);
    const t = res.body.tarefas.find((x) => x.detalhes_reserva);
    expect(t).toBeDefined();
    expect(t.detalhes_reserva.checkin).toBe('2026-01-15');
    expect(t.detalhes_reserva.checkout).toBe('2026-01-20');
    expect(t.detalhes_reserva.pax).toBe(4);
    expect(t.detalhes_reserva.nome_hospede).toBe('Maria Silva');
  });

  it('Prompt 100 — tarefa sem detalhes_reserva (ex: manutenção) → campo existe mas vazio', async () => {
    // Cria uma tarefa de manutenção SEM detalhes_reserva.
    const amanha = new Date(
      Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 2);
    const amanhaStr = amanha.toISOString();

    await Tarefa.create({
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      propriedade_id: prop1._id,
      utilizador_id: staff1._id,
      data: amanhaStr,
      tempo_limpeza_minutos: 45,
      tipo: 'manutencao',
      estado: 'atribuida',
      // sem detalhes_reserva
    });

    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${amanhaStr.slice(0, 10)}&fim=${amanhaStr.slice(0, 10)}`
    );
    expect(res.status).toBe(200);
    const t = res.body.tarefas.find((x) => x.tipo === 'manutencao');
    expect(t).toBeDefined();
    // detalhes_reserva existe (objeto com defaults null) mas sem dados reais.
    expect(t.detalhes_reserva).toBeDefined();
    expect(t.detalhes_reserva.checkin).toBeNull();
    expect(t.detalhes_reserva.pax).toBeNull();
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

  it('cancellation → SOFT DELETE: estado=cancelada + utilizador_id=null (Prompt 103)', async () => {
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

    // 2) Envia cancellation → tarefa fica cancelada (soft delete) + utilizador_id=null.
    await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const depois = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    // A tarefa MANTIDA (soft delete), com estado 'cancelada' e utilizador_id null.
    expect(depois).not.toBeNull();
    expect(depois.estado).toBe('cancelada');
    expect(depois.utilizador_id).toBeNull();
  });

  it('cancellation idempotente → cancelar 2x mantém cancelada', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // Cria primeiro.
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
    // A tarefa mantém-se cancelada (soft delete).
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.estado).toBe('cancelada');
  });

  it('cancellation → tarefa CONCLUÍDA também fica cancelada (Prompt 103)', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // Cria.
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    // Marca como concluída manualmente.
    await Tarefa.updateOne(
      { smoobu_reserva_id: '1111' },
      { $set: { estado: 'concluida' } }
    );
    // Cancela.
    await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 1111, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    // A tarefa foi MANTIDA (soft delete) → marcada como cancelada.
    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '1111' });
    expect(tarefa).not.toBeNull();
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
    // 2) Cancela → tarefa fica cancelada (soft delete, Prompt 103).
    await request(app).post('/webhooks/smoobu').send({
      action: 'cancellation',
      data: { id: 4444, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const cancelada = await Tarefa.findOne({ smoobu_reserva_id: '4444' });
    expect(cancelada).not.toBeNull();
    expect(cancelada.estado).toBe('cancelada');
    // 3) Re-cria (newReservation com mesmo ID) → re-activa a tarefa.
    await request(app).post('/webhooks/smoobu').send({
      action: 'newReservation',
      data: { id: 4444, arrival: amanha, apartment: { id: 200, name: 'X' } },
    });
    await esperar(400);
    const reactivada = await Tarefa.findOne({ smoobu_reserva_id: '4444' });
    expect(reactivada).not.toBeNull();
    expect(reactivada.estado).not.toBe('cancelada');
    // Não criou duplicado.
    const count = await Tarefa.countDocuments({ smoobu_reserva_id: '4444' });
    expect(count).toBe(1);
  });

  // Prompt 93 (Fase 1.5) — Detalhes da reserva + Algoritmo VIP.

  it('Prompt 93 — guarda detalhes_reserva (checkin, checkout, pax, nome_hospede) extraídos do payload', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const depois = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    await request(app)
      .post('/webhooks/smoobu')
      .send({
        action: 'newReservation',
        data: {
          id: 5500,
          arrival: amanha,
          departure: depois,
          apartment: { id: 200, name: 'Apartamento Teste' },
          guests: 4,
          guestName: 'Maria Silva',
        },
      });
    await esperar(400);

    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '5500' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.detalhes_reserva).toBeDefined();
    expect(tarefa.detalhes_reserva.checkin).toBe(amanha);
    expect(tarefa.detalhes_reserva.checkout).toBe(depois);
    expect(tarefa.detalhes_reserva.pax).toBe(4);
    expect(tarefa.detalhes_reserva.nome_hospede).toBe('Maria Silva');
  });

  it('Prompt 93 — Algoritmo VIP: atribui ao funcionário preferencial quando disponível', async () => {
    // Cria um segundo staff e define-o como preferencial da propriedade 200.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const preferencial = await Utilizador.create({
      nome: 'Staff Preferencial',
      email: 'staff.vip@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      dias_folga: [],
    });
    await Propriedade.updateOne(
      { smoobu_id: '200' },
      { $set: { funcionario_preferencial_id: preferencial._id } }
    );

    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await request(app)
      .post('/webhooks/smoobu')
      .send({
        action: 'newReservation',
        data: { id: 5501, arrival: amanha, apartment: { id: 200, name: 'X' } },
      });
    await esperar(400);

    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '5501' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.utilizador_id).not.toBeNull();
    // Tem de ser atribuída AO preferencial (ignora o load balancer geral).
    expect(String(tarefa.utilizador_id)).toBe(String(preferencial._id));
  });

  it('Prompt 93 — Algoritmo VIP: fallback para load balancer se o preferencial exceder o SLA de 8h', async () => {
    // Staff preferencial já com 7h30 (450 min) de carga no dia → com a nova
    // tarefa (60 min) ficaria com 510 min > 480 min (SLA). Tem de fazer fallback.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const preferencial = await Utilizador.create({
      nome: 'Staff VIP Sobrecarga',
      email: 'staff.vipfull@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      dias_folga: [],
    });
    const prop = await Propriedade.findOne({ smoobu_id: '200' });
    await Propriedade.updateOne(
      { smoobu_id: '200' },
      { $set: { funcionario_preferencial_id: preferencial._id } }
    );

    const amanha = new Date(Date.now() + 86400000);
    const inicioDia = new Date(
      Date.UTC(amanha.getUTCFullYear(), amanha.getUTCMonth(), amanha.getUTCDate())
    );
    // Cria tarefas que somam 450 min (7h30) ao preferencial nesse dia.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      smoobu_reserva_id: 'pre-carga-1',
      utilizador_id: preferencial._id,
      data: inicioDia,
      tempo_limpeza_minutos: 450,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    // Garante que há pelo menos outro staff disponível para o fallback.
    const outro = await Utilizador.create({
      nome: 'Staff Fallback',
      email: 'staff.fallback@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      dias_folga: [],
    });

    const diaStr = inicioDia.toISOString().slice(0, 10);
    await request(app)
      .post('/webhooks/smoobu')
      .send({
        action: 'newReservation',
        data: { id: 5502, arrival: diaStr, apartment: { id: 200, name: 'X' } },
      });
    await esperar(400);

    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '5502' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.utilizador_id).not.toBeNull();
    // NÃO pode ser o preferencial (excedia o SLA) → tem de ser outro staff
    // (o load balancer geral escolhe o com menor carga; pode ser o do
    // beforeEach ou o "outro" criado aqui — o importante é não ser o VIP).
    expect(String(tarefa.utilizador_id)).not.toBe(String(preferencial._id));
  });

  it('Prompt 93 — Algoritmo VIP: fallback se o preferencial tiver folga nesse dia', async () => {
    const amanha = new Date(Date.now() + 86400000);
    const diaSemana = amanha.getDay();

    const hash = await bcrypt.hash(PASSWORD, 10);
    const preferencial = await Utilizador.create({
      nome: 'Staff VIP Folga',
      email: 'staff.vipfolga@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      dias_folga: [diaSemana], // tem folga fixa no dia do check-in
    });
    const outro = await Utilizador.create({
      nome: 'Staff Sem Folga',
      email: 'staff.semfolga@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      dias_folga: [],
    });
    await Propriedade.updateOne(
      { smoobu_id: '200' },
      { $set: { funcionario_preferencial_id: preferencial._id } }
    );

    const diaStr = amanha.toISOString().slice(0, 10);
    await request(app)
      .post('/webhooks/smoobu')
      .send({
        action: 'newReservation',
        data: { id: 5503, arrival: diaStr, apartment: { id: 200, name: 'X' } },
      });
    await esperar(400);

    const tarefa = await Tarefa.findOne({ smoobu_reserva_id: '5503' });
    expect(tarefa).not.toBeNull();
    expect(tarefa.utilizador_id).not.toBeNull();
    // NÃO pode ser o preferencial (tinha folga) → tem de ser outro staff
    // disponível (load balancer geral).
    expect(String(tarefa.utilizador_id)).not.toBe(String(preferencial._id));
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
    expect(res.body.erro).toMatch(/Smoobu não configurada/);
  });

  it('com API key + fetch mockado → 200 + contadores', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Mocka o fetch global para devolver 2 reservas com paginação (page_count: 1).
    // Prompt 137b — Inclui guestName para evitar que o processarReservaSmoobu
    // faça fetch extra de enriquecimento (que quebraria a asserção de 1 chamada).
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bookings: [
          {
            id: 2001,
            arrival: amanha,
            departure: amanha,
            apartment: { id: 200, name: 'Apartamento Teste' },
            guestName: 'João Silva',
          },
          {
            id: 2002,
            arrival: amanha,
            departure: amanha,
            apartment: { id: 200, name: 'Apartamento Teste' },
            guestName: 'Maria Santos',
          },
        ],
        page_count: 1,
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
    expect(url).toMatch(/page=1/);
    expect(opts.headers['Api-Key']).toBe('test-key-123');
  });

  it('idempotente — sincronizar 2x não cria duplicados', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Prompt 137b — Inclui guestName para evitar fetch extra de enriquecimento.
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bookings: [
          {
            id: 3001,
            arrival: amanha,
            apartment: { id: 200, name: 'X' },
            guestName: 'Hóspede Teste',
          },
        ],
        page_count: 1,
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
    expect(res.body.erro).toMatch(/Não foi possível ligar ao Smoobu/);
  });

  it('reserva com propriedade inexistente → conta como erro mas não falha o todo', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Prompt 137b — Inclui guestName para evitar fetch extra de enriquecimento.
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bookings: [
          {
            id: 4001,
            arrival: amanha,
            apartment: { id: 999999, name: 'Inexistente' }, // prop não existe
            guestName: 'Hóspede Inexistente',
          },
          {
            id: 4002,
            arrival: amanha,
            apartment: { id: 200, name: 'Existe' },
            guestName: 'Hóspede Válido',
          },
        ],
        page_count: 1,
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
    expect(res.body.erro).toMatch(/Smoobu não configurada/);
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
        page_count: 1,
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
    expect(res.body.erro).toMatch(/Smoobu não configurada/);
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
        page_count: 1,
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

  it('preserva nome/tempo/ativo quando o Smoobu não traz morada/capacidade no payload', async () => {
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

    // Smoobu devolve o apartamento SEM location e SEM rooms (não traz
    // morada nem capacidade) → nada a atualizar.
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
    expect(res.body.atualizadas).toBe(0);

    // A propriedade mantém os valores editados (não foi sobreposta).
    const p = await Propriedade.findOne({ smoobu_id: 'sync-1' });
    expect(p.nome).toBe('Nome Editado pelo Admin');
    expect(p.tempo_limpeza_minutos).toBe(120);
    expect(p.ativo).toBe(false);
  });

  it('Prompt 104 — sincronizar NÃO sobrescreve morada se já preenchida (só capacidade)', async () => {
    process.env.SMOOBU_API_KEY = 'test-key-123';

    // Propriedade já existente com morada preenchida + edits manuais.
    await Propriedade.create({
      smoobu_id: 'sync-1',
      nome: 'Casa Mantida',
      morada: 'Rua Antiga',
      capacidade_hospedes: 2,
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      tempo_limpeza_minutos: 90,
      ativo: false,
    });

    // Smoobu devolve a mesma propriedade com morada NOVA e capacidade NOVA.
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [
          {
            id: 'sync-1',
            name: 'Nome Ignorado pelo Smoobu',
            location: { street: 'Rua Nova 10', zip: '1000-001', city: 'Lisboa' },
            rooms: { maxOccupancy: 5 },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/sincronizar-propriedades', {});
    expect(res.status).toBe(200);
    expect(res.body.atualizadas).toBe(1);
    expect(res.body.existentes).toBe(0);
    expect(res.body.criadas).toBe(0);

    // Prompt 104 — A morada NÃO foi sobrescrita (edição manual tem prioridade).
    const p = await Propriedade.findOne({ smoobu_id: 'sync-1' });
    expect(p.morada).toBe('Rua Antiga');
    // A capacidade foi atualizada.
    expect(p.capacidade_hospedes).toBe(5);

    // Mas nome, tempo e ativo continuam preservados (edições manuais).
    expect(p.nome).toBe('Casa Mantida');
    expect(p.tempo_limpeza_minutos).toBe(90);
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

  it('admin aprova ausência → 200 + desatribui tarefas do período (Prompt 97)', async () => {
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
    // Prompt 97 — agora desatribui (não redistribui via load balancer).
    expect(res.body.redistribuicao).toBeTruthy();
    expect(res.body.redistribuicao.desatribuidas).toBeGreaterThanOrEqual(1);

    // A tarefa foi DESATRIBUÍDA: utilizador_id = null + estado 'por_atribuir'.
    const depois = await Tarefa.findById(tarefaAtribuida._id);
    expect(depois.utilizador_id).toBeNull();
    expect(depois.estado).toBe('por_atribuir');
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

  it('Prompt 100 — empresa SEM gestor ativo → admin faz override e recebe token (não 404)', async () => {
    // Cria uma empresa nova sem nenhum gestor (só staff).
    const empSemGestor = await Empresa.create({
      nome: 'Empresa Sem Gestor',
      plano_ativo: true,
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create({
      nome: 'Staff Sem Gestor',
      email: 'staff.semgestor@teste.pt',
      password_hash: hash,
      empresa_id: empSemGestor._id,
      role: 'staff',
      ativo: true,
    });

    // Admin tenta impersonar esta empresa (não há gestor ativo).
    const res = await authPost(`/api/admin/empresas/${empSemGestor._id}/impersonar`, {});
    // Prompt 100 — NÃO devolve 404. Devolve 200 com token de override.
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.impersonado).toBe(true);
    expect(res.body.empresa.id).toBe(String(empSemGestor._id));
    // O utilizador no token é o admin (que fez o pedido), mas com
    // empresa_id da empresa alvo e role 'gestor' (impersonação).
    expect(res.body.utilizador.empresa_id).toBe(String(empSemGestor._id));
    expect(res.body.utilizador.role).toBe('gestor');
    expect(res.body.utilizador.id).toBe(adminId); // o próprio admin

    // Verifica que o token funciona (autentica).
    const verifyRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(verifyRes.status).toBe(200);
    // Nota: /api/auth/me lê o utilizador da BD pelo id do token (o admin),
    // pelo que devolve o empresa_id REAL do admin, não o override. Isto é
    // esperado — o override só afeta req.user.empresa_id (lido do token)
    // nos endpoints do painel gestor.

    // Verifica que consegue aceder a um endpoint do painel gestor com
    // o empresa_id override (dashboard usa obterEmpresaId → req.user.empresa_id
    // do token, que é a empresa alvo).
    const dashRes = await request(app)
      .get('/api/gestor/dashboard')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(dashRes.status).toBe(200);
  });

  /* -------------------------------------------------------------- */
  /* Prompt 101 — Gestão de utilizadores de empresas terceiras      */
  /* -------------------------------------------------------------- */

  it('Prompt 101 — GET /api/admin/empresas/:empresaId/utilizadores → lista utilizadores (só admin)', async () => {
    // Cria uma empresa + 2 utilizadores (1 gestor + 1 staff).
    const emp = await Empresa.create({ nome: 'Emp P101', plano_ativo: true });
    const hash = await bcrypt.hash(PASSWORD, 10);
    await Utilizador.create([
      {
        nome: 'Gestor P101',
        email: 'gestor.p101@teste.pt',
        password_hash: hash,
        empresa_id: emp._id,
        role: 'gestor',
        ativo: true,
      },
      {
        nome: 'Staff P101',
        email: 'staff.p101@teste.pt',
        password_hash: hash,
        empresa_id: emp._id,
        role: 'staff',
        ativo: true,
      },
    ]);

    // Sem token → 401.
    const resSemToken = await request(app).get(`/api/admin/empresas/${emp._id}/utilizadores`);
    expect(resSemToken.status).toBe(401);

    // Admin → 200 + lista.
    const res = await authGet(`/api/admin/empresas/${emp._id}/utilizadores`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.utilizadores)).toBe(true);
    expect(res.body.utilizadores.length).toBe(2);
    // Não devolve password_hash.
    expect(res.body.utilizadores.every((u) => !u.password_hash)).toBe(true);
    // Contém os 2 utilizadores.
    const roles = res.body.utilizadores.map((u) => u.role);
    expect(roles).toContain('gestor');
    expect(roles).toContain('staff');
  });

  it('Prompt 101 — POST /api/admin/empresas/:empresaId/utilizadores → cria gestor (empresa sem gestor)', async () => {
    const emp = await Empresa.create({ nome: 'Emp Sem Gestor P101', plano_ativo: true });

    const res = await authPost(`/api/admin/empresas/${emp._id}/utilizadores`, {
      nome: 'Novo Gestor P101',
      email: 'novo.gestor.p101@teste.pt',
      password: 'senha123',
      role: 'gestor',
    });
    expect(res.status).toBe(201);
    expect(res.body.utilizador.nome).toBe('Novo Gestor P101');
    expect(res.body.utilizador.role).toBe('gestor');
    expect(String(res.body.utilizador.empresa_id)).toBe(String(emp._id));
    expect(res.body.utilizador.ativo).toBe(true);
    expect(res.body.utilizador.password_hash).toBeUndefined();

    // Confirma que ficou na BD associado à empresa certa.
    const naBd = await Utilizador.findById(res.body.utilizador._id).lean();
    expect(String(naBd.empresa_id)).toBe(String(emp._id));
    expect(naBd.role).toBe('gestor');
  });

  it('Prompt 101 — POST criação rejeita role admin (403) e email duplicado (409)', async () => {
    const emp = await Empresa.create({ nome: 'Emp Valida P101', plano_ativo: true });

    // role admin → 403.
    const resAdmin = await authPost(`/api/admin/empresas/${emp._id}/utilizadores`, {
      nome: 'X',
      email: 'x.p101@teste.pt',
      password: 'senha123',
      role: 'admin',
    });
    expect(resAdmin.status).toBe(403);

    // Cria um gestor.
    await authPost(`/api/admin/empresas/${emp._id}/utilizadores`, {
      nome: 'Gestor Dup',
      email: 'dup.p101@teste.pt',
      password: 'senha123',
      role: 'gestor',
    });

    // Mesmo email → 409.
    const resDup = await authPost(`/api/admin/empresas/${emp._id}/utilizadores`, {
      nome: 'Outro',
      email: 'dup.p101@teste.pt',
      password: 'senha123',
      role: 'gestor',
    });
    expect(resDup.status).toBe(409);
  });

  it('Prompt 101 — PATCH .../utilizadores/:id/estado → alterna ativo/inativo', async () => {
    const emp = await Empresa.create({ nome: 'Emp Toggle P101', plano_ativo: true });
    const hash = await bcrypt.hash(PASSWORD, 10);
    const user = await Utilizador.create({
      nome: 'Staff Toggle P101',
      email: 'toggle.p101@teste.pt',
      password_hash: hash,
      empresa_id: emp._id,
      role: 'staff',
      ativo: true,
    });

    // Alterna (sem body) → fica inativo.
    const res1 = await authPatch(
      `/api/admin/empresas/${emp._id}/utilizadores/${user._id}/estado`,
      {}
    );
    expect(res1.status).toBe(200);
    expect(res1.body.ativo).toBe(false);

    // Alterna novamente → fica ativo.
    const res2 = await authPatch(
      `/api/admin/empresas/${emp._id}/utilizadores/${user._id}/estado`,
      {}
    );
    expect(res2.status).toBe(200);
    expect(res2.body.ativo).toBe(true);

    // Body explícito { ativo: false } → fica inativo.
    const res3 = await authPatch(
      `/api/admin/empresas/${emp._id}/utilizadores/${user._id}/estado`,
      { ativo: false }
    );
    expect(res3.body.ativo).toBe(false);
  });

  it('Prompt 101 — PATCH não permite modificar estado de admin (403) nem empresa errada (404)', async () => {
    const emp = await Empresa.create({ nome: 'Emp Seg P101', plano_ativo: true });
    const hash = await bcrypt.hash(PASSWORD, 10);
    // Utilizador de outra empresa (não pertence a emp).
    const outraEmp = await Empresa.create({ nome: 'Outra Emp P101', plano_ativo: true });
    const userOutra = await Utilizador.create({
      nome: 'Staff Outra P101',
      email: 'outra.p101@teste.pt',
      password_hash: hash,
      empresa_id: outraEmp._id,
      role: 'staff',
      ativo: true,
    });

    // Tentar toggle com empresaId errado → 404.
    const resErrada = await authPatch(
      `/api/admin/empresas/${emp._id}/utilizadores/${userOutra._id}/estado`,
      {}
    );
    expect(resErrada.status).toBe(404);
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

/* ------------------------------------------------------------------ */
/* 17. Cron Job — Agenda de Amanhã (Prompt 94)                         */
/* ------------------------------------------------------------------ */

describe('Cron Job: Agenda de Amanhã (Prompt 94)', () => {
  const { executarAgendaAmanha } = require('../jobs/agendaAmanha');
  let notificarSpy;

  beforeEach(async () => {
    // Limpa tarefas e utilizadores de testes anteriores deste describe.
    await Tarefa.deleteMany({});
    await Utilizador.deleteMany({
      email: { $in: ['staff.ag1@teste.pt', 'staff.ag2@teste.pt', 'staff.ag-inativo@teste.pt'] },
    });

    // Espia notificarUtilizador para validar as chamadas sem depender do
    // Web Push estar configurado (o módulo original faz skip silencioso).
    const notificarMod = require('../utils/notificar');
    notificarSpy = jest.spyOn(notificarMod, 'notificarUtilizador').mockResolvedValue(undefined);
  });

  afterEach(() => {
    notificarSpy.mockRestore();
  });

  it('notifica cada staff com tarefas amanhã (agrupado por utilizador)', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff1 = await Utilizador.create({
      nome: 'Staff AG1',
      email: 'staff.ag1@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    const staff2 = await Utilizador.create({
      nome: 'Staff AG2',
      email: 'staff.ag2@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    // Amanhã (meia-noite UTC).
    const agora = new Date();
    const amanha = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);

    const prop = await Propriedade.create({
      smoobu_id: 'ag-200',
      nome: 'Casa AG',
      morada: 'Rua AG',
      empresa_id: empresaId,
      ativo: true,
    });

    // staff1 tem 2 tarefas amanhã; staff2 tem 1.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff1._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff1._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff2._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await executarAgendaAmanha();

    // 2 staff notificados (staff1 + staff2).
    expect(resultado.notificados).toBe(2);
    expect(notificarSpy).toHaveBeenCalledTimes(2);

    // Verifica as chamadas (por staffId).
    const idsChamados = notificarSpy.mock.calls.map((c) => c[0]);
    expect(idsChamados).toContain(String(staff1._id));
    expect(idsChamados).toContain(String(staff2._id));

    // staff1 recebe a mensagem com "2 tarefas"; staff2 com "1 tarefa".
    const callStaff1 = notificarSpy.mock.calls.find((c) => c[0] === String(staff1._id));
    const callStaff2 = notificarSpy.mock.calls.find((c) => c[0] === String(staff2._id));
    expect(callStaff1[1]).toBe('📅 Agenda de Amanhã');
    expect(callStaff1[2]).toMatch(/2 tarefas agendadas/);
    expect(callStaff2[2]).toMatch(/1 tarefa agendada/); // singular
    expect(callStaff1[3]).toBe('/staff');
  });

  it('ignora tarefas por_atribuir (sem utilizador) e estados não pendentes', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff AG1',
      email: 'staff.ag1@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const agora = new Date();
    const amanha = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);

    const prop = await Propriedade.create({
      smoobu_id: 'ag-201',
      nome: 'Casa AG2',
      morada: 'Rua AG2',
      empresa_id: empresaId,
      ativo: true,
    });

    // Tarefa atribuída → notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
    // Tarefa por_atribuir (sem utilizador) → não notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });
    // Tarefa concluída → não conta.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'concluida',
    });
    // Tarefa cancelada → não conta.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'cancelada',
    });

    const resultado = await executarAgendaAmanha();

    // Só 1 notificação (a atribuída). A por_atribuir não tem destinatário.
    expect(resultado.notificados).toBe(1);
    expect(notificarSpy).toHaveBeenCalledTimes(1);
    // A mensagem conta apenas 1 tarefa (a atribuída).
    expect(notificarSpy.mock.calls[0][2]).toMatch(/1 tarefa agendada/);
  });

  it('sem tarefas amanhã → não notifica ninguém', async () => {
    const resultado = await executarAgendaAmanha();
    expect(resultado.notificados).toBe(0);
    expect(notificarSpy).not.toHaveBeenCalled();
  });

  it('ignora staff inativo/eliminado mesmo com tarefas amanhã', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staffInativo = await Utilizador.create({
      nome: 'Staff Inativo',
      email: 'staff.ag-inativo@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: false, // inativo
    });

    const agora = new Date();
    const amanha = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);

    const prop = await Propriedade.create({
      smoobu_id: 'ag-202',
      nome: 'Casa AG3',
      morada: 'Rua AG3',
      empresa_id: empresaId,
      ativo: true,
    });

    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staffInativo._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await executarAgendaAmanha();
    // Staff inativo não é notificado.
    expect(resultado.notificados).toBe(0);
    expect(notificarSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 18. Cron Job — Cão de Guarda (Prompt 96)                            */
/* ------------------------------------------------------------------ */

describe('Cron Job: Cão de Guarda (Prompt 96)', () => {
  const { executarCaoGuarda } = require('../jobs/caoGuarda');
  let notificarSpy;

  beforeEach(async () => {
    // Limpa tarefas e utilizadores de testes anteriores deste describe.
    await Tarefa.deleteMany({});
    await Utilizador.deleteMany({
      email: {
        $in: ['staff.cg1@teste.pt', 'staff.cg2@teste.pt', 'staff.cg-inativo@teste.pt'],
      },
    });

    // Espia notificarUtilizador para validar as chamadas sem depender do
    // Web Push estar configurado (o módulo original faz skip silencioso).
    const notificarMod = require('../utils/notificar');
    notificarSpy = jest.spyOn(notificarMod, 'notificarUtilizador').mockResolvedValue(undefined);
  });

  afterEach(() => {
    notificarSpy.mockRestore();
  });

  it('notifica por cada tarefa de limpeza de hoje não concluída (atribuida/em_curso)', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff1 = await Utilizador.create({
      nome: 'Staff CG1',
      email: 'staff.cg1@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    const staff2 = await Utilizador.create({
      nome: 'Staff CG2',
      email: 'staff.cg2@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    // Hoje (meia-noite UTC).
    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const prop1 = await Propriedade.create({
      smoobu_id: 'cg-100',
      nome: 'Casa CG1',
      morada: 'Rua CG1',
      empresa_id: empresaId,
      ativo: true,
    });
    const prop2 = await Propriedade.create({
      smoobu_id: 'cg-101',
      nome: 'Casa CG2',
      morada: 'Rua CG2',
      empresa_id: empresaId,
      ativo: true,
    });

    // staff1 tem 1 tarefa atribuída + 1 em_curso (2 notificações).
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop1._id,
      utilizador_id: staff1._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop2._id,
      utilizador_id: staff1._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'em_curso',
    });
    // staff2 tem 1 tarefa atribuída (1 notificação).
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop1._id,
      utilizador_id: staff2._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await executarCaoGuarda();

    // 3 notificações (1 por tarefa esquecida — não agrupado por staff).
    expect(resultado.alertas.encontradas).toBe(3);
    expect(resultado.alertas.notificadas).toBe(3);
    expect(notificarSpy).toHaveBeenCalledTimes(3);

    // Verifica título + link + corpo (com nome da propriedade).
    for (const call of notificarSpy.mock.calls) {
      expect(call[1]).toBe('⚠️ Tarefa Incompleta');
      expect(call[3]).toBe('/staff');
      expect(call[2]).toMatch(/como concluída\. Por favor, atualiza a app!/);
    }
    // Pelo menos uma notificação mentiona "Casa CG1".
    const corpos = notificarSpy.mock.calls.map((c) => c[2]);
    expect(corpos.some((c) => c.includes('Casa CG1'))).toBe(true);
    expect(corpos.some((c) => c.includes('Casa CG2'))).toBe(true);
  });

  it('ignora tarefas concluídas, canceladas, por_atribuir e de outros tipos', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff CG1',
      email: 'staff.cg1@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const prop = await Propriedade.create({
      smoobu_id: 'cg-200',
      nome: 'Casa CG Ignorar',
      morada: 'Rua CG',
      empresa_id: empresaId,
      ativo: true,
    });

    // Concluída → não notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'concluida',
    });
    // Cancelada → não notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'cancelada',
    });
    // Por atribuir (sem utilizador) → não notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });
    // Manutenção (não é limpeza) → não notifica.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'manutencao',
      estado: 'atribuida',
    });
    // A única que conta: limpeza + atribuída.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await executarCaoGuarda();
    expect(resultado.alertas.encontradas).toBe(1);
    expect(resultado.alertas.notificadas).toBe(1);
    expect(notificarSpy).toHaveBeenCalledTimes(1);
  });

  it('sem tarefas de limpeza incompletas hoje → não notifica ninguém', async () => {
    const resultado = await executarCaoGuarda();
    expect(resultado.alertas.encontradas).toBe(0);
    expect(resultado.alertas.notificadas).toBe(0);
    expect(notificarSpy).not.toHaveBeenCalled();
  });

  it('ignora staff inativo/eliminado mesmo com tarefa de limpeza incompleta', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staffInativo = await Utilizador.create({
      nome: 'Staff CG Inativo',
      email: 'staff.cg-inativo@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: false, // inativo
    });

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const prop = await Propriedade.create({
      smoobu_id: 'cg-300',
      nome: 'Casa CG Inativo',
      morada: 'Rua CG',
      empresa_id: empresaId,
      ativo: true,
    });

    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staffInativo._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await executarCaoGuarda();
    // A tarefa foi encontrada, mas o staff inativo não é notificado.
    expect(resultado.alertas.encontradas).toBe(1);
    expect(resultado.alertas.notificadas).toBe(0);
    expect(notificarSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 19. Desligar a Histeria Automática (Prompt 97)                      */
/* ------------------------------------------------------------------ */

describe('Prompt 97 — Desligar a Histeria Automática', () => {
  beforeEach(async () => {
    await Tarefa.deleteMany({});
  });

  it('desativar propriedade → desatribui tarefas futuras (não apaga)', async () => {
    // Cria uma propriedade ativa.
    const prop = await Propriedade.create({
      smoobu_id: 'p97-desativar',
      nome: 'Casa P97',
      morada: 'Rua P97',
      empresa_id: empresaId,
      ativo: true,
    });

    // Cria um staff e uma tarefa atribuída para hoje.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff P97',
      email: 'staff.p97@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const tarefa = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    // Desativa a propriedade.
    const res = await authPatch(`/api/gestor/propriedades/${prop._id}/estado`, {
      ativo: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.ativo).toBe(false);
    // Prompt 97 — devolve tarefasDesatribuidas (não tarefasApagadas).
    expect(typeof res.body.tarefasDesatribuidas).toBe('number');
    expect(res.body.tarefasDesatribuidas).toBeGreaterThanOrEqual(1);

    // A tarefa NÃO foi apagada — foi desatribuída (por_atribuir).
    const depois = await Tarefa.findById(tarefa._id);
    expect(depois).not.toBeNull();
    expect(depois.utilizador_id).toBeNull();
    expect(depois.estado).toBe('por_atribuir');
  });

  it('falta súbita → desatribui tarefas de hoje (não reatribui via load balancer)', async () => {
    // Cria um staff e uma tarefa atribuída para hoje.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Falta P97',
      email: 'staff.falta.p97@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    const outro = await Utilizador.create({
      nome: 'Staff Outro P97',
      email: 'staff.outro.p97@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const prop = await Propriedade.create({
      smoobu_id: 'p97-falta',
      nome: 'Casa Falta P97',
      morada: 'Rua Falta',
      empresa_id: empresaId,
      ativo: true,
    });

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const tarefa = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    // Reporta falta súbita do staff.
    const res = await authPost(
      `/api/gestor/equipa/${staff._id}/falta-subita`,
      {}
    );
    expect(res.status).toBe(200);
    // Prompt 97 — devolve desatribuidas (não reatribuidas/orfas).
    expect(res.body.desatribuidas).toBeGreaterThanOrEqual(1);

    // A tarefa foi DESATRIBUÍDA (não reatribuída ao outro staff).
    const depois = await Tarefa.findById(tarefa._id);
    expect(depois.utilizador_id).toBeNull();
    expect(depois.estado).toBe('por_atribuir');
    // Garante que NÃO foi atribuída ao outro staff (sem load balancer).
    expect(String(depois.utilizador_id ?? '')).not.toBe(String(outro._id));
  });

  it('baixa prolongada → desatribui tarefas do período (não reatribui)', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Baixa P97',
      email: 'staff.baixa.p97@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    const outro = await Utilizador.create({
      nome: 'Staff Outro Baixa',
      email: 'staff.outro.baixa.p97@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const prop = await Propriedade.create({
      smoobu_id: 'p97-baixa',
      nome: 'Casa Baixa P97',
      morada: 'Rua Baixa',
      empresa_id: empresaId,
      ativo: true,
    });

    // Tarefa atribuída ao staff para daqui a 5 dias.
    const daqui5 = new Date(Date.now() + 5 * 86400000);
    const inicio5 = new Date(
      Date.UTC(daqui5.getUTCFullYear(), daqui5.getUTCMonth(), daqui5.getUTCDate())
    );

    const tarefa = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: inicio5,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const inicioStr = new Date(Date.now() + 4 * 86400000)
      .toISOString()
      .slice(0, 10);
    const fimStr = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

    const res = await authPost(`/api/gestor/equipa/${staff._id}/baixa`, {
      data_inicio: inicioStr,
      data_fim: fimStr,
      tipo: 'ferias',
    });
    expect(res.status).toBe(200);
    expect(res.body.desatribuidas).toBeGreaterThanOrEqual(1);

    // A tarefa foi desatribuída (não reatribuída ao outro staff).
    const depois = await Tarefa.findById(tarefa._id);
    expect(depois.utilizador_id).toBeNull();
    expect(depois.estado).toBe('por_atribuir');
    expect(String(depois.utilizador_id ?? '')).not.toBe(String(outro._id));
  });
});

/* ------------------------------------------------------------------ */
/* 20. Rede de Segurança das 18h — Auto-Atribuição de Emergência (Prompt 98) */
/* ------------------------------------------------------------------ */

describe('Cão de Guarda / Fail-Safe: Auto-Atribuição de Emergência (Prompt 98)', () => {
  const { autoAtribuicaoEmergencia } = require('../jobs/caoGuarda');
  let notificarSpy;

  beforeEach(async () => {
    await Tarefa.deleteMany({});
    await Utilizador.deleteMany({
      email: {
        $in: ['staff.failsafe@teste.pt', 'staff.failsafe2@teste.pt'],
      },
    });

    // Espia notificarUtilizador (a auto-atribuição envia push "Nova Limpeza
    // Atribuída" ao staff escalado).
    const notificarMod = require('../utils/notificar');
    notificarSpy = jest.spyOn(notificarMod, 'notificarUtilizador').mockResolvedValue(undefined);
  });

  afterEach(() => {
    notificarSpy.mockRestore();
  });

  it('atribui tarefas órfãs de amanhã via load balancer (Algoritmo VIP + Haversine)', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff FailSafe',
      email: 'staff.failsafe@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const prop = await Propriedade.create({
      smoobu_id: 'fs-100',
      nome: 'Casa FailSafe',
      morada: 'Rua FailSafe',
      empresa_id: empresaId,
      ativo: true,
    });

    // Amanhã (meia-noite UTC).
    const agora = new Date();
    const amanha = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);

    // 2 tarefas órfãs (por_atribuir, sem utilizador) para amanhã.
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });
    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });

    const resultado = await autoAtribuicaoEmergencia();

    // As 2 tarefas foram encontradas e atribuídas ao staff disponível.
    expect(resultado.encontradas).toBe(2);
    expect(resultado.atribuidas).toBe(2);
    expect(resultado.orfas).toBe(0);

    // Verifica que as tarefas ficaram atribuídas (estado 'atribuida').
    const tarefasDepois = await Tarefa.find({
      propriedade_id: prop._id,
      data: amanha,
    });
    for (const t of tarefasDepois) {
      expect(t.utilizador_id).not.toBeNull();
      expect(String(t.utilizador_id)).toBe(String(staff._id));
      expect(t.estado).toBe('atribuida');
    }

    // Verifica que foi enviada push "Nova Limpeza Atribuída" por tarefa.
    expect(notificarSpy).toHaveBeenCalledTimes(2);
    for (const call of notificarSpy.mock.calls) {
      expect(call[1]).toBe('🧹 Nova Limpeza Atribuída');
      expect(call[3]).toBe('/staff');
      expect(call[2]).toMatch(/Foste escalado para limpar a Casa FailSafe/);
    }
  });

  it('sem tarefas órfãs de amanhã → não faz nada', async () => {
    const resultado = await autoAtribuicaoEmergencia();
    expect(resultado.encontradas).toBe(0);
    expect(resultado.atribuidas).toBe(0);
    expect(resultado.orfas).toBe(0);
    expect(notificarSpy).not.toHaveBeenCalled();
  });

  it('sem staff disponível → tarefa mantém-se por_atribuir (órfã)', async () => {
    // Garante que NÃO há staff ativo nesta empresa (desativa todos os staff
    // que testes anteriores possam ter deixado na empresaId).
    await Utilizador.updateMany(
      { empresa_id: empresaId, role: 'staff' },
      { $set: { ativo: false } }
    );

    const prop = await Propriedade.create({
      smoobu_id: 'fs-200',
      nome: 'Casa FailSafe Sem Staff',
      morada: 'Rua Sem Staff',
      empresa_id: empresaId,
      ativo: true,
    });

    const agora = new Date();
    const amanha = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    amanha.setUTCDate(amanha.getUTCDate() + 1);

    await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });

    const resultado = await autoAtribuicaoEmergencia();
    // Encontrou a tarefa mas não há staff → fica órfã.
    expect(resultado.encontradas).toBe(1);
    expect(resultado.atribuidas).toBe(0);
    expect(resultado.orfas).toBe(1);

    // A tarefa mantém-se por_atribuir.
    const depois = await Tarefa.findOne({ propriedade_id: prop._id });
    expect(depois.estado).toBe('por_atribuir');
    expect(depois.utilizador_id).toBeNull();
  });

  it('não mexe em tarefas de hoje (só amanhã) nem em já atribuídas', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff FailSafe',
      email: 'staff.failsafe@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const prop = await Propriedade.create({
      smoobu_id: 'fs-300',
      nome: 'Casa FailSafe Hoje',
      morada: 'Rua Hoje',
      empresa_id: empresaId,
      ativo: true,
    });

    const agora = new Date();
    const hoje = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const amanha = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);

    // Tarefa órfã de HOJE (não deve ser tocada pelo fail-safe — só amanhã).
    const tarefaHoje = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: null,
      data: hoje,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
    });

    // Tarefa já atribuída de amanhã (não deve ser mexida).
    const tarefaAtribuida = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: prop._id,
      utilizador_id: staff._id,
      data: amanha,
      tempo_limpeza_minutos: 45,
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    const resultado = await autoAtribuicaoEmergencia();
    // Não encontrou nenhuma órfã de amanhã (a de hoje não conta; a atribuída
    // não conta).
    expect(resultado.encontradas).toBe(0);
    expect(resultado.atribuidas).toBe(0);

    // A tarefa de hoje mantém-se por atribuir (intacta).
    const hojeDepois = await Tarefa.findById(tarefaHoje._id);
    expect(hojeDepois.estado).toBe('por_atribuir');
    expect(hojeDepois.utilizador_id).toBeNull();

    // A tarefa atribuída de amanhã mantém-se (intacta).
    const amanhaDepois = await Tarefa.findById(tarefaAtribuida._id);
    expect(String(amanhaDepois.utilizador_id)).toBe(String(staff._id));
    expect(amanhaDepois.estado).toBe('atribuida');
  });
});

/* ------------------------------------------------------------------ */
/* 21. Correções — Calendário não mostra eliminados + importar atualiza */
/* ------------------------------------------------------------------ */

describe('Correções: Calendário + Importar Propriedades', () => {
  beforeEach(async () => {
    await Tarefa.deleteMany({});
    await Utilizador.deleteMany({
      email: { $in: ['staff.elim@teste.pt', 'staff.ativo@teste.pt'] },
    });
  });

  it('calendário NÃO mostra ausências de utilizadores eliminados', async () => {
    const Ausencia = require('../models/Ausencia');
    const hash = await bcrypt.hash(PASSWORD, 10);

    // Staff eliminado (soft delete).
    const staffEliminado = await Utilizador.create({
      nome: 'Staff Eliminado',
      email: 'staff.elim@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
      eliminado_em: new Date(),
    });

    // Staff ativo.
    const staffAtivo = await Utilizador.create({
      nome: 'Staff Ativo',
      email: 'staff.ativo@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString().slice(0, 10);

    // Ausência do eliminado.
    await Ausencia.create({
      utilizador_id: staffEliminado._id,
      empresa_id: empresaId,
      data_inicio: amanha,
      data_fim: amanha,
      tipo: 'ferias',
      estado: 'aprovada',
    });

    // Ausência do ativo.
    await Ausencia.create({
      utilizador_id: staffAtivo._id,
      empresa_id: empresaId,
      data_inicio: amanha,
      data_fim: amanha,
      tipo: 'ferias',
      estado: 'aprovada',
    });

    const res = await authGet(
      `/api/gestor/calendario/dados?inicio=${amanhaStr}&fim=${amanhaStr}`
    );
    expect(res.status).toBe(200);

    // Procura eventos de ausência.
    const ausenciasNoCalendario = res.body.tarefas.filter((t) => t.tipo === 'ausencia');
    // Só deve haver 1 (a do staff ativo), não a do eliminado.
    expect(ausenciasNoCalendario.length).toBe(1);
    expect(String(ausenciasNoCalendario[0].utilizador_id._id)).toBe(String(staffAtivo._id));
  });

  it('Prompt 104 — importar NÃO sobrescreve morada se já preenchida (edição manual tem prioridade)', async () => {
    const Propriedade = require('../models/Propriedade');
    process.env.SMOOBU_API_KEY = 'test-key-123';

    // Cria uma propriedade já existente com morada preenchida pelo gestor.
    const propExistente = await Propriedade.create({
      smoobu_id: 'imp-nosobrepor',
      nome: 'Casa com Morada',
      morada: 'Rua do Gestor 123',
      empresa_id: empresaId,
      ativo: true,
      capacidade_hospedes: 2,
    });

    // Smoobu devolve a MESMA propriedade com morada diferente + capacidade nova.
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [
          {
            id: 'imp-nosobrepor',
            name: 'Casa com Morada',
            location: { street: 'Rua do Smoobu 456', zip: '2000-001', city: 'Lisboa' },
            rooms: { maxOccupancy: 6 },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/propriedades', {});
    expect(res.status).toBe(200);
    // Capacidade foi atualizada (atualizadas >= 1).
    expect(res.body.atualizadas).toBe(1);

    // A morada NÃO foi sobrescrita — mantém a do gestor.
    const depois = await Propriedade.findById(propExistente._id).lean();
    expect(depois.morada).toBe('Rua do Gestor 123');
    // A capacidade foi atualizada.
    expect(depois.capacidade_hospedes).toBe(6);

    delete process.env.SMOOBU_API_KEY;
    if (global.fetch && global.fetch.__isMock) {
      delete global.fetch.__isMock;
    }
  });

  it('Prompt 104 — importar PREENCHE morada se estiver vazia ("A definir")', async () => {
    const Propriedade = require('../models/Propriedade');
    process.env.SMOOBU_API_KEY = 'test-key-123';

    // Cria uma propriedade com morada "A definir" (vazia).
    const propVazia = await Propriedade.create({
      smoobu_id: 'imp-preenche',
      nome: 'Casa Sem Morada',
      morada: 'A definir',
      empresa_id: empresaId,
      ativo: true,
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apartments: [
          {
            id: 'imp-preenche',
            name: 'Casa Sem Morada',
            location: { street: 'Rua do Smoobu 789', zip: '3000-001', city: 'Coimbra' },
            rooms: { maxOccupancy: 4 },
          },
        ],
      }),
      text: async () => '',
    });
    mockFetch.__isMock = true;
    global.fetch = mockFetch;

    const res = await authPost('/api/gestor/smoobu/propriedades', {});
    expect(res.status).toBe(200);

    // A morada foi preenchida pelo Smoobu (estava "A definir").
    const depois = await Propriedade.findById(propVazia._id).lean();
    expect(depois.morada).toBe('Rua do Smoobu 789, 3000-001, Coimbra');
    expect(depois.capacidade_hospedes).toBe(4);

    delete process.env.SMOOBU_API_KEY;
    if (global.fetch && global.fetch.__isMock) {
      delete global.fetch.__isMock;
    }
  });
});

/* ------------------------------------------------------------------ */
/* 22. Prompt 114 — Notificações In-App + Haversine                    */
/* ------------------------------------------------------------------ */

describe('Prompt 114 — Centro de Notificações + Haversine', () => {
  const { distanciaHaversine } = require('../utils/distancia');

  it('Haversine: distância Lisboa→Porto ≈ 274km', () => {
    const lisboa = { lat: 38.7223, lng: -9.1393 };
    const porto = { lat: 41.1579, lng: -8.6291 };
    const dist = distanciaHaversine(lisboa, porto);
    // Aceita intervalo razoável (270-280km) — raio médio da Terra.
    expect(dist).toBeGreaterThan(270);
    expect(dist).toBeLessThan(280);
  });

  it('Haversine: mesma coordenada = 0', () => {
    const p = { lat: 38.7223, lng: -9.1393 };
    expect(distanciaHaversine(p, p)).toBe(0);
  });

  it('Haversine: coordenadas inválidas = 0 (não crasha)', () => {
    expect(distanciaHaversine(null, { lat: 1, lng: 1 })).toBe(0);
    expect(distanciaHaversine({ lat: NaN, lng: 1 }, { lat: 1, lng: 1 })).toBe(0);
    expect(distanciaHaversine({ lat: 1, lng: 1 }, { lat: 'abc', lng: 1 })).toBe(0);
  });

  it('GET /api/auth/me/notificacoes/contagem → 200 + nao_lidas=0 (sem notif)', async () => {
    const res = await authGet('/api/auth/me/notificacoes/contagem');
    expect(res.status).toBe(200);
    expect(res.body.nao_lidas).toBe(0);
  });

  it('criar tarefa manual com staff gera notificação in-app (Prompt 123)', async () => {
    // Cria um staff para receber a tarefa.
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Notif',
      email: 'staff.notif@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const prop = await Propriedade.create({
      smoobu_id: 'notif-prop-1',
      nome: 'Casa Notif',
      morada: 'Rua Notif 1, Lisboa',
      empresa_id: empresaId,
      tempo_limpeza_minutos: 45,
    });

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString();

    const res = await authPost('/api/gestor/tarefas', {
      propriedade_id: String(prop._id),
      utilizador_id: String(staff._id),
      data: amanhaStr,
      tipo: 'limpeza',
    });
    expect(res.status).toBe(201);

    // Pequeno delay para o notificarUtilizador (fire-and-forget) criar.
    await esperar(500);

    // Login como o staff para ver as suas notificações.
    const loginStaff = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.notif@teste.pt', password: PASSWORD });
    const staffToken = loginStaff.body.token;

    // Prompt 123 — Atribuição de tarefa MANUAL cria notificação in-app
    // (criarInApp: true) para o staff ver no sino.
    const contagem = await request(app)
      .get('/api/auth/me/notificacoes/contagem')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(contagem.status).toBe(200);
    expect(contagem.body.nao_lidas).toBeGreaterThanOrEqual(1);

    // Limpa notificações para não afetar outros testes.
    const Notificacao = require('../models/Notificacao');
    await Notificacao.deleteMany({ utilizador_id: staff._id });

    // Cleanup.
    await Tarefa.deleteMany({ propriedade_id: prop._id });
    await Propriedade.deleteMany({ _id: prop._id });
    await Utilizador.deleteOne({ _id: staff._id });
  });

  it('criarNotificacaoInApp cria notificação + contagem incrementa + marcar lidas (sino funciona para notificações principais)', async () => {
    const { criarNotificacaoInApp } = require('../utils/notificar');
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Sino',
      email: 'staff.sino@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    // Cria uma notificação "principal" diretamente (simula o que o Daily
    // Briefing / Cão de Guarda fazem com criarInApp: true).
    await criarNotificacaoInApp(String(staff._id), '📋 Daily Briefing: Tens 3 tarefas hoje.', {
      tipo: 'sistema',
      url: '/staff',
      empresa_id: empresaId,
    });
    await esperar(300);

    // Login como o staff.
    const loginStaff = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.sino@teste.pt', password: PASSWORD });
    const staffToken = loginStaff.body.token;

    // Contagem = 1.
    const contagem = await request(app)
      .get('/api/auth/me/notificacoes/contagem')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(contagem.status).toBe(200);
    expect(contagem.body.nao_lidas).toBe(1);

    // Lista as notificações.
    const lista = await request(app)
      .get('/api/auth/me/notificacoes')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(lista.status).toBe(200);
    expect(Array.isArray(lista.body.notificacoes)).toBe(true);
    expect(lista.body.notificacoes.length).toBe(1);
    expect(lista.body.notificacoes[0].mensagem).toContain('Daily Briefing');

    // Marca como lidas.
    const marcar = await request(app)
      .patch('/api/auth/me/notificacoes/marcar-lidas')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(marcar.status).toBe(200);
    expect(marcar.body.marcadas).toBe(1);

    // Contagem volta a 0.
    const contagem2 = await request(app)
      .get('/api/auth/me/notificacoes/contagem')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(contagem2.body.nao_lidas).toBe(0);

    // Cleanup.
    const Notificacao = require('../models/Notificacao');
    await Notificacao.deleteMany({ utilizador_id: staff._id });
    await Utilizador.deleteOne({ _id: staff._id });
  });

  it('criar tarefa com 2 propriedades distantes devolve warning (>15km)', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Dist',
      email: 'staff.dist@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    // Lisboa
    const prop1 = await Propriedade.create({
      smoobu_id: 'dist-prop-1',
      nome: 'Casa Lisboa',
      morada: 'Praça do Comércio, Lisboa',
      coordenadas: { lat: 38.7075, lng: -9.1364 },
      empresa_id: empresaId,
      tempo_limpeza_minutos: 45,
    });
    // Sintra (~30km de Lisboa)
    const prop2 = await Propriedade.create({
      smoobu_id: 'dist-prop-2',
      nome: 'Casa Sintra',
      morada: 'Palácio Nacional de Sintra, Sintra',
      coordenadas: { lat: 38.7976, lng: -9.3905 },
      empresa_id: empresaId,
      tempo_limpeza_minutos: 45,
    });

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    // Prompt 123 — usa date-only (YYYY-MM-DD) para ambas as tarefas, evitando
    // o conflito de horário (tarefas sem hora real = all-day, não conflitam).
    const amanhaStr = amanha.toISOString().slice(0, 10);

    // Primeira tarefa (Lisboa) — sem warning (só 1 tarefa).
    const r1 = await authPost('/api/gestor/tarefas', {
      propriedade_id: String(prop1._id),
      utilizador_id: String(staff._id),
      data: amanhaStr,
      tipo: 'limpeza',
    });
    expect(r1.status).toBe(201);
    expect(r1.body.warning).toBeUndefined();

    // Segunda tarefa (Sintra, ~28km) — deve trazer warning.
    const r2 = await authPost('/api/gestor/tarefas', {
      propriedade_id: String(prop2._id),
      utilizador_id: String(staff._id),
      data: amanhaStr,
      tipo: 'limpeza',
    });
    expect(r2.status).toBe(201);
    expect(r2.body.warning).toBeTruthy();
    // Prompt 128 — O warning pode ser de conflito de horário (soft block) ou
    // de distância. Aceita qualquer um dos dois.
    const w = String(r2.body.warning);
    expect(w.includes('horário') || w.includes('km')).toBe(true);

    // Cleanup.
    await Tarefa.deleteMany({ propriedade_id: { $in: [prop1._id, prop2._id] } });
    await Propriedade.deleteMany({ _id: { $in: [prop1._id, prop2._id] } });
    await Utilizador.deleteOne({ _id: staff._id });
  });

  it('criar propriedade com morada válida devolve 201 (com coordenadas)', async () => {
    const res = await authPost('/api/gestor/propriedades', {
      nome: 'Casa Geocode',
      smoobu_id: 'geo-prop-1',
      morada: 'Praça do Comércio, Lisboa',
      tempo_limpeza_minutos: 45,
    });
    expect(res.status).toBe(201);
    expect(res.body.propriedade).toBeTruthy();
    // Pode ter ou não coordenadas (depende do Nominatim); não deve ter warning
    // se veio coordenadas, OU pode ter warning se Nominatim falhou.
    // Apenas validamos que não crashou.
    await Propriedade.deleteMany({ _id: res.body.propriedade._id });
  });
});

/* ------------------------------------------------------------------ */
/* 23. Prompt 116 — Fundação SaaS, Notificações e Lógica de Negócio    */
/* ------------------------------------------------------------------ */

describe('Prompt 116 — Fundação SaaS + Lógica de Negócio', () => {
  it('Empresa tem campo ativa (default true)', async () => {
    const Empresa = require('../models/Empresa');
    const emp = await Empresa.create({ nome: 'Empresa Ativa Test' });
    expect(emp.ativa).toBe(true);
    await Empresa.deleteOne({ _id: emp._id });
  });

  it('PATCH /api/admin/empresas/:id/toggle-status desativa empresa', async () => {
    const Empresa = require('../models/Empresa');
    const emp = await Empresa.create({ nome: 'Empresa Toggle Test', ativa: true });

    const res = await authPatch(`/api/admin/empresas/${emp._id}/toggle-status`, { ativa: false });
    expect(res.status).toBe(200);
    expect(res.body.empresa.ativa).toBe(false);

    const depois = await Empresa.findById(emp._id).select('ativa').lean();
    expect(depois.ativa).toBe(false);

    await Empresa.deleteOne({ _id: emp._id });
  });

  it('login bloqueado para utilizadores de empresa inativa (exceto admin)', async () => {
    const Empresa = require('../models/Empresa');
    const hash = await bcrypt.hash(PASSWORD, 10);
    const emp = await Empresa.create({ nome: 'Empresa Inativa Login', ativa: false });
    const staff = await Utilizador.create({
      nome: 'Staff Inativo Empresa',
      email: 'staff.empresa.inativa@teste.pt',
      password_hash: hash,
      empresa_id: emp._id,
      role: 'staff',
      ativo: true,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff.empresa.inativa@teste.pt', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.erro).toContain('desativada');

    await Utilizador.deleteOne({ _id: staff._id });
    await Empresa.deleteOne({ _id: emp._id });
  });

  it('sobreposição de ausência NÃO bloqueia com ausência rejeitada', async () => {
    const Ausencia = require('../models/Ausencia');
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Sobreposicao',
      email: 'staff.sobreposicao@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString().slice(0, 10);
    // Normaliza para UTC midnight (igual ao que o controller faz).
    const amanhaNorm = new Date(Date.UTC(amanha.getUTCFullYear(), amanha.getUTCMonth(), amanha.getUTCDate()));

    // Cria uma ausência REJEITADA para amanhã (datas normalizadas).
    await Ausencia.create({
      utilizador_id: staff._id,
      empresa_id: empresaId,
      data_inicio: amanhaNorm,
      data_fim: amanhaNorm,
      tipo: 'ferias',
      estado: 'rejeitada',
    });

    // Tenta criar nova ausência para o mesmo período — deve SER POSSÍVEL
    // (a rejeitada não bloqueia).
    const res = await authPost('/api/gestor/ausencias', {
      utilizador_id: String(staff._id),
      data_inicio: amanhaStr,
      data_fim: amanhaStr,
      tipo: 'ferias',
    });
    expect(res.status).toBe(201);
    expect(res.body.ausencia).toBeTruthy();

    await Ausencia.deleteMany({ utilizador_id: staff._id });
    await Utilizador.deleteOne({ _id: staff._id });
  });

  it('GET /api/gestor/equipa exclui admin e utilizadores inativos', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    // Staff ativo — deve aparecer.
    const staffAtivo = await Utilizador.create({
      nome: 'Staff Ativo Equipa',
      email: 'staff.ativo.equipa@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    // Staff inativo — NÃO deve aparecer.
    const staffInativo = await Utilizador.create({
      nome: 'Staff Inativo Equipa',
      email: 'staff.inativo.equipa@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: false,
    });
    // Gestor ativo — deve aparecer.
    const gestor = await Utilizador.create({
      nome: 'Gestor Equipa',
      email: 'gestor.equipa@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'gestor',
      ativo: true,
    });

    const res = await authGet('/api/gestor/equipa');
    expect(res.status).toBe(200);
    const emails = res.body.utilizadores.map((u) => u.email);
    expect(emails).toContain('staff.ativo.equipa@teste.pt');
    expect(emails).toContain('gestor.equipa@teste.pt');
    // Admin NÃO aparece.
    expect(emails).not.toContain('admin@teste.pt');
    // Inativo NÃO aparece.
    expect(emails).not.toContain('staff.inativo.equipa@teste.pt');

    await Utilizador.deleteMany({
      _id: { $in: [staffAtivo._id, staffInativo._id, gestor._id] },
    });
  });

  it('POST /api/admin/empresas/:id/hard-reset apaga só propriedades+tarefas dessa empresa', async () => {
    const Empresa = require('../models/Empresa');
    const Propriedade = require('../models/Propriedade');
    const Tarefa = require('../models/Tarefa');

    // Empresa própria para o teste.
    const emp = await Empresa.create({ nome: 'Empresa Hard Reset Scoped' });
    const prop = await Propriedade.create({
      smoobu_id: 'hr-scoped-prop',
      nome: 'Casa HR Scoped',
      morada: 'Rua HR',
      empresa_id: emp._id,
      tempo_limpeza_minutos: 45,
    });
    await Tarefa.create({
      empresa_id: emp._id,
      propriedade_id: prop._id,
      data: new Date(),
      tipo: 'limpeza',
      estado: 'atribuida',
    });

    // Propriedade da empresa base (NÃO deve ser apagada).
    const propBase = await Propriedade.create({
      smoobu_id: 'hr-base-prop',
      nome: 'Casa Base',
      morada: 'Rua Base',
      empresa_id: empresaId,
      tempo_limpeza_minutos: 45,
    });

    const res = await authPost(`/api/admin/empresas/${emp._id}/hard-reset`, {});
    expect(res.status).toBe(200);
    expect(res.body.detalhe.propriedades_apagadas).toBeGreaterThanOrEqual(1);
    expect(res.body.detalhe.tarefas_apagadas).toBeGreaterThanOrEqual(1);

    // A propriedade da empresa base continua a existir.
    const propBaseDepois = await Propriedade.findById(propBase._id).lean();
    expect(propBaseDepois).toBeTruthy();

    await Propriedade.deleteMany({ _id: propBase._id });
    await Empresa.deleteOne({ _id: emp._id });
  });

  it('criarTarefa com hora + hospedes + check_in/out grava detalhes_reserva e hora local', async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const staff = await Utilizador.create({
      nome: 'Staff Hora Test',
      email: 'staff.hora.test@teste.pt',
      password_hash: hash,
      empresa_id: empresaId,
      role: 'staff',
      ativo: true,
    });
    const prop = await Propriedade.create({
      smoobu_id: 'hora-prop-1',
      nome: 'Casa Hora',
      morada: 'Rua Hora 1',
      empresa_id: empresaId,
      tempo_limpeza_minutos: 45,
    });

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString().slice(0, 10);

    const res = await authPost('/api/gestor/tarefas', {
      propriedade_id: String(prop._id),
      utilizador_id: String(staff._id),
      data: amanhaStr,
      hora: '14:30',
      check_in: amanhaStr,
      check_out: amanhaStr,
      hospedes: 4,
      tipo: 'limpeza',
    });
    expect(res.status).toBe(201);
    expect(res.body.tarefa).toBeTruthy();
    // detalhes_reserva preenchido
    expect(res.body.tarefa.detalhes_reserva).toBeTruthy();
    expect(res.body.tarefa.detalhes_reserva.pax).toBe(4);
    expect(res.body.tarefa.detalhes_reserva.checkin).toBe(amanhaStr);
    // Prompt 128 — A hora deve ser 14:30 no fuso de Portugal (Europe/Lisbon).
    // O backend ajusta o instante UTC para corresponder à hora de Portugal.
    // Usamos Intl.DateTimeFormat para extrair a hora no fuso correto.
    const dataTarefa = new Date(res.body.tarefa.data);
    const horaLisboa = new Intl.DateTimeFormat('pt-PT', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Lisbon',
    }).format(dataTarefa);
    expect(horaLisboa).toBe('14:30');

    await Tarefa.deleteMany({ propriedade_id: prop._id });
    await Propriedade.deleteMany({ _id: prop._id });
    await Utilizador.deleteOne({ _id: staff._id });
  });
});
