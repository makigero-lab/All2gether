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
    // Reserva Smoobu de origem (para o webhook não recriar tarefas já arquivadas) e _id original.
    smoobu_reserva_id: { type: String, default: null, index: true },
    tarefa_original_id: { type: mongoose.Schema.Types.ObjectId, index: true },
    utilizador_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Utilizador', default: null, index: true },
    data: { type: Date, required: true, index: true },
    tempo_limpeza_minutos: { type: Number, required: true, default: 45, min: 0 },
    tipo: { type: String, enum: ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'], default: 'limpeza' },
    estado: { type: String, enum: ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada', 'nao_atribuida'], default: 'por_atribuir' },
    observacoes: { type: String, default: '' },
    observacoes_staff: { type: String, default: '' },
    concluida_em: { type: Date, default: null },
    hora_conclusao: { type: Date, default: null },
    avarias: { type: [mongoose.Schema.Types.Mixed], default: [] },
    checklist: { type: [String], default: [] },
    detalhes_reserva: {
      checkin: { type: String, default: null },
      checkout: { type: String, default: null },
      pax: { type: Number, default: null, min: 0 },
      nome_hospede: { type: String, default: null, trim: true },
      hora_checkin: { type: String, default: null, trim: true },
      hora_checkout: { type: String, default: null, trim: true },
      adultos: { type: Number, default: null, min: 0 },
      criancas: { type: Number, default: null, min: 0 },
      notas_hospede: { type: String, default: null, trim: true, maxlength: 2000 },
      tipo_reserva: { type: String, default: null, trim: true },
    },
  },
  // strict:false — o arquivo tem de preservar TODOS os campos da Tarefa (fotos, hospedes,
  // checklist_dinamica, origem...). Antes, o schema estrito apagava-os ao arquivar.
  { timestamps: true, strict: false }
);

module.exports = mongoose.model('TarefaArquivo', tarefaArquivoSchema, 'tarefas_arquivo');
