/**
 * Autocell - API de gestão para Alojamento Local
 * Ponto de entrada da aplicação backend (Express + MongoDB).
 *
 * Variáveis de ambiente (ver .env.example):
 *   - MONGODB_URI        — URI de ligação ao MongoDB (obrigatória)
 *   - PORT               — porta do servidor (default 5000; Render injeta)
 *   - JWT_SECRET         — segredo de assinatura dos JWT (obrigatória)
 *   - JWT_EXPIRACAO      — expiração do JWT (default "7d")
 *   - FRONTEND_URL       — origem permitida para CORS (default localhost:3000)
 *   - SMOOBU_API_KEY     — API Key do Smoobu para sincronização em massa
 *                          (POST /api/admin/smoobu/sincronizar). Opcional:
 *                          sem ela, a sincronização devolve 400.
 *   - VAPID_PUBLIC_KEY   — Chave pública VAPID para Web Push (notificações push)
 *   - VAPID_PRIVATE_KEY  — Chave privada VAPID (assina as notificações)
 *   - VAPID_SUBJECT      — Identificador do emissor (mailto:admin@autocell.com)
 *                          Gerar com: npx web-push generate-vapid-keys
 *
 * NOTA: a instância `app` é exportada (module.exports) para poder ser
 * usada nos testes com supertest SEM iniciar o servidor HTTP nem ligar
 * ao MongoDB. O `app.listen` e o `mongoose.connect` só correm quando
 * este ficheiro é executado diretamente (require.main === module).
 */

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const webhookRoutes = require('./routes/webhookRoutes');
const gestorRoutes = require('./routes/gestorRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const ausenciaRoutes = require('./routes/ausenciaRoutes');
const relatorioRoutes = require('./routes/relatorioRoutes');
const staffRoutes = require('./routes/staffRoutes');
const { iniciarDailyBriefing } = require('./jobs/dailyBriefing');
const { iniciarAgendaAmanha } = require('./jobs/agendaAmanha');
const { iniciarCaoGuarda } = require('./jobs/caoGuarda');
const { iniciarArquivista } = require('./jobs/arquivista');
const { configurarWebPush } = require('./utils/push');

const app = express();

// Trust proxy — necessário no Render (e outros PaaS) para que o express-rate-limit
// leia correctamente o IP do cliente do header X-Forwarded-For. Sem isto, o
// rate-limit lança 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// Configura Web Push (VAPID) — silencioso se as chaves não estiverem definidas.
configurarWebPush();

/* ------------------------------------------------------------------ */
/* Middlewares                                                         */
/* ------------------------------------------------------------------ */
// CORS — TRANCADO: aceita apenas a origem do frontend definida em env.
// credentials: true para permitir cookies cross-origin (quando necessário).
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

// Permite receber e enviar JSON no corpo dos pedidos.
app.use(express.json());

// Rate limiting global: 100 pedidos por IP a cada 15 minutos.
// Não se aplica ao webhook do Smoobu (que tem o seu próprio padrão).
// Em ambiente de teste (Jest) o limite é desativado para não bloquear
// os testes de integração que fazem centenas de pedidos seguidos.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? Infinity : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos. Tente novamente mais tarde.' },
});
app.use('/api/', globalLimiter);

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */
// Health check — estado da API + BD.
app.get('/api/health', async (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  return res.status(mongoReady ? 200 : 503).json({
    status: mongoReady ? 'ok' : 'degraded',
    uptime: process.uptime(),
    mongodb: mongoReady ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// Rota de teste para confirmar que a API está online.
app.get('/', (req, res) => {
  res.json({ status: 'API do Alojamento Local online e ligada à BD!' });
});

// Webhooks de integrações externas (Smoobu, etc.).
app.use('/webhooks', webhookRoutes);

// Autenticação (login público + /me protegido).
app.use('/api/auth', authRoutes);

// Painel do Gestor de Operações (admin e gestor).
// NOTA: a proteção por auth + isGestor é aplicada dentro de gestorRoutes.js.
// O /setup fica PÚBLICO porque é o endpoint de bootstrap.
app.use('/api/gestor', gestorRoutes);

// Gestão de Ausências (Folgas e Férias) — protegido por auth + isGestor.
app.use('/api/gestor/ausencias', ausenciaRoutes);

// Relatórios / Analytics — protegido por auth + isGestor.
app.use('/api/gestor/relatorios', relatorioRoutes);

// Super Admin — rotas exclusivas do admin (auth + isAdmin estrito).
// Impersonation, gestão de empresas, etc.
app.use('/api/admin', adminRoutes);

// Staff — gestão das próprias ausências (pedidos de férias/doença).
app.use('/api/staff', staffRoutes);

/* ------------------------------------------------------------------ */
/* Middleware global de tratamento de erros                            */
/* ------------------------------------------------------------------ */
// Captura exceções não tratadas (erros síncronos lançados após next(err)
// ou erros assíncronos não apanhados por try/catch). Devolve um JSON
// padrão sem vazar a stack trace para o cliente (segurança).
// Deve ser o ÚLTIMO middleware registado (depois de todas as rotas).
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err.message);
  // Log completo no servidor (para debug), mas NÃO enviar ao cliente.
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }
  return res.status(err.status || 500).json({
    erro: err.status ? err.message : 'Erro interno do servidor.',
  });
});

