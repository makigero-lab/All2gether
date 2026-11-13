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
    // Normal e profunda ficam no check-out; intermedia a meio da estadia e preparacao no check-in (automático).
    tipo_limpeza: { type: String, enum: ['normal', 'intermedia', 'profunda', 'preparacao'], default: 'normal' },
    // Dia da limpeza calculado pelo sistema (só intermedia/preparacao; null nos outros). O parceiro não o escolhe; o valor gravado numa reserva antiga continua a valer.
    data_limpeza: { type: Date, default: null },
    // true quando o gestor mudou o dia da limpeza: o sistema deixa de a recalcular (notas, hóspedes...);
    // se o parceiro mudar check-in/check-out ou tipo, recalcula e avisa o gestor.
    data_limpeza_ajustada: { type: Boolean, default: false },
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
    // Quem marcou a reserva quando foi o gestor em nome do proprietário (continua a ser uma reserva
    // normal dele: ele pode editá-la e apagá-la). Sem o campo = criada pelo próprio proprietário.
    criada_por: { type: mongoose.Schema.Types.ObjectId, ref: 'Utilizador', default: undefined },
    criada_pelo_gestor: { type: Boolean, default: false },
    // Origem da reserva: 'manual' (por omissão; as antigas não têm o campo) ou 'ical' (importada de
    // um calendário Airbnb/Booking/outro). As reservas ligadas a um calendário («sincronizada») têm as
    // datas bloqueadas: vêm do canal.
    origem: { type: String, enum: ['manual', 'ical'], default: 'manual' },
    reserva_externa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ReservaExterna', default: undefined },
    sincronizada: { type: Boolean, default: false },
    // Cancelada pelo canal (ou pelo proprietário, numa reserva sincronizada): a linha fica na tabela.
    cancelada_em: { type: Date, default: null },
    cancelada_motivo: { type: String, enum: ['canal', 'parceiro', 'ligacao_removida', null], default: null },
  },
  { timestamps: true }
);

// Único por parceiro, parcial: só documentos que têm a chave (os antigos não têm
// o campo, por isso a criação do índice nunca falha com dados já existentes).
reservaManualSchema.index(
  { parceiro_id: 1, chave_idempotencia: 1 },
  { unique: true, partialFilterExpression: { chave_idempotencia: { $type: 'string' } } }
);

// Uma reserva por evento do calendário: garante na BD que duas leituras simultâneas nunca criam duas
// reservas (nem duas limpezas) para o mesmo evento. Parcial: as reservas antigas não têm o campo.
reservaManualSchema.index(
  { reserva_externa_id: 1 },
  { unique: true, partialFilterExpression: { reserva_externa_id: { $type: 'objectId' } } }
);

module.exports = mongoose.model('ReservaManual', reservaManualSchema);
