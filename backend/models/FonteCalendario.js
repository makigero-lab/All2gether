/**
 * Modelo: FonteCalendario — All2gether.
 *
 * Um calendário externo (iCal) ligado a uma casa de um proprietário: um documento por casa e canal.
 * O link é uma credencial: guarda-se SÓ cifrado (AES-256-GCM, ver utils/calendarioExterno/cifra.js),
 * com `select: false`, e a API só devolve a máscara.
 */
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;
const CODIGOS_ERRO = ['timeout', 'dns', 'ip_bloqueado', 'redirect_invalido', 'tls', 'http_4xx', 'http_404_410', 'http_429', 'http_5xx', 'tamanho', 'formato', 'outro'];

const fonteSchema = new mongoose.Schema(
  {
    empresa_id: { type: ObjectId, ref: 'Empresa', required: true },
    propriedade_id: { type: ObjectId, ref: 'Propriedade', required: true },
    parceiro_id: { type: ObjectId, ref: 'Utilizador', required: true },
    criada_por: { type: ObjectId, ref: 'Utilizador' },
    canal: { type: String, enum: ['airbnb', 'booking', 'vrbo', 'outro'], required: true },
    canal_chave: { type: String, required: true, maxlength: 120 },
    rotulo: { type: String, maxlength: 40, default: null },
    url_cifrada: { type: String, select: false },
    url_hash: { type: String, select: false },
    url_mascara: { type: String, maxlength: 80 },
    url_host: { type: String, maxlength: 120 },
    estado: { type: String, enum: ['ativa', 'erro', 'pausada', 'suspensa'], default: 'ativa' },
    motivo_estado: {
      type: String,
      enum: ['casa_inativa', 'parceiro_inativo', 'empresa_inativa', 'casa_ligada_smoobu', 'erros_persistentes', 'acordo_por_aceitar', 'pelo_gestor', 'pelo_parceiro', null],
      default: null,
    },
    pausada_em: Date,
    removida: { type: Boolean, default: false },
    removida_em: Date,
    removida_por: { type: ObjectId, ref: 'Utilizador' },
    apagar_apos: Date,
    proxima_leitura_em: Date,
    ultima_leitura_em: Date,
    ultimo_sucesso_em: Date,
    ultima_alteracao_em: Date,
    erros_consecutivos: { type: Number, default: 0, min: 0 },
    suspeitas_consecutivas: { type: Number, default: 0, min: 0 },
    ultimo_erro: {
      em: Date,
      codigo: { type: String, enum: [...CODIGOS_ERRO, null] },
      http_status: Number,
      mensagem: { type: String, maxlength: 300 },
    },
    etag: { type: String, maxlength: 200 },
    last_modified: { type: String, maxlength: 200 },
    ultimo_hash_normalizado: String,
    referencia_futuros: { type: Number, default: 0 },
    ultimo_n_futuros: { type: Number, default: 0 },
    // «Aceitar o calendário como está»: a leitura seguinte não aplica a regra de sanidade.
    aceitar_proxima: { type: Boolean, default: false },
    prodid_esperado: { type: String, maxlength: 200 },
    uid_instavel: { type: Boolean, default: false },
    aviso_falha_enviado_em: Date,
    aviso_suspeita_enviado_em: Date,
    aviso_muitos_novos_em: Date, // aviso ao gestor de uma leitura com reservas novas a mais (enviado uma vez)
    vazio_desde: Date, // desde quando o calendário vem VAZIO (leituras seguidas); só então se começa a contar as 24 h
    pedido_manual_em: Date,
  },
  { timestamps: true }
);

// Uma fonte por canal e casa (Airbnb + Booking na mesma casa continua possível).
fonteSchema.index({ propriedade_id: 1, canal_chave: 1 }, { unique: true, partialFilterExpression: { removida: false } });
// O mesmo link não pode estar ativo em duas casas (nem em duas empresas).
fonteSchema.index({ url_hash: 1 }, { unique: true, partialFilterExpression: { removida: false, url_hash: { $type: 'string' } } });
fonteSchema.index({ removida: 1, estado: 1, proxima_leitura_em: 1 });
fonteSchema.index({ empresa_id: 1, propriedade_id: 1 });
fonteSchema.index({ parceiro_id: 1, removida: 1 });
// TTL: só se preenche ao remover (removida_em + 30 dias).
fonteSchema.index({ apagar_apos: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.FonteCalendario || mongoose.model('FonteCalendario', fonteSchema);
module.exports.CODIGOS_ERRO = CODIGOS_ERRO;
