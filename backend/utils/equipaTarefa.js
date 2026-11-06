/**
 * Equipa de uma tarefa — All2gether.
 *
 * Modelo (limpezas com 2+ pessoas):
 *   - `equipa_atribuida` é a equipa COMPLETA.
 *   - `utilizador_id` é o RESPONSÁVEL e é sempre membro da equipa.
 *   - Tarefas antigas com `equipa_atribuida` vazia são tratadas como equipa só
 *     com `utilizador_id` (sem migração).
 *
 * Tarefa sem responsável (`utilizador_id` null) = sem equipa; `equipa_atribuida`
 * preenchida nesse caso é lixo antigo e é ignorada (ver
 * scripts/limpar-equipas-fantasma.js).
 *
 * Este módulo é o ÚNICO sítio que sabe isto. Todas as leituras e escritas
 * passam por aqui para a segunda pessoa ver e poder agir na tarefa, e para
 * carga/conflitos/ausências contarem para cada membro.
 */

const mongoose = require('mongoose');

const idStr = (v) => (v === null || v === undefined ? null : String(v && v._id ? v._id : v));

/** IDs (string) dos membros: responsável primeiro, sem repetidos nem nulos. */
function idsEquipa(tarefa) {
  if (!tarefa) return [];
  // Sem responsável não há equipa: os "membros fantasma" (equipa preenchida com
  // utilizador_id null, dados antigos) não contam para nada.
  if (!idStr(tarefa.utilizador_id)) return [];
  const out = [];
  const add = (v) => {
    const s = idStr(v);
    if (s && !out.includes(s)) out.push(s);
  };
  add(tarefa.utilizador_id);
  (tarefa.equipa_atribuida || []).forEach(add);
  return out;
}

/** O utilizador é membro (responsável ou não) da tarefa? */
function eMembro(tarefa, utilizadorId) {
  const alvo = idStr(utilizadorId);
  return !!alvo && idsEquipa(tarefa).includes(alvo);
}

function toObjectId(v) {
  return v instanceof mongoose.Types.ObjectId
    ? v
    : mongoose.Types.ObjectId.isValid(v)
    ? new mongoose.Types.ObjectId(String(v))
    : v;
}

/**
 * Fragmento de filtro Mongoose: tarefas em que o utilizador é membro.
 * Devolve `{ $or: [...] }`. Se o filtro a que o juntas já tiver `$or`, usa
 * `comMembro`.
 */
function filtroMembro(utilizadorId) {
  const id = toObjectId(utilizadorId);
  return { $or: [{ utilizador_id: id }, { utilizador_id: { $ne: null }, equipa_atribuida: id }] };
}

/** Junta o critério "é membro" a um filtro existente, sem colidir com um $or próprio. */
function comMembro(filtro, utilizadorId) {
  const f = filtroMembro(utilizadorId);
  if (filtro && filtro.$or) {
    const { $or, ...resto } = filtro;
    return { ...resto, $and: [...(filtro.$and || []), { $or }, f] };
  }
  return { ...(filtro || {}), ...f };
}

/** Filtro para vários utilizadores de uma vez (qualquer deles é membro). */
function filtroMembros(ids) {
  const lista = (ids || []).map(toObjectId);
  return { $or: [{ utilizador_id: { $in: lista } }, { utilizador_id: { $ne: null }, equipa_atribuida: { $in: lista } }] };
}

/**
 * Normaliza (responsável, equipa): sem repetidos/nulos e com o responsável
 * dentro. Se o responsável vier vazio mas houver equipa, o primeiro membro
 * passa a responsável. Devolve { utilizador_id, equipa_atribuida }.
 */
function normalizarEquipa(responsavelId, equipa) {
  const ids = [];
  const add = (v) => {
    const s = idStr(v);
    if (s && !ids.includes(s)) ids.push(s);
  };
  add(responsavelId);
  (equipa || []).forEach(add);
  return {
    utilizador_id: ids.length ? toObjectId(ids[0]) : null,
    equipa_atribuida: ids.map(toObjectId),
  };
}

/**
 * Tira um membro da equipa. Se era o responsável, o seguinte passa a
 * responsável. Devolve { utilizador_id, equipa_atribuida } (já normalizado).
 */
function semMembro(tarefa, utilizadorId) {
  const alvo = idStr(utilizadorId);
  const restantes = idsEquipa(tarefa).filter((i) => i !== alvo);
  return normalizarEquipa(restantes[0] || null, restantes);
}

/**
 * Tira um membro de um DOCUMENTO Mongoose de tarefa (não grava). Se era o
 * responsável o seguinte passa a responsável e `pessoas_em_falta` sobe 1. Se a
 * equipa ficar vazia a tarefa volta a 'por_atribuir'.
 * Devolve true se a equipa ficou vazia.
 */
function retirarMembroDoc(tarefa, utilizadorId) {
  const r = semMembro(tarefa, utilizadorId);
  tarefa.utilizador_id = r.utilizador_id;
  tarefa.equipa_atribuida = r.equipa_atribuida;
  if (!r.utilizador_id) {
    tarefa.estado = 'por_atribuir';
    tarefa.pessoas_em_falta = 0;
    return true;
  }
  tarefa.pessoas_em_falta = (tarefa.pessoas_em_falta || 0) + 1;
  return false;
}

/**
 * Membros já populados (documentos lean com populate de utilizador_id e de
 * equipa_atribuida): responsável primeiro, sem repetidos. Ignora ids que não
 * foram populados (utilizador apagado).
 */
function membrosPopulados(tarefa) {
  // Sem responsável não há equipa (ignora membros fantasma).
  if (!tarefa || !tarefa.utilizador_id) return [];
  const vistos = new Set();
  const out = [];
  for (const u of [tarefa && tarefa.utilizador_id, ...((tarefa && tarefa.equipa_atribuida) || [])]) {
    if (u && typeof u === 'object' && u._id && !vistos.has(String(u._id))) {
      vistos.add(String(u._id));
      out.push(u);
    }
  }
  return out;
}

/**
 * Expressão de aggregation com os membros da tarefa (array de ObjectId):
 * união de utilizador_id e equipa_atribuida. Usar com $addFields + $unwind
 * para contar carga/horas por pessoa.
 */
const EXPR_MEMBROS = {
  $cond: [
    { $ifNull: ['$utilizador_id', false] },
    {
      $setUnion: [['$utilizador_id'], { $ifNull: ['$equipa_atribuida', []] }],
    },
    [], // sem responsável = sem equipa (ignora membros fantasma)
  ],
};

module.exports = {
  idsEquipa,
  eMembro,
  filtroMembro,
  filtroMembros,
  comMembro,
  normalizarEquipa,
  semMembro,
  retirarMembroDoc,
  membrosPopulados,
  EXPR_MEMBROS,
};
