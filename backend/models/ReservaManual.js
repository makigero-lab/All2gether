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
    // Tipo de limpeza (normal, intermedia, profunda, preparacao). Sem o campo = normal.
    // Normal e profunda ficam no check-out; intermedia e preparacao usam `data_limpeza`.
    tipo_limpeza: { type: String, enum: ['normal', 'intermedia', 'profunda', 'preparacao'], default: 'normal' },
    // Dia da limpeza escolhido pelo parceiro (só intermedia/preparacao; null nos outros).
    data_limpeza: { type: Date, default: null },
    // ID da tarefa de limpeza gerada automaticamente para o check-out.
    tarefa_gerada_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tarefa',
      default: null,
    },
    // Chave de idempotência enviada pelo cliente (o `tmp` da linha no rascunho do
    // parceiro): se a resposta se perder, o "Gravar" seguinte reenvia a mesma
    // chave e não cria uma segunda reserva/limpeza. Só existe em reservas novas.
    chave_idempotencia: { type: String, default: undefined, maxlength: 100 },
  },
  { timestamps: true }
);

// Único por parceiro, parcial: só documentos que têm a chave (os antigos não têm
// o campo, por isso a criação do índice nunca falha com dados já existentes).
reservaManualSchema.index(
  { parceiro_id: 1, chave_idempotencia: 1 },
  { unique: true, partialFilterExpression: { chave_idempotencia: { $type: 'string' } } }
);

module.exports = mongoose.model('ReservaManual', reservaManualSchema);
