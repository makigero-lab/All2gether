/**
 * Modelo: Propriedade (Alojamento Local / Airbnb)
 * Representa um apartamento ou unidade de alojamento gerida pela empresa.
 *
 * HF4 — smoobu_id re-introduzido (integração Smoobu reativada). Usado pelo
 * webhook /api/smoobu/webhook para fazer match entre o apartamento Smoobu
 * (payload.data.apartment.id) e a Propriedade local. Opcional — propriedades
 * criadas manualmente (sem origem Smoobu) ficam com smoobu_id = null.
 */
const mongoose = require('mongoose');

const propriedadeSchema = new mongoose.Schema(
  {
    // HF4 — Identificador do apartamento no Smoobu (string, coercido).
    // Usado para match no webhook. Opcional (propriedades manuais não têm).
    smoobu_id: {
      type: String,
      default: null,
      trim: true,
      index: true,
      sparse: true,
    },
    nome: {
      type: String,
      required: true,
      trim: true,
    },
    // Morada completa da propriedade (para geocoding e otimização de rotas).
    morada: {
      type: String,
      required: true,
      trim: true,
    },
    // Coordenadas geográficas (preenchidas automaticamente via geocoding
    // Nominatim/OpenStreetMap ao criar a propriedade).
    coordenadas: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: true,
      index: true,
    },
    // Tempo de limpeza por defeito (minutos) — usado quando a tarefa
    // não especifica um tempo próprio.
    tempo_limpeza_minutos: {
      type: Number,
      default: 45,
      min: 0,
    },
    ativo: {
      type: Boolean,
      default: true,
    },
    // v1.34.0 — Checklist de limpeza da propriedade (lista de itens a verificar).
    // O staff vê esta lista ao concluir a tarefa e pode marcar cada item.
    // Definida pelo gestor no painel de propriedades.
    // Ex: ['Verificar toalhas', 'Esvaziar lixo', 'Trocar roupa de cama']
    checklist: {
      type: [String],
      default: [],
    },
    // Prompt 133 — Referência ao ModeloChecklist (template dinâmico).
    // Se definido, as novas tarefas de limpeza copiam as secções/items
    // deste modelo para checklist_dinamica na Tarefa (snapshot).
    modelo_checklist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ModeloChecklist',
      default: null,
      index: true,
    },
    // Prompt 125 — Observações livres da propriedade (notas internas do gestor).
    observacoes: {
      type: String,
      default: '',
      trim: true,
    },
    // v1.61.0 (Prompt 84) — Capacidade máxima de hóspedes (definida manualmente
    // ou vinda de integrações externas). Usada para estimar tempo
    // de limpeza e para display no gestor.
    capacidade_hospedes: {
      type: Number,
      default: null,
      min: 0,
    },
    // Prompt 92 (Fase 1.5) — Funcionário preferencial desta propriedade.
    // HF9 — Regra 1-para-1 ESTRITA: um staff só pode estar alocado a UMA
    // propriedade, e uma propriedade só pode ter UM staff responsável.
    // O índice único sparse garante que nenhum staff aparece em duas
    // propriedades (valores null são ignorados pelo sparse).
    // Ao associar um staff a uma propriedade, o gestorController remove-o
    // automaticamente de qualquer propriedade anterior.
    // O webhook (criarTarefaPorReserva) ignora o load balancer e atribui
    // DIRETAMENTE a este staff (salvo se estiver de folga — ver alerta).
    funcionario_preferencial_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      default: null,
      index: true,
      // Índice único sparse definido abaixo (no schema.index) para garantir 1-para-1.
    },
  },
  { timestamps: true }
);

// HF9 — Índice único parcial em funcionario_preferencial_id.
// Garante a regra 1-para-1: um staff NÃO pode ser o preferencial de duas
// propriedades. Usa partialFilterExpression (em vez de sparse) para só
// indexar documentos onde o campo NÃO é null — assim propriedades sem
// staff atribuído (default: null) não conflitam entre si.
propriedadeSchema.index(
  { funcionario_preferencial_id: 1 },
  {
    unique: true,
    partialFilterExpression: { funcionario_preferencial_id: { $ne: null } },
    name: 'funcionario_preferencial_unique_1to1',
  }
);

module.exports = mongoose.model('Propriedade', propriedadeSchema);
