/**
 * Rótulo das casas em mensagens (push, sino): o nome, com a rua ou localidade entre parênteses só quando
 * outra casa da MESMA empresa tem o mesmo nome (casas homónimas). Espelha o rótulo das listas do gestor.
 */
const Propriedade = require('../models/Propriedade');
const { moradaPartes } = require('./calendarioExterno/moradaCurta');

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * @param {Array<{_id, nome, empresa_id, morada?, morada_estruturada?}>} casas casas a rotular (lean)
 * @returns {Promise<Map<string,string>>} _id -> rótulo
 */
async function rotulosDeCasas(casas) {
  const out = new Map();
  const lista = (casas || []).filter((c) => c && c._id && c.nome);
  if (lista.length === 0) return out;
  const homonimas = await Propriedade.find({
    empresa_id: { $in: [...new Set(lista.map((c) => String(c.empresa_id)))] },
    // Insensível a maiúsculas (como `norm`): regex ancorada com escape, uma por nome.
    $or: [...new Set(lista.map((c) => norm(c.nome)))].map((n) => ({ nome: new RegExp(`^\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') })),
  }).select('nome empresa_id').lean();
  const contagem = new Map();
  for (const h of homonimas) {
    const k = `${h.empresa_id}|${norm(h.nome)}`;
    contagem.set(k, (contagem.get(k) || 0) + 1);
  }
  for (const c of lista) {
    const repetida = (contagem.get(`${c.empresa_id}|${norm(c.nome)}`) || 0) > 1;
    const p = moradaPartes(c);
    const extra = repetida ? (p.rua || p.localidade) : null;
    out.set(String(c._id), extra ? `${c.nome} (${extra})` : c.nome);
  }
  return out;
}

module.exports = { rotulosDeCasas };
