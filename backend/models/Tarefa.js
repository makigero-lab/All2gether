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
    // HF21 — Equipa atribuída (múltiplos staff). Quando staff_necessario > 1
    // na propriedade, o LB devolve Top N e este array é preenchido.
    // utilizador_id mantém-se como o vencedor #1 (retrocompatibilidade).
    // Se equipa_atribuida estiver vazia, a tarefa tem 1 staff (utilizador_id).
    // Regra: equipa_atribuida é a equipa COMPLETA e utilizador_id é o
    // RESPONSÁVEL (sempre membro). Ver utils/equipaTarefa.js.
    equipa_atribuida: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Utilizador',
      default: [],
      index: true,
    },
    // Pessoas que faltam para completar a equipa (staff_necessario - membros).
    // > 0 quando houve ausência e não foi encontrado substituto.
    pessoas_em_falta: {
      type: Number,
      default: 0,
      min: 0,
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
    // Alerta automático gerado pelo webhook Smoobu (ex: "Equipa exclusiva de folga").
    // Preenchido quando a tarefa é criada mas não pode ser atribuída ao staff
    // exclusivo da propriedade porque ele está de folga no dia do check-out.
    // O gestor vê este alerta no painel e gere a substituição manualmente.
    alerta: {
      type: String,
      default: null,
      trim: true,
    },
    // HF24 — Motivo detalhado de não atribuição (quando estado = 'por_atribuir'
    // ou 'nao_atribuida'). Preenchido pelo load balancer com a razão exata:
    // "Nenhum elemento da equipa disponível", "Todos de folga/férias", "SLA excedido", etc.
    motivo_nao_atribuicao: {
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
    // HF19 — Fotos obrigatórias na conclusão da tarefa.
    // O staff tem de anexar pelo menos 1 foto (máx. 5) para concluir.
    // Strings base64 ou URLs. O cron job limpezaFotos esvazia este array
    // 30 dias após a conclusão (RETENCAO_FOTOS_DIAS) para otimizar armazenamento.
    fotos_conclusao: {
      type: [String],
      default: [],
    },
    // HF19 — Data de conclusão (igual a concluida_em, mas com nome explícito
    // para o cron job de limpeza usar como referência).
    data_conclusao: {
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
          // Quando a avaria foi resolvida (null se aberta ou resolvida antes deste campo existir).
          // A retenção das fotos conta os 90 dias a partir daqui.
          data_resolucao: { type: Date, default: null },
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
      // Dados adicionais do Smoobu (hora de check-in/out, composição, notas, tipo).
      hora_checkin: { type: String, default: null, trim: true },
      hora_checkout: { type: String, default: null, trim: true },
      // Preferência de horário da limpeza indicada pelo parceiro (informativa).
      horario_preferido: { type: String, default: null, trim: true, maxlength: 60 },
      adultos: { type: Number, default: null, min: 0 },
      criancas: { type: Number, default: null, min: 0 },
      notas_hospede: { type: String, default: null, trim: true, maxlength: 2000 },
      // Tipo da reserva no Smoobu: 'reservation' | 'modification of booking' | 'cancellation'.
      tipo_reserva: { type: String, default: null, trim: true },
    },
    // HF23 — Número de hóspedes para cálculo dinâmico de lavandaria.
    // Vem do payload do Smoobu (adults + children) ou da capacidade da propriedade.
    hospedes: {
      type: Number,
      default: null,
      min: 0,
    },
    // FIX (portal lavandaria) — Controlo de roupa pelo fornecedor e staff.
    // roupa_entregue: marcado pelo fornecedor no portal /fornecedor quando
    //   entrega roupa limpa na propriedade (toggle Boolean).
    // sacos_roupa_suja: preenchido pelo staff ao concluir a limpeza (nº de
    //   sacos de roupa suja recolhidos para a lavandaria).
    roupa_entregue: {
      type: Boolean,
      default: false,
    },
    sacos_roupa_suja: {
      type: Number,
      default: 0,
      min: 0,
    },
    // FIX (sync parceiros) — Identifica se a tarefa foi gerada a partir de
    // uma reserva criada por um parceiro B2B (true) ou por outra via
    // (Smoobu / gestor manual). Usado para destaque visual na lista de
    // tarefas e filtro "Apenas Parceiros".
    origem_parceiro: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Tipo de limpeza: normal (saída, por omissão; também sem o campo), intermedia,
    // profunda ou preparacao. Define tempo e checklist no momento da criação (snapshot).
    // Não afeta preços nem faturação.
    // A checklist desta tarefa veio de uma checklist PRÓPRIA do tipo (e não da checklist base da casa).
    // O staff vê «segue a checklist própria desta casa» só quando é verdade.
    checklist_do_tipo: { type: Boolean, default: false },
    // true quando o gestor mudou o dia («Mudar dia»): o sistema não o recalcula sozinho.
    data_ajustada_gestor: { type: Boolean, default: false },
    tipo_limpeza: {
      type: String,
      enum: ['normal', 'intermedia', 'profunda', 'preparacao'],
      default: 'normal',
    },
  },
  { timestamps: true }
);

