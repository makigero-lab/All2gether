/**
 * Modelo: WebhookLog
 * Regista os payloads recebidos via webhook (integrações externas) para auditoria,
 * idempotência e recuperação de erros.
 *
 * F0: A integração Smoobu foi removida, mas este modelo mantém-se para
 * futuras integrações de webhooks de plataformas de Alojamento Local.
 *
 * Fluxo:
 *   1. Ao receber um webhook → cria um WebhookLog com status 'recebido'.
 *   2. Após processar com sucesso → atualiza para 'processado'.
 *   3. Se o processamento falhar → atualiza para 'erro' com a mensagem.
 *
 * Isto permite:
 *   - Saber quantos webhooks foram recebidos vs processados vs com erro.
 *   - Reprocesso manual de webhooks que falharam.
 *   - Auditoria do payload bruto recebido.
 */
const mongoose = require('mongoose');

const webhookLogSchema = new mongoose.Schema(
  {
    // Payload bruto recebido via webhook (preservado para auditoria/reprocesso).
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Prompt 140 — Empresa associada ao webhook (resolvida a partir da
    // propriedade no payload). Null se não foi possível resolver.
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
