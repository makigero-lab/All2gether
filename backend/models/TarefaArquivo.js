/**
 * Modelo: TarefaArquivo
 *
 * Cópia exata do schema da Tarefa, usada para arquivar tarefas concluídas
 * ou canceladas com mais de 3 meses. Mantém todos os dados para auditoria
 * futura, mas fora da coleção principal para garantir a performance.
 *
 * F0: Removido smoobu_reserva_id (integração Smoobu eliminada).
 *
 * Campo extra:
 *   - arquivado_em: data em que a tarefa foi movida para o arquivo.
 */

const mongoose = require('mongoose');

const tarefaArquivoSchema = new mongoose.Schema(
  {
    // Metadados do arquivo.
    arquivado_em: {
      type: Date,
      default: Date.now,
    },
    // Campos originais da Tarefa (mesmo schema).
    empresa_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, index: true },
    propriedade_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriedade', required: true, index: true },
    // F0 — smoobu_reserva_id removido.
    utilizador_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Utilizador', default: null, index: true },
    data: { type: Date, required: true, index: true },
    tempo_limpeza_minutos: { type: Number, required: true, default: 45, min: 0 },
    tipo: { type: String, enum: ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'], default: 'limpeza' },
    estado: { type: String, enum: ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada'], default: 'por_atribuir' },
    observacoes: { type: String, default: '' },
    observacoes_staff: { type: String, default: '' },
    concluida_em: { type: Date, default: null },
    hora_conclusao: { type: Date, default: null },
    avarias: { type: [String], default: [] },
    checklist: { type: [String], default: [] },
    detalhes_reserva: {
      checkin: { type: String, default: null },
      checkout: { type: String, default: null },
      pax: { type: Number, default: null, min: 0 },
      nome_hospede: { type: String, default: null, trim: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TarefaArquivo', tarefaArquivoSchema, 'tarefas_arquivo');