// Início da limpeza (híbrido): o staff carrega em «Comecei» (origem 'botao') ou, sem clique, o job
// de início passa a tarefa a 'em_curso' à hora marcada (origem 'automatico').
tarefaSchema.add({
  iniciada_em: { type: Date, default: null },
  inicio_origem: { type: String, enum: ['botao', 'automatico', null], default: null },
  iniciada_por: { type: mongoose.Schema.Types.ObjectId, ref: 'Utilizador', default: null },
  // Primeira vez que alguém marcou um item da checklist (prova de que o trabalho começou, usada
  // nos relatórios de tempo real quando o início foi automático).
  primeiro_item_checklist_em: { type: Date, default: null },
  // «Não consegui começar»: último registo do staff (motivo fixo + nota opcional).
  nao_consegui_comecar: {
    type: new mongoose.Schema(
      {
        motivo: { type: String, enum: ['hospede_na_casa', 'sem_acesso', 'casa_diferente'], required: true },
        nota: { type: String, default: '', trim: true, maxlength: 500 },
        em: { type: Date, default: Date.now },
        por: { type: mongoose.Schema.Types.ObjectId, ref: 'Utilizador', default: null },
      },
      { _id: false }
    ),
    default: undefined,
  },
  // Manutenção criada a partir de uma avaria: aponta para a limpeza onde foi reportada e para
  // o item do array `avarias` dessa limpeza. Ao concluir a manutenção, a avaria fica resolvida.
  avaria_origem_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa', default: null, index: true },
  avaria_origem_item_id: { type: mongoose.Schema.Types.ObjectId, default: null },
});
// Rotinas fixas: no máximo 1 tarefa automática por propriedade e dia (YYYY-MM-DD). Garante que
// duas instâncias do cron (ou duas execuções simultâneas) não duplicam. Índice parcial: só
// afeta documentos com `rotina_dia` preenchido.
tarefaSchema.add({ rotina_dia: { type: String, default: undefined } });
// O gestor desatribuiu à mão de propósito: o preenchimento automático de vagas não lhe mexe
// (limpa-se sozinho assim que a tarefa volta a ter responsável).
tarefaSchema.add({ desatribuida_manual: { type: Boolean, default: false } });
tarefaSchema.pre('validate', function limparDesatribuicaoManual() {
  if (this.utilizador_id && this.desatribuida_manual) this.desatribuida_manual = false;
});
// Oferta da vaga à equipa (ver utils/ofertaVaga.js): quando ninguém está disponível, a vaga é oferecida
// a toda a equipa não ausente; fica com ela quem aceitar primeiro, até ao prazo.
tarefaSchema.add({
  oferta_estado: { type: String, enum: ['aberta', 'aceite', 'expirada', 'fechada'], default: null, index: true },
  oferta_aberta_em: { type: Date, default: null },
  oferta_expira_em: { type: Date, default: null },
  oferta_dia: { type: String, default: null }, // AAAA-MM-DD a que a oferta se refere (se a limpeza mudar de dia, recomeça)
});
// O responsável (utilizador_id) é sempre membro da equipa quando esta existe.
// Tarefas antigas com equipa vazia ficam como estão (equivalem a equipa de 1).
// Se a limpeza deixa de estar em curso e volta ao circuito (reatribuída, desatribuída), o início
// registado deixa de valer: recomeça com a nova pessoa. 'concluida'/'cancelada' mantêm o histórico.
tarefaSchema.pre('validate', function limparInicioSeRecomeca() {
  if (this.isModified('estado') && ['atribuida', 'por_atribuir', 'nao_atribuida'].includes(this.estado) && this.iniciada_em) {
    this.iniciada_em = null;
    this.inicio_origem = null;
    this.iniciada_por = null;
  }
});
tarefaSchema.pre('validate', function normalizarEquipaDoResponsavel() {
  // Sem responsável e fora do circuito de trabalho: a equipa é libertada
  // (evita "membros fantasma" que continuariam a ver a tarefa).
  if (!this.utilizador_id && ['por_atribuir', 'nao_atribuida', 'cancelada'].includes(this.estado)) {
    if ((this.equipa_atribuida || []).length > 0) this.equipa_atribuida = [];
    if (this.pessoas_em_falta) this.pessoas_em_falta = 0;
  }
  const equipa = this.equipa_atribuida || [];
  if (this.utilizador_id && equipa.length > 0) {
    const resp = String(this.utilizador_id);
    const lista = [];
    for (const m of [this.utilizador_id, ...equipa]) {
      if (!lista.some((x) => String(x) === String(m))) lista.push(m);
    }
    if (lista.length !== equipa.length || String(equipa[0]) !== resp) {
      this.equipa_atribuida = lista;
    }
  }
});

