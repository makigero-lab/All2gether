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
    // HF11 — Sistema HÍBRIDO (Many-to-One + Load Balancer):
    //   - Um staff PODE ser o preferencial de MÚLTIPLAS propriedades (X, Y, Z).
    //   - O webhook (criarTarefaPorReserva) tenta atribuir ao preferencial
    //     primeiro; se estiver de folga ou a propriedade não tiver preferencial,
    //     faz fallback para o load balancer (determinarUtilizadorAtribuido).
    // HF9 havia adicionado um índice unique (1-para-1 estrito) — foi REMOVIDO
    // em HF11. O drop do índice legacy é feito no arranque do servidor (server.js).
    funcionario_preferencial_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Propriedade', propriedadeSchema);
