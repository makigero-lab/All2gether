/**
 * Smoobu com HMAC (obrigatório desde 31/10/2026): assinatura, segredo que nunca sai,
 * teste de ligação e «Apagar tarefas futuras» que não apaga sem ligação.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
  googleMapsAtivo: () => false,
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Auditoria = require('../models/Auditoria');
const { headersAssinados, queryCanonica, smoobuFetch } = require('../utils/smoobuApi');

let mongod;
let n = 0;
const hash = bcrypt.hashSync('p-de-teste-123', 4);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function cenario(smoobu = {}) {
  n++;
  const e = await Empresa.create({ nome: 'H' + n, integracoes: { smoobu: { api_key: 'chave' + n, ativo: true, ...smoobu } } });
  const ad = await Utilizador.create({ nome: 'ad', email: `ad${n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'admin', ativo: true, dias_folga: [] });
  const token = (await request(app).post('/api/auth/login').send({ email: ad.email, password: 'p-de-teste-123' })).body.token;
  return { e, token };
}

describe('assinatura HMAC', () => {
  test('canónica segue a documentação (query ordenada, hash do corpo vazio, base64)', () => {
    const h = headersAssinados({
      metodo: 'GET', caminho: '/api/reservations', query: { to: '2026-04-10', from: '2026-04-01' },
      chave: 'usr_live_abc123', segredo: 'your_api_secret',
      agora: new Date('2026-04-01T12:00:00.000Z'), nonce: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    });
    const canonica = 'GET\n/api/reservations\nfrom=2026-04-01&to=2026-04-10\n2026-04-01T12:00:00Z\n6ba7b810-9dad-11d1-80b4-00c04fd430c8\n'
      + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nusr_live_abc123';
    expect(h['X-Timestamp']).toBe('2026-04-01T12:00:00Z');
    expect(h['X-API-Key']).toBe('usr_live_abc123');
    expect(h['X-Signature']).toBe(crypto.createHmac('sha256', 'your_api_secret').update(canonica).digest('base64'));
  });

  test('query em RFC 3986 (espaço é %20 e [] é %5B%5D)', () => {
    expect(queryCanonica({ b: 'a b', 'a[]': 1 })).toBe('a%5B%5D=1&b=a%20b');
  });

  test('com segredo envia os 4 headers e não o Api-Key antigo; nonce nunca repete', async () => {
    const antigo = global.fetch;
    const pedidos = [];
    global.fetch = async (url, o) => { pedidos.push({ url, h: o.headers }); return { ok: true, status: 200 }; };
    try {
      await smoobuFetch({ chave: 'k', segredo: 's' }, '/api/apartments');
      await smoobuFetch({ chave: 'k', segredo: 's' }, '/api/apartments');
    } finally { global.fetch = antigo; }
    expect(pedidos[0].h['Api-Key']).toBeUndefined();
    for (const k of ['X-API-Key', 'X-Timestamp', 'X-Nonce', 'X-Signature']) expect(pedidos[0].h[k]).toBeTruthy();
    expect(pedidos[0].h['X-Nonce']).not.toBe(pedidos[1].h['X-Nonce']);
  });
});

describe('configurações', () => {
  test('o segredo grava-se mas nunca sai nas respostas', async () => {
    const { e, token } = await cenario();
    const put = await request(app).put('/api/gestor/configuracoes').set('Authorization', 'Bearer ' + token)
      .send({ smoobu_api_key: 'nova-chave-123', smoobu_api_secret: 'segredo-super' });
    expect(put.status).toBe(200);
    expect(put.body.tem_segredo).toBe(true);
    const get = await request(app).get('/api/gestor/configuracoes').set('Authorization', 'Bearer ' + token);
    const get2 = await request(app).get('/api/gestor/configuracoes/integracoes').set('Authorization', 'Bearer ' + token);
    for (const r of [put, get, get2]) expect(JSON.stringify(r.body)).not.toContain('segredo-super');
    expect(get2.body.smoobu.tem_segredo).toBe(true);
    const bd = await Empresa.findById(e._id).select('+integracoes.smoobu.api_secret').lean();
    expect(bd.integracoes.smoobu.api_key).toBe('nova-chave-123');
    expect(bd.integracoes.smoobu.api_secret).toBe('segredo-super');
    expect(JSON.stringify(await Empresa.findById(e._id).lean())).not.toContain('segredo-super');
  });

  test('testar ligação: 401 sem segredo explica o que falta', async () => {
    const { token } = await cenario();
    const antigo = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401 });
    try {
      const r = await request(app).post('/api/gestor/configuracoes/integracoes/testar').set('Authorization', 'Bearer ' + token).send({});
      expect(r.body.ok).toBe(false);
      expect(r.body.mensagem).toMatch(/segredo/i);
    } finally { global.fetch = antigo; }
  });
});

describe('apagar tarefas futuras', () => {
  const futura = (e, p) => Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, data: new Date(Date.now() + 5 * 86400000), tipo: 'limpeza', estado: 'por_atribuir', tempo_limpeza_minutos: 60 });

  test('com o Smoobu a recusar a ligação não apaga nada', async () => {
    const { e, token } = await cenario({ api_secret: 's' });
    const p = await Propriedade.create({ nome: 'P', empresa_id: e._id, smoobu_id: 'x' + n, ativo: true });
    await futura(e, p);
    const antigo = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401 });
    try {
      const r = await request(app).delete('/api/gestor/tarefas/futuras').set('Authorization', 'Bearer ' + token);
      expect(r.status).toBe(409);
      expect(r.body.erro).toMatch(/Nada foi apagado/);
    } finally { global.fetch = antigo; }
    expect(await Tarefa.countDocuments({ empresa_id: e._id })).toBe(1);
  });

  test('com ligação a funcionar apaga e fica na auditoria', async () => {
    const { e, token } = await cenario({ api_secret: 's' });
    const p = await Propriedade.create({ nome: 'P', empresa_id: e._id, smoobu_id: 'y' + n, ativo: true });
    await futura(e, p);
    const antigo = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200 });
    try {
      const r = await request(app).delete('/api/gestor/tarefas/futuras').set('Authorization', 'Bearer ' + token);
      expect(r.status).toBe(200);
    } finally { global.fetch = antigo; }
    expect(await Tarefa.countDocuments({ empresa_id: e._id })).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(await Auditoria.countDocuments({ empresa_id: e._id, acao: 'apagar_tarefas_futuras' })).toBe(1);
  });
});
