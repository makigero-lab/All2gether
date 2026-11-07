/**
 * Tipos de limpeza — All2gether.
 *
 * Quatro tipos: normal (saída, por omissão), intermedia, profunda e preparacao.
 *  - normal e profunda: no dia do check-out (como sempre);
 *  - intermedia: data escolhida, entre o check-in e o check-out (inclusive);
 *  - preparacao: data escolhida, até ao check-in (inclusive).
 * A ausência do campo (reservas e tarefas antigas, Smoobu) conta como normal.
 * O tipo NÃO muda preços nem faturação.
 *
 * Tempo: cada casa pode ter um tempo por tipo (`tempos_limpeza_por_tipo`); sem tempo
 * configurado usa `tempo_limpeza_minutos` da casa (normal usa sempre esse).
 * Checklist: cada casa pode ter uma lista por tipo (`checklists_por_tipo`); sem lista
 * própria usa a checklist atual da casa (`checklist`).
 */

const TIPOS_LIMPEZA = ['normal', 'intermedia', 'profunda', 'preparacao'];
/** Tipos com data escolhida pelo parceiro (obrigatória). */
const TIPOS_COM_DATA = ['intermedia', 'preparacao'];
/** Tipos configuráveis por casa (normal usa os valores base da casa). */
const TIPOS_CONFIGURAVEIS = ['intermedia', 'profunda', 'preparacao'];

const ROTULOS_TIPO = {
  normal: 'Normal',
  intermedia: 'Intermédia',
  profunda: 'Profunda',
  preparacao: 'Preparação',
};

const semAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Normaliza o tipo recebido. Vazio/ausente = normal. Aceita o código ou o rótulo
 * (sem acentos nem maiúsculas). Qualquer outra coisa é inválida (fail closed).
 * @returns {{ ok: boolean, tipo?: string }}
 */
function normalizarTipo(valor) {
  if (valor === undefined || valor === null) return { ok: true, tipo: 'normal' };
  if (typeof valor !== 'string') return { ok: false };
  const v = semAcentos(valor.trim().toLowerCase());
  if (v === '') return { ok: true, tipo: 'normal' };
  return TIPOS_LIMPEZA.includes(v) ? { ok: true, tipo: v } : { ok: false };
}

/** Tipo de uma reserva/tarefa (lean ou documento); sem campo = normal. */
function tipoDe(doc) {
  const t = doc && doc.tipo_limpeza;
  return TIPOS_LIMPEZA.includes(t) ? t : 'normal';
}

/** O tipo está na classe «saída» (no dia do check-out)? */
const eSaida = (tipo) => !TIPOS_COM_DATA.includes(tipo);

/** Tempo da limpeza para o tipo: o da casa para esse tipo, ou `tempo_limpeza_minutos`. */
function tempoDoTipo(propriedade, tipo) {
  const base = Number(propriedade && propriedade.tempo_limpeza_minutos) || 45;
  if (!TIPOS_CONFIGURAVEIS.includes(tipo)) return base;
  const t = Number(propriedade && propriedade.tempos_limpeza_por_tipo && propriedade.tempos_limpeza_por_tipo[tipo]);
  return Number.isFinite(t) && t > 0 ? t : base;
}

/** Checklist (lista de textos) para o tipo: a própria do tipo, ou a atual da casa. */
function checklistDoTipo(propriedade, tipo) {
  if (TIPOS_CONFIGURAVEIS.includes(tipo)) {
    const propria = propriedade && propriedade.checklists_por_tipo && propriedade.checklists_por_tipo[tipo];
    if (Array.isArray(propria) && propria.length > 0) return [...propria];
  }
  return [...((propriedade && propriedade.checklist) || [])];
}

/** Há checklist própria para este tipo (então a checklist dinâmica do modelo não se aplica)? */
function temChecklistPropria(propriedade, tipo) {
  const p = propriedade && propriedade.checklists_por_tipo && propriedade.checklists_por_tipo[tipo];
  return TIPOS_CONFIGURAVEIS.includes(tipo) && Array.isArray(p) && p.length > 0;
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}/;

/**
 * Dia (YYYY-MM-DD) de uma data. Texto com hora (ISO) usa os 10 primeiros caracteres tal
 * como vêm (sem converter para UTC); um Date usa o dia UTC. Inválido = null.
 */
function diaTexto(v) {
  let d = null;
  if (v instanceof Date) d = Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  else if (typeof v === 'string' && RE_DIA.test(v.trim())) d = v.trim().slice(0, 10);
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}

const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);

/** Soma `n` dias a um dia AAAA-MM-DD. */
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Dia automático da limpeza (o parceiro não o escolhe):
 *  - normal e profunda: check-out;
 *  - intermédia: a meio da estadia = check-in + metade das noites (arredondado para baixo);
 *    numa estadia de 1 noite (ou sem noites) fica no check-out;
 *  - preparação: dia do check-in.
 * @returns {string} AAAA-MM-DD
 */
