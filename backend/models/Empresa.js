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
