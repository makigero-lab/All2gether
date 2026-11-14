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
const { minimizarPayload } = require('../utils/minimizarPayloadWebhook');

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
    // true quando o payload já foi reduzido ao mínimo (sem dados de hóspedes). Enquanto o log está
    // 'recebido' guarda a cópia completa, só para a retoma de webhooks presos; ao ficar 'processado' ou
    // 'erro' (ou ao passar o prazo da retoma) reduz-se. Ver utils/minimizarPayloadWebhook.js.
    payload_minimo: { type: Boolean, default: false },
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
// (nome, email, telefone). Cada log expira 30 dias DEPOIS DO CHECK-OUT da reserva
// (e não da receção), para que uma reserva feita com muita antecedência não perca
// a cópia antes da estadia. O MongoDB apaga o documento quando `expira_em` passa.
const RETENCAO_DIAS = 30;
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
  // RGPD: só um log 'recebido' (à espera de processar) guarda a cópia completa.
  if (this.status !== 'recebido' && !this.payload_minimo) {
    this.payload = minimizarPayload(this.payload);
    this.payload_minimo = true;
  }
  next();
});

// RGPD: quando uma atualização fecha o log (status 'processado' ou 'erro'), o payload é reduzido ao mínimo
// na mesma operação. O processamento já usou a cópia completa que tem em memória.
async function minimizarAoFechar(next) {
  try {
    const upd = this.getUpdate() || {};
    const status = upd.status !== undefined ? upd.status : upd.$set && upd.$set.status;
    if (status === 'processado' || status === 'erro') {
      const doc = await this.model.findOne(this.getQuery()).select('payload payload_minimo').lean();
      if (doc && !doc.payload_minimo) this.set({ payload: minimizarPayload(doc.payload), payload_minimo: true });
    }
  } catch (err) {
    console.error('⚠️  [WebhookLog] falha ao minimizar o payload:', err.message);
  }
  next();
}
webhookLogSchema.pre('findOneAndUpdate', minimizarAoFechar);
webhookLogSchema.pre('updateOne', minimizarAoFechar);

/**
 * Migração (idempotente, corre no arranque):
 *  1. remove o antigo índice TTL sobre createdAt (apagava 90 dias após a receção);
 *  2. calcula `expira_em` nos logs sem ele e ENCURTA os que passam de
 *     max(departure, createdAt) + 30 dias (retenção de 90 para 30 dias). Só reduz: repetir não muda nada.
 *     As reservas futuras e em curso mantêm os logs (a reconciliação de cancelamentos precisa deles).
 */
webhookLogSchema.statics.migrarRetencao = async function migrarRetencao() {
  const antigo = (await this.collection.indexes()).find(
    (i) => i.expireAfterSeconds !== undefined && i.key && i.key.createdAt === 1 && Object.keys(i.key).length === 1
  );
  if (antigo) await this.collection.dropIndex(antigo.name);

  const novo = {
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
  };
  const r = await this.updateMany(
    { $or: [{ expira_em: { $exists: false } }, { expira_em: null }, { $expr: { $gt: ['$expira_em', novo] } }] },
    [{ $set: { expira_em: novo } }]
  );
  return { indiceAntigoRemovido: Boolean(antigo), atualizados: r.modifiedCount };
};

module.exports = mongoose.model('WebhookLog', webhookLogSchema);
