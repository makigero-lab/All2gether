/**
 * Modelo: Ausencia
 * Regista férias ou ausências de um utilizador (Staff/Manager) num intervalo de datas.
 *
 * v1.24.0 — Fluxo de aprovação:
 *   - `estado`: 'pendente' | 'aprovada' | 'rejeitada' (default 'pendente').
 *     O staff cria pedidos (sempre 'pendente'); o admin aprova/rejeita.
 *     Aprovar → redistribui tarefas do período (load balancer).
 *   - `tipo`: 'ferias' | 'doenca' | 'outro' (default 'ferias'). Substitui o
 *     enum antigo ['ferias', 'folga'] — as "folgas" passam a ser geridas
 *     pelo campo `dias_folga` do Utilizador (folgas fixas semanais).
 *
 * v1.16.0 — Limpeza de retrocompatibilidade:
 *   O campo legacy `data` (v1.1.0, dia único) foi REMOVIDO. O modelo
 *   passa a usar exclusivamente `data_inicio` / `data_fim` (intervalos).
 *
 * v1.8.0 — Sistema de Folgas e Férias:
 *   - `data_inicio` / `data_fim` definem o intervalo (inclusive).
 *
 * O webhook consulta Ausencia para excluir staff indisponível no dia da limpeza.
 * Nota: o webhook só considera ausências com estado 'aprovada' (pendentes e
 * rejeitadas não bloqueiam a atribuição).
 */
const mongoose = require('mongoose');

const ausenciaSchema = new mongoose.Schema(
  {
    utilizador_id: {
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
    // Intervalo de datas (inclusive). Ambas obrigatórias.
    data_inicio: {
      type: Date,
      required: true,
      index: true,
    },
    data_fim: {
      type: Date,
      required: true,
      index: true,
    },
    // v1.24.0: enum alargado. As "folgas" fixas semanais passaram para o
    // campo `dias_folga` do Utilizador (v1.14.0).
    tipo: {
      type: String,
      enum: ['ferias', 'doenca', 'outro'],
      default: 'ferias',
      required: true,
    },
    // v1.24.0: fluxo de aprovação.
    // v1.26.0: adicionado 'pendente_emergencia' — falta criada pelo próprio
    // funcionário para o dia atual (doença súbita). O admin aprova e dispara
    // a redistribuição imediata das tarefas do dia.
    // v1.39.0 (Prompt 131b): adicionado 'cancelada' — soft cancel mantém o
    // histórico para auditoria (em vez de DELETE que apaga o registo).
    estado: {
      type: String,
      enum: ['pendente', 'pendente_emergencia', 'aprovada', 'rejeitada', 'cancelada'],
      default: 'pendente',
      required: true,
      index: true,
    },
    // v1.26.0: justificação enviada pelo staff ao reportar falta de emergência.
    justificacao: {
      type: String,
      trim: true,
      default: '',
    },
    notas: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

// Antes de guardar: normaliza data_inicio/data_fim para meia-noite UTC.
ausenciaSchema.pre('save', function preSave(next) {
  if (this.data_inicio) {
    const d = new Date(this.data_inicio);
    this.data_inicio = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
  }
  if (this.data_fim) {
    const d = new Date(this.data_fim);
    this.data_fim = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
  }
  next();
});

// Prompt 116 — O índice único composto { utilizador_id, data_inicio } foi
// REMOVIDO. Antes, bloqueava a criação de uma nova ausência mesmo quando a
// existente estava 'rejeitada' (o índice não distingue estados). Como o
// Prompt 116 exige que ausências rejeitadas NÃO bloqueiem a criação de novos
// pedidos no mesmo período, a verificação de sobreposição passou a ser feita
// EXCLUSIVAMENTE no controller (registarAusencia), que exclui 'rejeitada' na
// query. MongoDB partial indexes não suportam $ne em partialFilterExpression,
// pelo que remover o índice único é a solução mais limpa. A verificação do
// controller continua a impedir duplicados reais (mesmo período, mesmo user,
// estado pendente/aprovada).
// Índices não-únicos para queries frequentes:
ausenciaSchema.index({ utilizador_id: 1, data_inicio: 1 });
ausenciaSchema.index({ empresa_id: 1, estado: 1 });

module.exports = mongoose.model('Ausencia', ausenciaSchema);
