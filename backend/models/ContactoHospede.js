/**
 * Modelo: ContactoHospede — All2gether
 *
 * Email e telefone do hóspede, vindos do Smoobu. Ficam numa coleção SEPARADA
 * das tarefas de propósito (RGPD / minimização):
 *   - nenhuma listagem de tarefas (gestor, staff, parceiro, calendário, Excel)
 *     pode devolver estes dados por engano;
 *   - só o endpoint exclusivo do admin os lê (e regista a consulta em auditoria);
 *   - apagam-se sozinhos 30 dias depois do check-out (índice TTL em `expira_em`).
 */
const mongoose = require('mongoose');

const RETENCAO_DIAS = 30;
const MS_DIA = 24 * 60 * 60 * 1000;
const RETENCAO_DIAS_ANTIGA = 90;

const contactoHospedeSchema = new mongoose.Schema(
  {
    tarefa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa', required: true, unique: true },
    empresa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, index: true },
    email: { type: String, default: null, trim: true, maxlength: 254 },
    telefone: { type: String, default: null, trim: true, maxlength: 50 },
    // Data em que o MongoDB apaga este registo (check-out + 30 dias).
    expira_em: { type: Date, required: true },
    // Prazo (dias após o check-out) com que `expira_em` foi calculado. Serve só para a migração
    // 90 -> 30 dias ser idempotente: registos sem este campo ainda têm o prazo antigo.
    retencao_dias: { type: Number, default: RETENCAO_DIAS },
  },
  { timestamps: true }
);

// TTL: o MongoDB apaga o documento quando expira_em < agora.
contactoHospedeSchema.index({ expira_em: 1 }, { expireAfterSeconds: 0 });

/** check-out (string/Date) + 30 dias; se inválido, agora + 30 dias. */
contactoHospedeSchema.statics.calcularExpiracao = function (checkout) {
  const base = new Date(checkout);
  const ref = Number.isNaN(base.getTime()) || base.getTime() < Date.now() ? new Date() : base;
  return new Date(ref.getTime() + RETENCAO_DIAS * MS_DIA);
};

/**
 * Migração (idempotente, corre no arranque): os registos criados com o prazo de 90 dias
 * (sem `retencao_dias`) passam a expirar 30 dias após o check-out, ou seja, menos 60 dias.
 */
contactoHospedeSchema.statics.migrarRetencao = async function migrarRetencao() {
  const r = await this.updateMany({ retencao_dias: { $exists: false } }, [
    {
      $set: {
        expira_em: { $subtract: ['$expira_em', (RETENCAO_DIAS_ANTIGA - RETENCAO_DIAS) * MS_DIA] },
        retencao_dias: RETENCAO_DIAS,
      },
    },
  ]);
  return { atualizados: r.modifiedCount };
};

const ContactoHospede = mongoose.model('ContactoHospede', contactoHospedeSchema);
ContactoHospede.RETENCAO_DIAS = RETENCAO_DIAS;

module.exports = ContactoHospede;
