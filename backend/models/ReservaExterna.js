/**
 * Modelo: ReservaExterna — All2gether.
 *
 * Um evento do calendário externo (por casa, canal e UID). É a memória da importação: decisões do
 * proprietário, contagem de faltas e ligação à reserva/limpeza. Só datas e rótulos: nunca o nome do hóspede,
 * o SUMMARY original nem o código da reserva em claro (só um HMAC).
 */
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const reservaExternaSchema = new mongoose.Schema(
  {
    empresa_id: { type: ObjectId, ref: 'Empresa', required: true },
    propriedade_id: { type: ObjectId, ref: 'Propriedade', required: true },
    parceiro_id: { type: ObjectId, ref: 'Utilizador', required: true },
    fonte_id: { type: ObjectId, ref: 'FonteCalendario' },
    canal: { type: String, required: true },
    canal_chave: { type: String, required: true, maxlength: 120 },
    uid: { type: String, required: true, maxlength: 255 },
    codigo_ref_hash: { type: String, default: null },
    check_in: { type: Date, required: true },
    check_out: { type: Date, required: true },
    noites: Number,
    classe: { type: String, enum: ['reserva', 'bloqueio', 'incerto'], required: true },
    resumo_tipo: { type: String, enum: ['airbnb_reserved', 'airbnb_not_available', 'booking_closed', 'desconhecido'], default: 'desconhecido' },
    estado: { type: String, enum: ['por_confirmar', 'confirmada', 'bloqueio', 'duplicada', 'cancelada', 'terminada', 'substituida'], required: true },
    motivo: { type: String, enum: ['sobreposicao', 'periodo_longo', 'reapareceu', null], default: null },
    // 'faltou' = desapareceu do calendário (pode reaparecer); 'ligacao_removida' e 'parceiro' não reaparecem.
    motivo_cancelamento: { type: String, enum: ['faltou', 'ligacao_removida', 'parceiro', null], default: null },
    estado_antes_cancelar: { type: String, default: null },
    decidido_por: { type: String, enum: ['automatico', 'parceiro', 'gestor'], default: 'automatico' },
    decidido_por_id: { type: ObjectId },
    decidido_em: Date,
    presente_no_feed: { type: Boolean, default: true },
    leituras_em_falta: { type: Number, default: 0, min: 0 },
    primeira_falta_em: Date,
    primeiro_visto_em: Date,
    visto_em: Date,
    reserva_manual_id: { type: ObjectId, ref: 'ReservaManual' },
    duplicada_de: { tipo: { type: String, enum: ['reserva_externa', 'reserva_manual'] }, id: ObjectId },
    substituida_por: { type: ObjectId, ref: 'ReservaExterna' },
    conflito: { type: String, enum: ['limpeza_em_curso', 'limpeza_concluida', null], default: null },
    avisos_enviados: { type: [String], default: [] },
    historico: {
      type: [{ _id: false, em: Date, evento: String, de: { type: String, maxlength: 60 }, para: { type: String, maxlength: 60 } }],
      default: [],
    },
    apagar_apos: Date,
  },
  { timestamps: true }
);

reservaExternaSchema.index({ propriedade_id: 1, canal_chave: 1, uid: 1 }, { unique: true });
reservaExternaSchema.index({ empresa_id: 1, propriedade_id: 1, check_out: 1 });
reservaExternaSchema.index({ parceiro_id: 1, estado: 1, check_out: 1 });
reservaExternaSchema.index({ empresa_id: 1, estado: 1, check_out: 1 });
reservaExternaSchema.index({ reserva_manual_id: 1 }, { sparse: true });
reservaExternaSchema.index({ apagar_apos: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ReservaExterna || mongoose.model('ReservaExterna', reservaExternaSchema);
