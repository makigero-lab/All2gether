/**
 * Modelo: LeituraCalendario — registo MÍNIMO das leituras de calendários externos (diagnóstico).
 *
 * O Atlas está no plano gratuito (512 MB), por isso cada leitura guarda só o essencial (data, resultado,
 * http, n.º de eventos, hash, erro, PRODID). Leituras consecutivas iguais fundem-se numa só (`repetidas`).
 * Os UID e a amostra redigida só se guardam quando o calendário muda, há erro de formato ou anomalia, e a
 * amostra só fica nas 3 leituras mais recentes por fonte. TTL de 30 dias e teto de documentos por fonte.
 */
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;
const TETO_POR_FONTE = 100;

const leituraSchema = new mongoose.Schema({
  empresa_id: { type: ObjectId, required: true },
  propriedade_id: { type: ObjectId },
  fonte_id: { type: ObjectId, required: true },
  origem: { type: String, enum: ['agendada', 'manual_parceiro', 'manual_gestor', 'teste', 'retoma'], default: 'agendada' },
  iniciada_em: { type: Date, required: true },
  ultima_em: Date, // fim da última leitura fundida nesta
  repetidas: { type: Number, default: 0 }, // quantas leituras iguais seguintes foram fundidas aqui
  duracao_ms: Number,
  resultado: { type: String, enum: ['ok', 'sem_alteracoes', 'suspeita', 'erro'], required: true },
  motivo_suspeita: { type: [String], default: undefined },
  http_status: Number,
  n_eventos: Number,
  n_futuros: Number,
  hash_normalizado: String,
  prodid: { type: String, maxlength: 120 },
  erro: { codigo: String, mensagem: { type: String, maxlength: 300 } },
  // só quando o calendário muda, há erro de formato ou anomalia (máx. 300): 'uid|aaaa-mm-dd|aaaa-mm-dd|classe'
  eventos: { type: [String], default: undefined },
  eventos_truncados: { type: Boolean, default: undefined },
  amostra_redigida: { type: String, maxlength: 8192 },
}, { versionKey: false });

leituraSchema.index({ fonte_id: 1, iniciada_em: -1 });
leituraSchema.index({ empresa_id: 1, iniciada_em: -1 });
leituraSchema.index({ iniciada_em: 1 }, { expireAfterSeconds: 30 * 86400 });

module.exports = mongoose.models.LeituraCalendario || mongoose.model('LeituraCalendario', leituraSchema);
module.exports.TETO_POR_FONTE = TETO_POR_FONTE;
