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
    // Data a partir da qual o log é apagado automaticamente (ver índice TTL abaixo).
    expira_em: { type: Date },
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

// RGPD (minimização/retenção): o payload bruto contém dados pessoais de hóspedes
// (nome, email, telefone). Cada log expira 90 dias DEPOIS DO CHECK-OUT da reserva
// (e não da receção), para que uma reserva feita com muita antecedência não perca
// a cópia antes da estadia. O MongoDB apaga o documento quando `expira_em` passa.
const RETENCAO_DIAS = 90;
const MS_DIA = 24 * 60 * 60 * 1000;
webhookLogSchema.index({ expira_em: 1 }, { expireAfterSeconds: 0 });

/** Data de check-out (departure) do payload, se existir e for válida. */
function departureDoPayload(payload) {
  const bruto = payload && payload.data && payload.data.departure;
  if (typeof bruto !== 'string') return null;
  const d = new Date(bruto);
  return Number.isNaN(d.getTime()) ? null : d;
}

webhookLogSchema.pre('validate', function definirExpiracao(next) {
  if (!this.expira_em) {
    // Base = o mais tardio entre o check-out e agora (nunca expira no passado).
    const agora = Date.now();
    const dep = departureDoPayload(this.payload);
    const base = dep ? Math.max(dep.getTime(), agora) : agora;
    this.expira_em = new Date(base + RETENCAO_DIAS * MS_DIA);
  }
  next();
});

/**
 * Migração (idempotente, corre no arranque):
 *  1. remove o antigo índice TTL sobre createdAt (apagava 90 dias após a receção);
 *  2. calcula `expira_em` nos logs antigos: o mais tardio entre departure e createdAt + 90 dias.
 */
webhookLogSchema.statics.migrarRetencao = async function migrarRetencao() {
  const antigo = (await this.collection.indexes()).find(
    (i) => i.expireAfterSeconds !== undefined && i.key && i.key.createdAt === 1 && Object.keys(i.key).length === 1
  );
  if (antigo) await this.collection.dropIndex(antigo.name);

  const r = await this.updateMany({ expira_em: { $exists: false } }, [
    {
      $set: {
        expira_em: {
          $add: [
            {
              $max: [
                {
                  $ifNull: [
                    { $dateFromString: { dateString: { $ifNull: ['$payload.data.departure', ''] }, onError: null, onNull: null } },
                    '$createdAt',
                  ],
                },
                '$createdAt',
              ],
            },
            RETENCAO_DIAS * MS_DIA,
          ],
        },
      },
    },
  ]);
  return { indiceAntigoRemovido: Boolean(antigo), atualizados: r.modifiedCount };
};

module.exports = mongoose.model('WebhookLog', webhookLogSchema);