tarefaSchema.index(
  { propriedade_id: 1, rotina_dia: 1 },
  { unique: true, partialFilterExpression: { rotina_dia: { $type: 'string' } } }
);

// Reservas Smoobu: no máximo 1 tarefa por (reserva, empresa). Protege contra corridas entre o
// webhook e a reconciliação periódica. Índice parcial (só valores string), por isso as tarefas
// manuais (smoobu_reserva_id null) não são afetadas. É um índice DIFERENTE do simples
// `smoobu_reserva_id` acima (chave composta + unique + parcial).
tarefaSchema.index(
  { smoobu_reserva_id: 1, empresa_id: 1 },
  {
    unique: true,
    name: 'smoobu_reserva_empresa_unico',
    partialFilterExpression: { smoobu_reserva_id: { $type: 'string' } },
  }
);

const Tarefa = mongoose.model('Tarefa', tarefaSchema);

// Se já existirem duplicados em produção a criação do índice falha (E11000 / IndexBuildFailed).
// Isso NÃO pode impedir o arranque: regista de forma clara e continua (sem a proteção).
Tarefa.on('index', (err) => {
  if (err && /smoobu_reserva_empresa_unico/.test(`${err.message} ${err.errmsg || ''}`)) {
    console.error(
      '⚠️  [Tarefa] Não foi possível criar o índice único smoobu_reserva_empresa_unico: provavelmente ' +
        'já existem tarefas duplicadas (mesma reserva Smoobu + empresa). A aplicação continua sem essa ' +
        'proteção. Remove/une os duplicados e reinicia para o índice ser criado. Detalhe: ' +
        err.message
    );
  }
});
// Evita que um 'error' emitido pelo modelo (falha de índice) sem listener derrube o processo.
Tarefa.on('error', (err) => {
  console.error('⚠️  [Tarefa] erro do modelo (índices):', err && err.message);
});

module.exports = Tarefa;
