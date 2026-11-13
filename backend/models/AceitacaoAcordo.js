/**
 * Modelo: AceitacaoAcordo — All2gether.
 *
 * Registo, só de acrescentar, de cada aceitação do Acordo de Tratamento de Dados (art. 28.º RGPD) por um
 * proprietário. Prova da versão, do texto exato (hash SHA-256), de quem aceitou e quando.
 * O apagamento RGPD da pessoa NÃO apaga este registo (só o reduz): é prova do cumprimento (art. 5.º, n.º 2).
 */
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema(
  {
    empresa_id: { type: ObjectId, ref: 'Empresa', required: true },
    parceiro_id: { type: ObjectId, ref: 'Utilizador', required: true },
    aceite_por_id: { type: ObjectId, ref: 'Utilizador', required: true },
    aceite_por_nome: { type: String, maxlength: 200 },
    aceite_por_email: { type: String, maxlength: 254 },
    documento: { type: String, default: 'PROP-DPA' },
    versao: { type: String, required: true, maxlength: 20 },
    hash_texto: { type: String, required: true, maxlength: 64 },
    aceite_em: { type: Date, required: true, default: Date.now },
    contexto: { type: String, maxlength: 60, default: 'portal' },
    ip_truncado: { type: String, maxlength: 60 },
    agente: { type: String, maxlength: 200 },
    revogado_em: { type: Date, default: null },
  },
  { timestamps: false }
);
schema.index({ parceiro_id: 1, versao: 1, aceite_em: -1 });
schema.index({ empresa_id: 1, parceiro_id: 1 });
// Uma só aceitação em vigor por proprietário, versão e texto: dois pedidos em corrida não gravam dois registos.
// (Os registos revogados ficam como prova e não contam.)
schema.index({ parceiro_id: 1, versao: 1, hash_texto: 1 }, { unique: true, partialFilterExpression: { revogado_em: null }, name: 'uniq_aceitacao_em_vigor' });

module.exports = mongoose.models.AceitacaoAcordo || mongoose.model('AceitacaoAcordo', schema);
