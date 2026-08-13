/**
 * All2gether - API de gestão para Alojamento Local e Airbnb
 * Ponto de entrada da aplicação backend (Express + MongoDB).
 *
 * Variáveis de ambiente (ver .env.example):
 *   - MONGODB_URI        — URI de ligação ao MongoDB (obrigatória)
 *   - PORT               — porta do servidor (default 5000; Render injeta)
 *   - JWT_SECRET         — segredo de assinatura dos JWT (obrigatória)
 *   - JWT_EXPIRACAO      — expiração do JWT (default "7d")
 *   - FRONTEND_URL       — origem permitida para CORS (default localhost:3000)
 *   - VAPID_PUBLIC_KEY   — Chave pública VAPID para Web Push (notificações push)
 *   - VAPID_PRIVATE_KEY  — Chave privada VAPID (assina as notificações)
 *   - VAPID_SUBJECT      — Identificador do emissor (mailto:admin@all2gether.com)
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

const gestorRoutes = require('./routes/gestorRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const ausenciaRoutes = require('./routes/ausenciaRoutes');
const relatorioRoutes = require('./routes/relatorioRoutes');
const staffRoutes = require('./routes/staffRoutes');
const smoobuRoutes = require('./routes/smoobuRoutes');
const parceiroRoutes = require('./routes/parceiroRoutes');
// TEMPORÁRIO — Rota de setup emergencial (admin + importação de clientes via
// browser). Remover após o setup inicial em produção estar confirmado.
const setupRoutes = require('./routes/setupRoutes');
const { iniciarDailyBriefing } = require('./jobs/dailyBriefing');
const { iniciarAgendaAmanha } = require('./jobs/agendaAmanha');
const { iniciarCaoGuarda } = require('./jobs/caoGuarda');
const { iniciarArquivista } = require('./jobs/arquivista');
const { iniciarSincronizacaoSmoobu } = require('./jobs/sincronizacaoSmoobu');
const { iniciarLimpezaFotos } = require('./jobs/limpezaFotos');
const { iniciarGeradorRotinas } = require('./jobs/geradorRotinas');
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
// Em ambiente de teste (Jest) o limite é desativado para não bloquear
// os testes de integração que fazem centenas de pedidos seguidos.
// EXCEÇÃO: /api/smoobu — webhooks M2M do Smoobu chegam de um IP único e
// podem burstar (várias reservas em poucos minutos). A autenticação via
// SMOOBU_API_KEY substitui a proteção anti-abuso do rate limiter nessa rota.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? Infinity : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos. Tente novamente mais tarde.' },
  skip: (req) => req.path.startsWith('/api/smoobu'),
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
  res.json({ status: 'API do All2gether online e ligada à BD!' });
});

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

// Smoobu — receção de webhooks INBOUND (reservas de Alojamento Local).
// Endpoint público (autentica via SMOOBU_API_KEY no header, NÃO via JWT).
// O rate limiter global está ISENTO para esta rota (ver skip acima).
app.use('/api/smoobu', smoobuRoutes);

// HF17 (Fase 3) — Portal de Parceiros B2B (propriedades manuais + tarefas).
// Protegido por auth + isParceiro.
app.use('/api/parceiro', parceiroRoutes);

// TEMPORÁRIO — Setup emergencial via browser (GET /api/setup-emergencia).
// Rota PÚBLICA (sem JWT) que faz upsert do Super Admin + importação dos 47
// clientes. Proteção opcional via env var SETUP_EMERGENCIA_TOKEN (se definida,
// exige ?token=<valor>). Ver routes/setupRoutes.js para detalhes.
// ⚠️ REMOVER esta montagem e o ficheiro routes/setupRoutes.js após o setup
// inicial em produção estar confirmado.
app.use('/api/setup-emergencia', setupRoutes);

// TEMPORÁRIO — Migração de unificação de propriedades (GET /api/fix-migracao).
// Rota PÚBLICA (sem JWT) que move TODAS as propriedades para o tenant do
// Super Admin (admin@makigero.com) e apaga as empresas parceiras vazias.
// Reflete o modelo de negócio single-tenant. Proteção opcional via env var
// SETUP_EMERGENCIA_TOKEN (se definida, exige ?token=<valor>).
// ⚠️ REMOVER esta montagem e o ficheiro routes/fixMigracaoRoutes.js após o
// cliente executar a migração em produção.
const fixMigracaoRoutes = require('./routes/fixMigracaoRoutes');
app.use('/api/fix-migracao', fixMigracaoRoutes);

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

      // HF11 — Remove o índice único legacy `funcionario_preferencial_unique_1to1`
      // da coleção Propriedades. Este índice foi criado em HF9 (regra 1-para-1
      // estrita) e removido do schema em HF11 (sistema híbrido Many-to-One).
      // Índices MongoDB NÃO são auto-removidos quando desaparecem do schema
      // Mongoose, pelo que é necessário drops explícito. Sem isto, o MongoDB
      // rejeitaria atribuir o mesmo staff a duas propriedades (E11000 duplicate key).
      try {
        const Propriedade = require('./models/Propriedade');
        const propIndexes = await Propriedade.collection.listIndexes().toArray();
        for (const idx of propIndexes) {
          if (idx.unique && idx.name === 'funcionario_preferencial_unique_1to1') {
            console.log(`🔧 [HF11] A remover índice único legacy: ${idx.name}`);
            await Propriedade.collection.dropIndex(idx.name);
            console.log(`✅ [HF11] Índice ${idx.name} removido. Staff pode ser preferencial de múltiplas propriedades.`);
          }
        }
      } catch (propIdxErr) {
        // Não bloqueia o arranque se falhar (ex: índice já não existe, BD sem permissões).
        console.warn('⚠️  [HF11] Não foi possível verificar/remover índice legacy de Propriedades:', propIdxErr.message);
      }

      app.listen(PORT, () => {
        console.log(`🚀 Servidor a correr na porta ${PORT}.`);
      });

      // Inicia o cron job do Daily Briefing — só em execução
      // direta, não nos testes. Corre todos os dias às 08:00.
      iniciarDailyBriefing();

      // Cron job "Agenda de Amanhã": todos os dias às 19:00
      // (Europe/Lisbon), envia push a cada staff com trabalho amanhã.
      iniciarAgendaAmanha();

      // Cron job "Cão de Guarda": todos os dias às 18:00
      // (Europe/Lisbon), envia push por cada tarefa de limpeza de hoje
      // ainda não concluída (lembra o staff de fechar o dia).
      iniciarCaoGuarda();

      // Cron job "Arquivista": dia 1 de cada trimestre,
      // move tarefas concluídas/canceladas com mais de 3 meses para o arquivo.
      iniciarArquivista();

      // HF8 — Cron job "Sincronização Smoobu" DESATIVADO.
      // O sistema é 100% reativo a webhooks (o Smoobu envia eventos que são
      // processados automaticamente). A sincronização ativa (pull da REST API
      // do Smoobu) foi removida do fluxo de produção porque causava 502s e não
      // faz parte do fluxo original. A função `iniciarSincronizacaoSmoobu`
      // mantém-se exportada para uso manual via API direta se necessário no
      // futuro, mas NÃO é agendada.
      // iniciarSincronizacaoSmoobu();

      // HF19 — Cron job "Limpeza de Fotos": todos os dias às 03:00,
      // esvazia fotos_conclusao e avarias[*].fotos de tarefas concluídas
      // há mais de 7 dias (otimização de armazenamento).
      iniciarLimpezaFotos();

      // HF22 — Cron job "Gerador de Rotinas": todos os dias às 02:00,
      // cria tarefas automáticas para propriedades com dias_fixos_limpeza
      // configurados para o dia de amanhã. Submete ao Load Balancer.
      iniciarGeradorRotinas();
    })
    .catch((err) => {
      console.error('❌ Erro ao ligar ao MongoDB:', err.message);
      process.exit(1);
    });
}
