/**
 * Modelo Notificacao — FisioCell
 *
 * Prompt 114 — Centro de Notificações In-App (O Sino).
 *
 * Representa uma notificação in-app dirigida a um utilizador específico.
 * Mostrada no sino do header (Gestor e Staff) com badge de não-lidas.
 *
 * Campos:
 *   - utilizador_id: destinatário (ref Utilizador)
 *   - mensagem: texto da notificação
 *   - lida: boolean (default false)
 *   - data: timestamp (default agora)
 *   - tipo: categoria opcional ('tarefa_atribuida', 'tarefa_reatribuida',
 *     'aviso', etc.) para futura filtragem/ícones
 *   - url: URL para abrir ao clicar (ex.: '/staff' para ir às tarefas)
 *
 * Índice em { utilizador_id, lida } para a query de contagem de não-lidas
 * ser rápida.
 */

const mongoose = require('mongoose');

const NotificacaoSchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },
    mensagem: {
      type: String,
      required: true,
      trim: true,
    },
    tipo: {
      type: String,
      enum: [
        'tarefa_atribuida',
        'tarefa_reatribuida',
        'tarefa_cancelada',
        'aviso',
        'sistema',
      ],
      default: 'sistema',
    },
    url: {
      type: String,
      default: '/staff',
    },
    // Prompt 116 — referência opcional à tarefa que originou a notificação
    // (ex.: para o frontend abrir o detalhe da tarefa ao clicar no sino).
    tarefa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tarefa',
      default: null,
      index: true,
    },
    lida: {
      type: Boolean,
      default: false,
      index: true,
    },
    data: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true, // createdAt + updatedAt
  }
);

// Índice composto para a query frequente: "não-lidas de um utilizador".
NotificacaoSchema.index({ utilizador_id: 1, lida: 1, createdAt: -1 });

module.exports = mongoose.model('Notificacao', NotificacaoSchema);
