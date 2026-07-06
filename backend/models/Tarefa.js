/**
 * Modelo: Tarefa
 * Representa uma tarefa de limpeza/trabalho gerada a partir de uma reserva.
 *
 * - utilizador_id pode ser null (tarefa por atribuir — o Admin atribui manualmente).
 * - tempo_limpeza_minutos é a unidade usada no cálculo de carga (load balancing).
 * - data é normalizada para meia-noite UTC (dia do check-in).
 */
const mongoose = require('mongoose');

const tarefaSchema = new mongoose.Schema(
  {
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: true,
      index: true,
    },
    propriedade_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Propriedade',
      required: true,
      index: true,
    },
    // ID da reserva no Smoobu (para auditoria / idempotência futura)
    smoobu_reserva_id: {
      type: String,
      index: true,
    },
    utilizador_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      default: null,
      index: true,
    },
    data: {
      type: Date,
      required: true,
      index: true,
    },
    tempo_limpeza_minutos: {
      type: Number,
      required: true,
      default: 45,
      min: 0,
    },
    tipo: {
      type: String,
      enum: ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'],
      default: 'limpeza',
    },
    estado: {
      type: String,
      enum: ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada'],
      default: 'por_atribuir',
    },
    // Observações gerais (gestor/admin).
    observacoes: {
      type: String,
      default: '',
    },
    // v1.34.0 — Observações do staff ao concluir a tarefa (separadas das gerais).
    observacoes_staff: {
      type: String,
      default: '',
    },
    // Data em que a tarefa foi concluída (para relatórios).
    concluida_em: {
      type: Date,
      default: null,
    },
    // v1.34.0 — Hora exata de conclusão (timestamp preciso, para auditoria).
    hora_conclusao: {
      type: Date,
      default: null,
    },
    // v1.38.0 — Avarias reportadas pelo staff durante a limpeza.
    // Array de strings (descrição do problema). Cada item é uma avaria.
    avarias: {
      type: [String],
      default: [],
    },
    // v1.55.0 (Prompt 77) — Checklist snapshot da propriedade no momento
    // da criação da tarefa. Copiada de Propriedade.checklist para que a
    // tarefa mantenha os itens originais mesmo se o gestor editar a
    // checklist da propriedade depois. O staff vê esta lista ao concluir.
    checklist: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Tarefa', tarefaSchema);
