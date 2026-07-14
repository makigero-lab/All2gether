/**
 * Modelo: ModeloChecklist (Template)
 *
 * Prompt 133 — Sistema de Checklists Dinâmicas baseadas em Templates.
 *
 * Representa um template de checklist que pode ser associado a propriedades.
 * Quando uma tarefa de limpeza é criada, o template é copiado (snapshot)
 * para o campo `checklist_dinamica` da Tarefa — alterações futuras no
 * template não afetam tarefas antigas.
 *
 * Estrutura:
 *   - empresa_id: scoping multi-tenant
 *   - nome: ex: "Limpeza T2", "Limpeza T0", "Manutenção"
 *   - descricao: descrição opcional
 *   - seccoes: array de secções, cada uma com nome + items
 *     - ex: { nome: "Quartos", items: ["Trocar roupa de cama", "Verificar armário"] }
 */

const mongoose = require('mongoose');

const modeloChecklistSchema = new mongoose.Schema(
  {
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: true,
      index: true,
    },
    nome: {
      type: String,
      required: true,
      trim: true,
    },
    descricao: {
      type: String,
      default: '',
      trim: true,
    },
    seccoes: [
      {
        nome: {
          type: String,
          required: true,
          trim: true,
        },
        items: [
          {
            type: String,
            required: true,
            trim: true,
          },
        ],
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('ModeloChecklist', modeloChecklistSchema);
