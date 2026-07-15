/**
 * Modelo: WebhookLog
 * Regista os payloads recebidos via webhook do Smoobu para auditoria,
 * idempotência e recuperação de erros.
 *
 * Fluxo:
 *   1. Ao receber um webhook → cria um WebhookLog com status 'recebido'.
 *   2. Após processar com sucesso → atualiza para 'processado'.
 *   3. Se o processamento falhar → atualiza para 'erro' com a mensagem.
 *
 * Isto permite:
 *   - Saber quantos webhooks foram recebidos vs processados vs com erro.
 *   - Reprocesso manual de webhooks que falharam.
 *   - Auditoria do que o Smoobu enviou (payload bruto preservado).
 */
const mongoose = require('mongoose');

const webhookLogSchema = new mongoose.Schema(
  {
    // Payload bruto recebido do Smoobu (preservado para auditoria/reprocesso).
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Prompt 140 — Empresa associada ao webhook (resolvida a partir da
    // propriedade Smoobu no payload). Null se não foi possível resolver.
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      default: null,
      index: true,
    },
    // Estado do processamento.
    status: {
      type: String,
      enum: ['recebido', 'processado', 'erro'],
      default: 'recebido',
      required: true,
      index: true,
    },
    // Mensagem de erro (preenchida se status === 'erro').
    erro_msg: {
      type: String,
      default: null,
    },
  },
  { timestamps: true } // createdAt + updatedAt
);

// Índice para consultar webhooks com erro (reprocesso).
webhookLogSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('WebhookLog', webhookLogSchema);
