/**
 * Testes de integração do backend (FisioCell) — Jest + Supertest.
 *
 * Estes testes importam a instância `app` exportada por server.js (que NÃO
 * inicia o servidor HTTP nem liga ao MongoDB, graças ao `if (require.main
 * === module)`). Isto permite testar as rotas sem dependências externas.
 */

const request = require('supertest');
const app = require('../server');

describe('GET / (healthcheck)', () => {
  it('deve devolver status 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('deve devolver a mensagem de status da API', async () => {
    const res = await request(app).get('/');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe(
      'API do FisioCell online e ligada à BD!'
    );
  });

  it('deve devolver JSON (Content-Type application/json)', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('Rotas inexistentes (404)', () => {
  it('deve devolver 404 para uma rota que não existe', async () => {
    const res = await request(app).get('/rota-que-nao-existe');
    expect(res.status).toBe(404);
  });
});
