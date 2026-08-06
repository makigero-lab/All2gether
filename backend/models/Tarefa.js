/**
 * Modelo: Tarefa (Limpeza/Manutenção de Alojamento Local)
 * Representa uma tarefa atribuída a um utilizador (staff).
 *
 * HF4 — smoobu_reserva_id re-introduzido (integração Smoobu reativada).
 * Usado para idempotência: o webhook procura tarefas existentes por este
 * campo antes de criar duplicados. Opcional — tarefas criadas manualmente
 * (sem origem Smoobu) ficam com smoobu_reserva_id = null.
 *
 * - utilizador_id pode ser null (tarefa por atribuir).
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
    // HF4 — ID da reserva no Smoobu (string, coercido). Usado para
    // idempotência no webhook (evita criar tarefas duplicadas para a mesma
    // reserva) e para cancelamento/atualização quando o Smoobu envia
    // eventos de update/cancel. Opcional (tarefas manuais não têm).
    smoobu_reserva_id: {
      type: String,
      default: null,
      trim: true,
      index: true,
      sparse: true,
    },
    // HF17 (Fase 3) — Origem da tarefa: Smoobu (via webhook) ou manual
    // (criada pelo gestor ou por um parceiro B2B no portal).
    origem: {
      type: String,
      enum: ['smoobu', 'manual'],
      default: 'manual',
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
    // Alerta automático gerado pelo webhook Smoobu (ex: "Staff exclusivo de folga").
    // Preenchido quando a tarefa é criada mas não pode ser atribuída ao staff
    // exclusivo da propriedade porque ele está de folga no dia do check-out.
    // O gestor vê este alerta no painel e gere a substituição manualmente.
    alerta: {
      type: String,
      default: null,
      trim: true,
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
    // v1.38.0 / HF13 — Avarias reportadas pelo staff durante a limpeza.
    // HF13: enriquecido de [String] para [{ descricao, fotos, resolvido,
    // data_registo }]. Retrocompatível: strings antigas (legacy) são lidas
    // pelo frontend como { descricao: <string>, resolvido: false }.
    avarias: {
      type: [
        {
          descricao: { type: String, required: true, trim: true },
          // URLs ou base64 das fotos (upload simplificado — o frontend pode
          // enviar base64 ou URLs de object storage futuro).
          fotos: { type: [String], default: [] },
          resolvido: { type: Boolean, default: false },
          data_registo: { type: Date, default: Date.now },
        },
      ],
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
    // detalhes_reserva mantido (dados da reserva de Alojamento Local:
    // check-in/check-out, hóspede). Preenchido pelo webhook Smoobu (HF4)
    // ou manualmente pelo gestor (criarTarefa com hora/hospedes).
    detalhes_reserva: {
      // Data/hora de check-in (ISO string ou YYYY-MM-DD).
      checkin: { type: String, default: null },
      // Data/hora de check-out (ISO string ou YYYY-MM-DD).
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
