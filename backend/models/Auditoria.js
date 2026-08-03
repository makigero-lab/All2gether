/**
 * Modelo: Auditoria
 * Regista ações administrativas para fins de auditoria e compliance.
 * Cada documento representa uma ação executada por um utilizador
 * (ex: criou propriedade, eliminou staff, atribuiu tarefa, etc).
 */
const mongoose = require('mongoose');

const auditoriaSchema = new mongoose.Schema(
  {
    // Utilizador que executou a ação (do JWT).
    utilizador_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      required: true,
      index: true,
    },
    utilizador_nome: {
      type: String,
      required: true,
    },
    // Single-tenant (Satélite): empresa_id pode estar ausente em ações sem
    // empresa no contexto (ex.: Super Admin via SSO). Opcional para não quebrar
    // a validação da auditoria e evitar 502s nos endpoints principais.
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: false,
      default: null,
      index: true,
    },
    // Tipo de ação (ex: 'criar', 'atualizar', 'eliminar', 'atribuir', 'falta_subita').
    acao: {
      type: String,
      required: true,
      index: true,
    },
    // Recurso afetado (ex: 'propriedade', 'utilizador', 'tarefa', 'ausencia').
    recurso: {
      type: String,
      required: true,
    },
    // ID do recurso afetado.
    recurso_id: {
      type: String,
      default: null,
    },
    // Descrição legível da ação.
    descricao: {
      type: String,
      required: true,
    },
    // Detalhes adicionais (ex: nome do staff, nome da propriedade).
    detalhes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true } // createdAt serve de timestamp da ação
);

// Índice para consultar auditoria por empresa + data.
auditoriaSchema.index({ empresa_id: 1, createdAt: -1 });

module.exports = mongoose.model('Auditoria', auditoriaSchema);