/* ------------------------------------------------------------------ */
/* Exporta a app para testes (supertest)                              */
/* ------------------------------------------------------------------ */
module.exports = app;

/* ------------------------------------------------------------------ */
/* Arranque do servidor (apenas em execução direta)                   */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log('✅ Ligado ao MongoDB com sucesso.');

      // Prompt 131 — Remove o índice único antigo { utilizador_id, data_inicio }
      // da coleção Ausencia. Este índice foi removido do schema Mongoose no
      // Prompt 116, mas índices MongoDB NÃO são auto-removidos. Sem isto,
      // o MongoDB bloqueia a criação de uma nova ausência com a mesma
      // data_inicio de uma rejeitada (duplicate key error 11000).
      // O histórico de ausências (aprovadas/rejeitadas/pendentes) é mantido.
      try {
        const Ausencia = require('./models/Ausencia');
        const indexes = await Ausencia.collection.listIndexes().toArray();
        for (const idx of indexes) {
          // Procura índices que sejam únicos e contenham utilizador_id + data_inicio
          if (idx.unique && idx.key && idx.key.utilizador_id) {
            console.log(`🔧 A remover índice único antigo: ${idx.name}`);
            await Ausencia.collection.dropIndex(idx.name);
            console.log(`✅ Índice único ${idx.name} removido. Ausências rejeitadas já não bloqueiam novas.`);
          }
        }
      } catch (idxErr) {
        // Não bloqueia o arranque se falhar (ex: BD sem permissões).
        console.warn('⚠️  Não foi possível verificar/remover índices únicos:', idxErr.message);
      }

      app.listen(PORT, () => {
        console.log(`🚀 Servidor a correr na porta ${PORT}.`);
      });

      // Inicia o cron job do Daily Briefing (WhatsApp) — só em execução
      // direta, não nos testes. Corre todos os dias às 08:00.
      iniciarDailyBriefing();

      // Prompt 94 — Cron job "Agenda de Amanhã": todos os dias às 19:00
      // (Europe/Lisbon), envia push a cada staff com trabalho amanhã.
      iniciarAgendaAmanha();

      // Prompt 96 — Cron job "Cão de Guarda": todos os dias às 18:00
      // (Europe/Lisbon), envia push por cada tarefa de limpeza de hoje
      // ainda não concluída (lembra o staff de fechar o dia).
      iniciarCaoGuarda();

      // Prompt 109 — Cron job "Arquivista": dia 1 de cada trimestre,
      // move tarefas concluídas/canceladas com mais de 3 meses para o arquivo.
      iniciarArquivista();
    })
    .catch((err) => {
      console.error('❌ Erro ao ligar ao MongoDB:', err.message);
      process.exit(1);
    });
}
