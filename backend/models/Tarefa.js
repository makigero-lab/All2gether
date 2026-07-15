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
    // Prompt 138 (136 V2) — Tempo de viagem (em minutos) entre a tarefa
    // anterior do staff e esta. Calculado pelo scheduler (Haversine + 30km/h,
    // capped a 60min). Guardado na BD para o frontend poder desenhar as rotas
    // e para auditoria do load balancer.
    tempo_viagem_minutos: {
      type: Number,
      default: 0,
      min: 0,
    },
    tipo: {
      type: String,
      enum: ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'],
      default: 'limpeza',
    },
    estado: {
      type: String,
      // Prompt 138 (136 V2) — 'nao_atribuida' é usado quando TODOS os staff
      // excedem o SLA de 480 min. Diferente de 'por_atribuir' (que significa
      // "ainda não foi tentada a atribuição"). 'nao_atribuida' = "tentou-se
      // atribuir mas não coube em nenhum staff — requer intervenção do gestor".
      enum: ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada', 'nao_atribuida'],
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
    // Prompt 133 — Checklist Dinâmica (snapshot de ModeloChecklist).
    // Estrutura: [{ nome: "Quartos", items: [{ texto: "Trocar roupa", concluido: false }] }]
    // Copiada do ModeloChecklist da propriedade no momento da criação da tarefa.
    // O staff marca/desmarca items individuais via PATCH.
    checklist_dinamica: [
      {
        nome: { type: String, required: true, trim: true },
        items: [
          {
            texto: { type: String, required: true, trim: true },
            concluido: { type: Boolean, default: false },
          },
        ],
      },
    ],
    // Prompt 92 (Fase 1.5) — Detalhes da reserva Smoobu associada à tarefa.
    // Snapshot dos dados da reserva no momento da criação/atualização da
    // tarefa, para auditoria e display (cartão da tarefa, detalhe do staff,
    // relatórios). Preparado para Fase 1.5 — o campo existe no modelo mas o
    // preenchimento a partir do payload do webhook/sincronização será feito
    // num prompt seguinte.
    detalhes_reserva: {
      // ID original da reserva no Smoobu (Prompt 102) — usado para
      // encontrar e eliminar tarefas fantasma quando a reserva é cancelada.
      smoobu_reserva_id: { type: String, default: null },
      // Data/hora de check-in (ISO string ou YYYY-MM-DD conforme o Smoobu).
      checkin: { type: String, default: null },
      // Data/hora de check-out (ISO string ou YYYY-MM-DD conforme o Smoobu).
      checkout: { type: String, default: null },
      // Número de hóspedes (pax) da reserva.
      pax: { type: Number, default: null, min: 0 },
      // Nome do hóspede principal da reserva.
      nome_hospede: { type: String, default: null, trim: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Tarefa', tarefaSchema);