function diaAutomatico(tipo, ci, co) {
  if (tipo === 'preparacao') return ci;
  if (tipo === 'intermedia') {
    const noites = diasEntre(ci, co);
    return noites <= 1 ? co : somarDias(ci, Math.floor(noites / 2));
  }
  return co;
}

/**
 * Dia da limpeza e validações por tipo. O dia é AUTOMÁTICO (ver `diaAutomatico`).
 * `data_gravada` é a data já guardada numa reserva antiga (ou ajustada): se ainda é
 * válida para o tipo e para a estadia, continua a valer; o que o parceiro enviar
 * como `data_limpeza` nunca chega aqui (é ignorado pelos controladores).
 * `ajustada`: a data gravada foi escolhida pelo gestor («Mudar dia») e prevalece.
 * `hoje` (AAAA-MM-DD), se vier, recusa uma preparação cujo check-in já passou.
 * @returns {{ erro: string } | { dataLimpeza: Date|null, dia: string }}
 */
function resolverDiaLimpeza({ tipo, check_in, check_out, data_gravada, ajustada = false, hoje }) {
  const ci = diaTexto(check_in);
  const co = diaTexto(check_out);
  if (!ci || !co) return { erro: 'Datas inválidas.' };
  const g = diaTexto(data_gravada);
  // Dia ajustado pelo gestor: vale tal como está (qualquer tipo) enquanto o tipo e a estadia não mudarem.
  if (ajustada && g) return { dataLimpeza: new Date(`${g}T00:00:00Z`), dia: g, ajustada: true };
  if (eSaida(tipo)) return { dataLimpeza: null, dia: co };
  const gravadaValida = g && (tipo === 'intermedia' ? g >= ci && g <= co : g <= ci);
  const d = gravadaValida ? g : diaAutomatico(tipo, ci, co);
  if (tipo === 'preparacao' && !gravadaValida && hoje && d < hoje) {
    return { erro: 'A limpeza de preparação é no dia do check-in, que já passou.' };
  }
  return { dataLimpeza: new Date(`${d}T00:00:00Z`), dia: d };
}

/**
 * Lê e valida a configuração por tipo enviada pelo gestor (tempos e checklists).
 * Só considera as chaves presentes. Tempo: inteiro 1..480 ou vazio/null (volta ao tempo da casa).
 * Checklist: lista de textos (aparados, sem vazios, máx. 100 itens de 200 caracteres).
 * @returns {{ erro: string } | { set: object }}  `set` usa caminhos pontuados do Mongoose.
 */
function lerConfigTipos(body) {
  const set = {};
  const b = body || {};
  if (b.tempos_limpeza_por_tipo !== undefined) {
    const t = b.tempos_limpeza_por_tipo;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return { erro: 'tempos_limpeza_por_tipo inválido.' };
    for (const [k, v] of Object.entries(t)) {
      if (!TIPOS_CONFIGURAVEIS.includes(k)) return { erro: `Tipo de limpeza inválido em tempos: "${k}".` };
      if (v === null || v === '' || v === undefined) { set[`tempos_limpeza_por_tipo.${k}`] = null; continue; }
      // Só números (nada de texto, listas, booleanos ou objetos).
      const n = typeof v === 'number' ? v : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 480) {
        return { erro: `Tempo inválido para a limpeza ${ROTULOS_TIPO[k].toLowerCase()} (1 a 480 minutos).` };
      }
      set[`tempos_limpeza_por_tipo.${k}`] = n;
    }
  }
  if (b.checklists_por_tipo !== undefined) {
    const c = b.checklists_por_tipo;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return { erro: 'checklists_por_tipo inválido.' };
    for (const [k, v] of Object.entries(c)) {
      if (!TIPOS_CONFIGURAVEIS.includes(k)) return { erro: `Tipo de limpeza inválido em checklists: "${k}".` };
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        return { erro: `Checklist inválida para a limpeza ${ROTULOS_TIPO[k].toLowerCase()}.` };
      }
      const itens = v.map((x) => x.trim().slice(0, 200)).filter(Boolean);
      if (itens.length > 100) return { erro: 'Uma checklist não pode ter mais de 100 itens.' };
      set[`checklists_por_tipo.${k}`] = itens;
    }
  }
  return { set };
}

module.exports = {
  diaTexto,
  diaAutomatico,
  lerConfigTipos,
  TIPOS_LIMPEZA,
  TIPOS_COM_DATA,
  TIPOS_CONFIGURAVEIS,
  ROTULOS_TIPO,
  normalizarTipo,
  tipoDe,
  eSaida,
  tempoDoTipo,
  checklistDoTipo,
  temChecklistPropria,
  resolverDiaLimpeza,
};
