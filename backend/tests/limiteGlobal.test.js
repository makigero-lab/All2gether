/**
 * Testes do limite global de pedidos (chave por utilizador com JWT válido,
 * por IP caso contrário, e limites por tipo).
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const {
  criarLimiteGlobal,
  chaveGlobal,
  maximoGlobal,
  isentoDoLimiteGlobal,
  MAX_UTILIZADOR,
  MAX_IP,
} = require('../utils/limiteGlobal');

const ID = '64b7f0c2a1b2c3d4e5f60718';
const reqCom = (token, ip = '10.0.0.1', extra = {}) => ({
  ip,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  header(n) { return this.headers[n.toLowerCase()]; },
  ...extra,
});
const valido = (id = ID) => jwt.sign({ id, role: 'staff' }, JWT_SECRET, { expiresIn: '1h' });

describe('chave e máximo do limite global', () => {
  test('JWT válido -> chave por utilizador, 1000', () => {
    const r = reqCom(valido());
    expect(chaveGlobal(r)).toBe(`u:${ID}`);
    expect(maximoGlobal(r)).toBe(MAX_UTILIZADOR);
    expect(MAX_UTILIZADOR).toBe(1000);
  });

  test('o mesmo utilizador de IPs diferentes partilha a chave', () => {
    expect(chaveGlobal(reqCom(valido(), '1.1.1.1'))).toBe(chaveGlobal(reqCom(valido(), '2.2.2.2')));
  });

  test.each([
    ['sem token', null],
    ['lixo', 'abc.def.ghi'],
    ['assinado com outro segredo', jwt.sign({ id: ID }, 'outro-segredo-qualquer-xxxxxxxxxxxx')],
    ['expirado', jwt.sign({ id: ID }, JWT_SECRET, { expiresIn: -10 })],
    ['algoritmo none', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(`{"id":"${ID}"}`).toString('base64url')}.`],
    ['sem id', jwt.sign({ role: 'staff' }, JWT_SECRET)],
    ['id inválido', jwt.sign({ id: 'nao-e-objectid' }, JWT_SECRET)],
  ])('token %s -> chave por IP, 100', (_n, token) => {
    const r = reqCom(token, '9.9.9.9');
    expect(chaveGlobal(r)).toBe('ip:9.9.9.9');
    expect(maximoGlobal(r)).toBe(MAX_IP);
    expect(MAX_IP).toBe(100);
  });

  test('cabeçalhos x-forwarded-for do cliente não influenciam a chave', () => {
    const r = reqCom(null, '9.9.9.9');
    r.headers['x-forwarded-for'] = '1.2.3.4';
    expect(chaveGlobal(r)).toBe('ip:9.9.9.9');
  });

  test('isenções: smoobu e POST login; outras rotas não', () => {
    expect(isentoDoLimiteGlobal({ method: 'POST', originalUrl: '/api/smoobu/webhook' })).toBe(true);
    expect(isentoDoLimiteGlobal({ method: 'POST', originalUrl: '/api/auth/login' })).toBe(true);
    expect(isentoDoLimiteGlobal({ method: 'GET', originalUrl: '/api/auth/login' })).toBe(false);
    expect(isentoDoLimiteGlobal({ method: 'POST', originalUrl: '/api/auth/loginx' })).toBe(false);
    expect(isentoDoLimiteGlobal({ method: 'GET', originalUrl: '/api/auth/me' })).toBe(false);
  });
});

describe('limitador em ação (limites reais forçados)', () => {
  const montar = () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/', criarLimiteGlobal({ forcar: true }));
    app.all('/api/*', (_req, res) => res.json({ ok: true }));
    return app;
  };

  test('sem token: o pedido 101 do mesmo IP leva 429; o login continua livre', async () => {
    const app = montar();
    for (let i = 0; i < MAX_IP; i++) {
      const r = await request(app).get('/api/x');
      expect(r.status).toBe(200);
    }
    expect((await request(app).get('/api/x')).status).toBe(429);
    expect((await request(app).post('/api/auth/login')).status).toBe(200);
  });

  test('token forjado não contorna o limite por IP', async () => {
    const app = montar();
    for (let i = 0; i < MAX_IP; i++) {
      await request(app).get('/api/x').set('Authorization', `Bearer forjado${i}`);
    }
    const r = await request(app).get('/api/x').set('Authorization', 'Bearer outro-forjado');
    expect(r.status).toBe(429);
  });

  test('com JWT válido passa dos 100 e o limite é por utilizador, não por IP', async () => {
    const app = montar();
    const tA = valido();
    for (let i = 0; i < MAX_IP + 20; i++) {
      const r = await request(app).get('/api/x').set('Authorization', `Bearer ${tA}`);
      expect(r.status).toBe(200);
    }
    // outro utilizador (mesmo IP) tem quota própria
    const tB = valido('64b7f0c2a1b2c3d4e5f60719');
    expect((await request(app).get('/api/x').set('Authorization', `Bearer ${tB}`)).status).toBe(200);
  });
});
