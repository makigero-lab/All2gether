/**
 * Modelo: Empresa
 * Representa a entidade principal do SaaS (multi-tenant).
 * Cada empresa agrupa Propriedades e Utilizadores (Admin/Staff).
 *
 * Prompt 109: Adicionado smoobu_api_key para que cada empresa (tenant)
 * tenha a sua própria ligação ao Smoobu sem hardcode no .env.
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
    plano_ativo: {
      type: Boolean,
      default: true,
    },
    // Prompt 116 — Estado da empresa (SaaS). Quando `false`:
    //   - o login é bloqueado para todos os utilizadores desta empresa;
    //   - os webhooks do Smoobu são rejeitados (propriedades não criam tarefas).
    // Diferente de `plano_ativo` (que é informativo/comercial) — `ativa`
    // é o bloqueio operacional efetivo.
    ativa: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Prompt 122 — Soft Delete (Lixeira de Empresas). Quando `true`:
    //   - a empresa desaparece da aba "Ativas" e aparece na "Reciclagem";
    //   - `ativa` é forçada para false (bloqueia login + webhooks);
    //   - pode ser restaurada via PATCH /api/admin/empresas/:id/restaurar.
    // Não apaga fisicamente — preserva os dados para auditoria/restauro.
    apagada: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Prompt 109 — API Key do Smoobu por empresa (multi-tenant SaaS).
    // Quando preenchida, as operações de sincronização usam esta chave
    // em vez da variável de ambiente SMOOBU_API_KEY global.
    smoobu_api_key: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Empresa', empresaSchema);
