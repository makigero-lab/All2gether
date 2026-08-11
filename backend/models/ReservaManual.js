/**
 * Modelo: ReservaManual — All2gether (HF23)
 *
 * Reservas criadas manualmente por Parceiros B2B no portal do parceiro.
 * Ao criar uma reserva, o sistema gera automaticamente uma Tarefa de Limpeza
 * para o dia de check-out.
 */
const mongoose = require('mongoose');

const reservaManualSchema = new mongoose.Schema(
  {
    propriedade_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Propriedade',
      required: true,
      index: true,
    },
    parceiro_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      required: true,
      index: true,
    },
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: true,
      index: true,
    },
    check_in: {
      type: Date,
      required: true,
    },
    check_out: {
      type: Date,
      required: true,
    },
    hospedes: {
      type: Number,
      default: null,
      min: 0,
    },
    observacoes: {
      type: String,
      default: '',
      trim: true,
    },
    // ID da tarefa de limpeza gerada automaticamente para o check-out.
    tarefa_gerada_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tarefa',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReservaManual', reservaManualSchema);
