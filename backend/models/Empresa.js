/**
 * Modelo: Empresa (Gestora de Alojamento Local)
 * Representa a entidade principal do SaaS multi-tenant All2gether.
 * Cada empresa agrupa Propriedades, Utilizadores e Tarefas.
 *
 * F0: Removido smoobu_api_key (integração Smoobu eliminada).
 * Adicionados campos da empresa: morada, telefone, email, nif.
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
    //   - as tarefas desta empresa não são processadas pelo load balancer.
    // Diferente de `plano_ativo` (que é informativo/comercial) — `ativa`
    // é o bloqueio operacional efetivo.
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
    // F0 — Dados da empresa (substituem o antigo smoobu_api_key).
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Empresa', empresaSchema);
