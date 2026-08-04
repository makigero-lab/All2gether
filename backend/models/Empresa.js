/**
 * Modelo: Empresa (Gestora de Alojamento Local)
 * Representa a entidade principal do satélite All2gether (single-tenant).
 * Cada empresa agrupa Propriedades, Utilizadores e Tarefas.
 *
 * HF6 — Descentralização de integrações: a gestão da integração Smoobu
 * (api_key, ativo) e das rotinas de sincronização (frequência, estado)
 * passa a viver aqui, no All2gether, em vez de na Nave-Mãe (Autocell).
 * Isto respeita o princípio de separation of concerns: cada satélite gere
 * as suas próprias integrações. A env var SMOOBU_API_KEY mantém-se como
 * fallback (retrocompatibilidade / dev), mas a fonte de verdade em produção
 * passa a ser o campo `integracoes.smoobu.api_key` desta coleção.
 *
 * F0: Removido smoobu_api_key (integração Smoobu eliminada).
 * HF6: Re-introduzido como sub-documento `integracoes.smoobu` (mais rico).
 *
 * DCE-B: Removido plano_ativo (campo informativo SaaS sem enforcement —
 *        a gestão de Planos SaaS passou para a Nave-Mãe). O controlo
 *        operacional efetivo é o campo `ativa`.
 */
const mongoose = require('mongoose');

const empresaSchema = new mongoose.Schema(
  {
    nome: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    nif: {
      type: String,
      trim: true,
    },
    // Prompt 116 — Estado da empresa (controlo operacional). Quando `false`:
    //   - o login é bloqueado para todos os utilizadores desta empresa;
    //   - as tarefas desta empresa não são processadas pelo load balancer.
    // É o bloqueio operacional efetivo (DCE-B: o antigo `plano_ativo`,
    // meramente informativo, foi removido — a gestão de Planos SaaS passou
    // para a Nave-Mãe).
    ativa: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Prompt 122 — Soft Delete (Lixeira de Empresas). Quando `true`:
    //   - a empresa desaparece da aba "Ativas" e aparece na "Reciclagem";
    //   - `ativa` é forçada para false (bloqueia login + processamento);
    //   - pode ser restaurada via PATCH /api/admin/empresas/:id/restaurar.
    // Não apaga fisicamente — preserva os dados para auditoria/restauro.
    apagada: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Dados da empresa.
    morada: {
      type: String,
      default: '',
      trim: true,
    },
    telefone: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },

    // ----------------------------------------------------------------
    // HF6 — Integrações externas (descentralizadas da Nave-Mãe).
    // ----------------------------------------------------------------
    // Cada integração é um sub-documento para permitir futuras adições
    // (ex.: Airbnb, Booking) sem migrar o schema. A fonte de verdade das
    // credenciais passa a ser aqui (não mais env vars globais).
    integracoes: {
      // Integração Smoobu (plataforma de Alojamento Local).
      smoobu: {
        // API key do Smoobu (gerada no painel do Smoobu → Settings → API).
        // Usada para: (a) autenticar webhooks INBOUND (Smoobu → All2gether),
        // (b) chamar a REST API do Smoobu (GET /api/apartments, /api/reservations).
        // ATENÇÃO: campo sensível — nunca expor em claro no GET (mascarar).
        api_key: {
          type: String,
          default: '',
          trim: true,
        },
        // Toggle on/off da integração (sem apagar a chave).
        ativo: {
          type: Boolean,
          default: false,
        },
        // Timestamp da última sincronização de reservas bem-sucedida
        // (atualizado pelo job sincronizacaoSmoobu ou pelo endpoint manual).
        ultima_sincronizacao: {
          type: Date,
          default: null,
        },
      },
    },

    // ----------------------------------------------------------------
    // HF6 — Rotinas de sincronização automática.
    // ----------------------------------------------------------------
    // Configurações que o cron job `sincronizacaoSmoobu` lê para decidir
    // se deve correr a sincronização para esta empresa.
    rotinas: {
      // Toggle global da sincronização automática (cron job).
      sincronizacao_automatica: {
        type: Boolean,
        default: false,
      },
      // Frequência da sincronização automática em horas (1, 6, 12, 24).
      // O cron job corre a cada hora e verifica se
      //   ultima_sincronizacao + frequencia_horas < agora
      // para decidir se dispara a sincronização desta empresa.
      frequencia_horas: {
        type: Number,
        default: 24,
        min: 1,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Empresa', empresaSchema);
