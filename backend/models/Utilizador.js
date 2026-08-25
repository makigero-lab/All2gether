/**
 * Modelo: Utilizador
 * Representa um utilizador do sistema dentro de uma empresa.
 *
 * Roles (hierarquia):
 *   - admin   → dono da conta (gestão total: empresas, planos, utilizadores).
 *   - manager → responsável de limpezas (gere a equipa de staff, vê dashboard
 *               alargado, pode também executar limpezas).
 *   - staff   → executante de limpezas (vê apenas as suas tarefas no mobile).
 *
 * Autenticação (v1.3.0):
 *   - `email` é único (índice único) — serve de credencial de login.
 *   - `password_hash` guarda a hash bcrypt da password (nunca a password em claro).
 *
 * O webhook considera utilizadores com role "staff" OU "manager" e ativos=true
 * para atribuição de tarefas (o manager também pode executar limpezas).
 */
const mongoose = require('mongoose');

const utilizadorSchema = new mongoose.Schema(
  {
    nome: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    // Telemóvel para envio do Daily Briefing via WhatsApp.
    // Formato internacional (ex.: +351912345678).
    telefone: {
      type: String,
      trim: true,
      default: '',
    },
    // FIX (gestão de parceiros) — NIF do utilizador (particularmente relevante
    // para parceiros B2B que precisam de faturação). Opcional.
    nif: {
      type: String,
      trim: true,
      default: '',
    },
    // FIX (gestão de parceiros) — Observações livres sobre o utilizador
    // (notas internas do gestor — ex.: "Parceiro desde 2024", "Desconto 10%").
    // Opcional.
    observacoes: {
      type: String,
      trim: true,
      default: '',
    },
    // FIX (equipas preferenciais) — Se true, este staff SÓ é elegível para
    // tarefas de propriedades onde o seu ID conste na equipa_preferencial.
    // Staff com false (default) pode ser atribuído a qualquer propriedade.
    exclusivo_preferenciais: {
      type: Boolean,
      default: false,
    },
    // Hash bcrypt da password. Nunca armazenar a password em claro.
    password_hash: {
      type: String,
      // Não é `required` para permitir migrar utilizadores existentes sem
      // password (que terão de a definir depois). O login recusa se vazio.
    },
    empresa_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Empresa',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['admin', 'gestor', 'staff', 'parceiro'],
      default: 'staff',
      required: true,
    },
    // Superior hierárquico (responsável) do utilizador.
    // Referência a outro Utilizador (normalmente role 'admin' ou 'gestor').
    // O admin não tem responsavel_id (topo da hierarquia).
    responsavel_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      default: null,
      index: true,
    },
    ativo: {
      type: Boolean,
      default: true,
    },
    // Folgas fixas semanais: array de dias da semana (0=Dom, 1=Seg, ..., 6=Sáb).
    // O load balancer exclui automaticamente o staff cujo dia da semana
    // da tarefa está neste array (não precisa de marcar ausência manual).
    dias_folga: {
      type: [Number],
      default: [],
      validate: {
        validator: function (arr) {
          return arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        },
        message: 'dias_folga: valores devem ser inteiros entre 0 (Dom) e 6 (Sáb).',
      },
    },
    // Folgas rotativas: array de datas específicas (além das fixas semanais).
    // Cada entrada é { data: Date, motivo: String }.
    // O webhook (criarTarefaPorReserva) verifica se o staff exclusivo da
    // propriedade tem folga rotativa no dia do check-out. Se sim, a tarefa é
    // criada com estado 'por_atribuir' + alerta 'Staff exclusivo de folga'.
    folgas_rotativas: {
      type: [
        {
          data: { type: Date, required: true },
          motivo: { type: String, default: '', trim: true },
        },
      ],
      default: [],
    },
    // Soft delete: em vez de remover o utilizador da BD (o que deixaria
    // Tarefas antigas com utilizador_id órfão), marca-se a data de eliminação.
    // Utilizadores com eliminado_em !== null são excluídos das queries normais.
    eliminado_em: {
      type: Date,
      default: null,
      index: true,
    },
    // v1.27.0 — Notificações Push (Web Push API).
    // Subscrição gerada pelo browser (Service Worker) via PushManager.subscribe().
    // Guarda o objeto PushSubscription completo (endpoint + keys.p256dh + keys.auth).
    // Null = ainda não subscreveu. Se expirar (410 Gone), volta a null.
    pushSubscription: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Utilizador', utilizadorSchema);
