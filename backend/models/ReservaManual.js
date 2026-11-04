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
    // Dados adicionais da reserva (opcionais).
    nome_hospede: { type: String, default: null, trim: true, maxlength: 120 },
    plataforma: { type: String, default: null, trim: true, maxlength: 40 },
    hora_checkin: { type: String, default: null, trim: true, maxlength: 60 },
    // Preferência do parceiro para a limpeza (ex.: "11h - 14h", "depois das 11h").
    // É só uma preferência: a hora real da tarefa é decidida pelo sistema.
    horario_preferido: { type: String, default: null, trim: true, maxlength: 60 },
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
