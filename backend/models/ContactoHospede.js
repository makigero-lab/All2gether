/**
 * Modelo: ContactoHospede — All2gether
 *
 * Email e telefone do hóspede, vindos do Smoobu. Ficam numa coleção SEPARADA
 * das tarefas de propósito (RGPD / minimização):
 *   - nenhuma listagem de tarefas (gestor, staff, parceiro, calendário, Excel)
 *     pode devolver estes dados por engano;
 *   - só o endpoint exclusivo do admin os lê (e regista a consulta em auditoria);
 *   - apagam-se sozinhos 90 dias depois do check-out (índice TTL em `expira_em`).
 */
const mongoose = require('mongoose');

const RETENCAO_DIAS = 90;

const contactoHospedeSchema = new mongoose.Schema(
  {
    tarefa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa', required: true, unique: true },
    empresa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, index: true },
    email: { type: String, default: null, trim: true, maxlength: 254 },
    telefone: { type: String, default: null, trim: true, maxlength: 50 },
    // Data em que o MongoDB apaga este registo (check-out + 90 dias).
    expira_em: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: o MongoDB apaga o documento quando expira_em < agora.
contactoHospedeSchema.index({ expira_em: 1 }, { expireAfterSeconds: 0 });

/** check-out (string/Date) + 90 dias; se inválido, agora + 90 dias. */
contactoHospedeSchema.statics.calcularExpiracao = function (checkout) {
  const base = new Date(checkout);
  const ref = Number.isNaN(base.getTime()) || base.getTime() < Date.now() ? new Date() : base;
  return new Date(ref.getTime() + RETENCAO_DIAS * 24 * 60 * 60 * 1000);
};

module.exports = mongoose.model('ContactoHospede', contactoHospedeSchema);
