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
    // FIX (morada estruturada) — Deixou de ser `required`. As novas propriedades
    // são criadas via `morada_estruturada` (rua/codigo_postal/cidade). O campo
    // `morada` (string única) mantém-se para retrocompatibilidade das 46
    // propriedades existentes. O virtual `moradaCompleta` concatena os 3 campos
    // estruturados OU faz fallback para `morada`.
    morada: {
      type: String,
      required: false,
      default: '',
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
    // FIX (parceiro associado) — Este campo guarda também a linha
    // "Parceiro Associado: [nome]" adicionada pela rota de migração
    // /api/fix-migracao. O frontend extrai esta linha para mostrar o Badge
    // do parceiro na listagem de propriedades.
    observacoes: {
      type: String,
      default: '',
      trim: true,
    },
    // FIX (morada estruturada) — Morada decomposta em campos estruturados
    // (rua, codigo_postal, cidade) para melhor UX e geocoding. Retrocompatível:
    // o campo `morada` (string única) mantém-se para as 46 propriedades
    // existentes que foram importadas antes desta alteração. A lógica:
    //   - Criar/Editar via form: preenche rua/codigo_postal/cidade.
    //   - Se morada_estruturada tiver pelo menos `rua`, usa-a para geocoding
    //     e para display. Senão, fallback para `morada` (string única).
    //   - O getter virtual `moradaCompleta` (ver baixo) concatena os 3 campos
    //     ou faz fallback para `morada`.
    morada_estruturada: {
      rua: { type: String, default: '', trim: true },
      codigo_postal: { type: String, default: '', trim: true },
      cidade: { type: String, default: '', trim: true },
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
    // HF17 (Fase 3) — Origem da propriedade: Smoobu (via webhook/importação)
    // ou manual (criada pelo gestor ou por um parceiro B2B).
    origem: {
      type: String,
      enum: ['smoobu', 'manual'],
      default: 'manual',
      index: true,
    },
    // HF17 — Se a propriedade foi criada por um parceiro B2B, este campo
    // guarda o ID do utilizador-parceiro a quem pertence. Null para
    // propriedades do Smoobu ou criadas pelo gestor internamente.
    parceiro_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Utilizador',
      default: null,
      index: true,
    },
    // HF21 — Número de staff necessário para limpar esta propriedade.
    // Se > 1, o load balancer atribui uma equipa (Top N) em vez de 1 pessoa.
    // Default: 1 (comportamento original — 1 staff por tarefa).
    staff_necessario: {
      type: Number,
      default: 1,
      min: 1,
    },
    // HF22 — Dias fixos de limpeza semanal (rotinas automáticas).
    // Array de números (0=Dom, 1=Seg, ..., 6=Sáb — standard JS getDay()).
    // O cron job geradorRotinas corre diariamente e, para cada propriedade
    // que tenha o dia de amanhã neste array, cria uma tarefa automática.
    dias_fixos_limpeza: {
      type: [Number],
      default: [],
      validate: {
        validator: function (arr) {
          return arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        },
        message: 'dias_fixos_limpeza: valores devem ser inteiros entre 0 (Dom) e 6 (Sáb).',
      },
    },
    // HF23 — Campos de gestão da propriedade.
    nome_responsavel: {
      type: String,
      default: '',
      trim: true,
    },
    contacto: {
      type: String,
      default: '',
      trim: true,
    },
    frequencia_limpeza: {
      type: String,
      enum: ['semanal', 'quinzenal', 'mensal'],
      default: 'semanal',
    },
    horario_limpeza: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Virtual — moradaCompleta                                           */
/* ------------------------------------------------------------------ */
// FIX (morada estruturada) — Devolve a morada completa como string, seja ela
// estruturada (rua + codigo_postal + cidade) ou legada (campo `morada`).
// Usado pelo frontend para display e pelo geocoder para obter coordenadas.
// Prioridade: morada_estruturada.rua > morada (legado) > string vazia.
propriedadeSchema.virtual('moradaCompleta').get(function () {
  const me = this.morada_estruturada;
  if (me && me.rua && String(me.rua).trim()) {
    const partes = [me.rua.trim()];
    if (me.codigo_postal && String(me.codigo_postal).trim()) {
      partes.push(me.codigo_postal.trim());
    }
    if (me.cidade && String(me.cidade).trim()) {
      partes.push(me.cidade.trim());
    }
    return partes.join(', ');
  }
  // Fallback para morada legada (string única).
  return this.morada || '';
});

// Garante que os virtuals são serializados em toJSON/toObject.
propriedadeSchema.set('toJSON', { virtuals: true });
propriedadeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Propriedade', propriedadeSchema);
