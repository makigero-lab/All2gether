/**
 * Rotas de Autenticação.
 *
 * Prefixo montado em server.js: /api/auth
 *
 * Endpoints:
 *   POST /api/auth/login  — login (público, com rate limiting anti-força bruta)
 *   GET  /api/auth/sso    — Single Sign-On com o portal Autocell (público)
 *   GET  /api/auth/me     — dados do utilizador autenticado (requer JWT)
 *
 * Segurança (v1.11.0):
 *   A rota de login está protegida por `express-rate-limit` para mitigar
 *   ataques de força bruta e credential stuffing. Limite: 5 tentativas por
 *   IP a cada 15 minutos. Ultrapassado o limite → 429 com mensagem clara.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { login, ssoLogin, me, meuCalendario, minhasTarefas, minhaTarefaDetalhe, concluirMinhaTarefa } = require('../controllers/authController');
const {
  listarNotificacoes,
  contagemNotificacoes,
  marcarTodasLidas,
  marcarUmaLida,
} = require('../controllers/notificacaoController');

/**
 * Limitador de taxa específico para a rota de login.
 *
 * - 5 tentativas por IP a cada 15 minutos (janela deslizante).
 * - Resposta 429 com JSON padrão (não revela detalhes do backend).
 * - `standardHeaders: true` envia headers RateLimit-* (boa prática, ajuda
 *   clientes a saberem quando podem tentar novamente).
 * - `legacyHeaders: false` desativa headers X-RateLimit-* antigos.
 *
 * Justificação dos valores:
 *   - 5 tentativas é suficiente para um utilizador legítimo que se engana
 *     na password algumas vezes, mas insuficiente para um ataque de força
 *     bruta (que precisa de centenas/milhares de tentativas).
 *   - 15 minutos é um equilíbrio: não penaliza demasiado o utilizador
 *     legítimo, mas atrasa significativamente um ataque.
 */
// Em testes o limitador fica desligado, salvo se o teste o ativar de propósito.
const limitadorDesligado = () =>
  process.env.NODE_ENV === 'test' && !process.env.TEST_LOGIN_LIMIT;

// Limite por IP: só conta tentativas FALHADAS (logins com sucesso não gastam
// quota). Nota: atrás da Vercel o IP visto pode ser o do proxy, partilhado por
// vários utilizadores — por isso é mais tolerante e a defesa principal é o
// limite por conta, abaixo.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: limitadorDesligado,
  message: {
    erro: 'Muitas tentativas de login. Tente novamente mais tarde.',
  },
});

// Limite por CONTA (email): trava força bruta sobre uma password específica,
// independentemente do IP. 10 falhas / 15 min por email; sucessos não contam.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: limitadorDesligado,
  keyGenerator: (req) =>
    `conta:${String((req.body && req.body.email) || '').toLowerCase().trim()}`,
  validate: { keyGeneratorIpFallback: false },
  message: {
    erro: 'Muitas tentativas para esta conta. Tente novamente mais tarde.',
  },
});

// Login — público, mas com rate limiting anti-força bruta.
router.post('/login', loginLimiter, loginAccountLimiter, login);

// Single Sign-On (SSO) com o portal Autocell — público.
// Recebe um JWT externo na query string (?token=...), valida-o com
// AUTOCELL_SSO_SECRET, e se for válido define os cookies de sessão do
// admin e redireciona para /admin. Em caso de erro → /login?erro=sso_falhou.
// Sem rate limiter próprio (o global de /api/ aplica-se); o segredo
// partilhado é a proteção principal.
router.get('/sso', ssoLogin);

// Dados do utilizador autenticado — requer JWT.
router.get('/me', auth, me);

// Calendário pessoal do utilizador — requer JWT.
router.get('/me/calendario', auth, meuCalendario);

// Tarefas de hoje do utilizador — requer JWT.
router.get('/me/tarefas', auth, minhasTarefas);

// Detalhe de uma tarefa do utilizador — requer JWT.
router.get('/me/tarefas/:id', auth, minhaTarefaDetalhe);

// Concluir tarefa — requer JWT.
router.patch('/me/tarefas/:id/concluir', auth, concluirMinhaTarefa);

// Notificações Push (Web Push API) — v1.27.0.
const {
  pushVapidPublicKey,
  pushSubscribe,
  pushUnsubscribe,
} = require('../controllers/authController');

// Devolve a chave pública VAPID (para o frontend pedir a subscrição).
router.get('/me/push-vapid-public-key', auth, pushVapidPublicKey);

// Guarda a subscrição push do browser no utilizador logado.
router.post('/me/push-subscribe', auth, pushSubscribe);

// Remove a subscrição push do utilizador.
router.post('/me/push-unsubscribe', auth, pushUnsubscribe);

// Prompt 114 — Centro de Notificações In-App (O Sino).
// Montadas em /api/auth/me/notificacoes (qualquer utilizador autenticado).
router.get('/me/notificacoes', auth, listarNotificacoes);
router.get('/me/notificacoes/contagem', auth, contagemNotificacoes);
router.patch('/me/notificacoes/marcar-lidas', auth, marcarTodasLidas);
router.patch('/me/notificacoes/:id/lida', auth, marcarUmaLida);

module.exports = router;
