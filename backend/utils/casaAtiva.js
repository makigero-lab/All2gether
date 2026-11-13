/**
 * Casa ativa — UM só sítio para saber se uma casa pode ter limpezas.
 *
 * Uma casa NÃO pode gerar nem receber limpezas quando:
 *   - está inativa (Propriedade.ativo === false), ou
 *   - pertence a um proprietário inativo ou eliminado.
 * Desativar um proprietário desativa as casas dele (gestorController.alternarEstadoMembro), mas
 * dados antigos (proprietário inativo com casas ativas) também ficam cobertos por esta verificação.
 */
const mongoose = require('mongoose');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');

const MSG_CASA_INATIVA = 'A propriedade está inativa. Reativa-a antes de criar limpezas.';
const MSG_DONO_INATIVO = 'O proprietário desta casa está inativo. Reativa-o antes de criar limpezas.';

/**
 * @param {object|string} propriedade documento (com ativo e parceiro_id) ou id
 * @returns {Promise<{ inativa: boolean, motivo: 'casa'|'proprietario'|'inexistente'|null, mensagem: string|null }>}
 */
async function estadoDaCasa(propriedade) {
  let p = propriedade;
  if (!p || typeof p !== 'object' || p.ativo === undefined || p.parceiro_id === undefined) {
    const id = p && p._id ? p._id : p;
    if (!id || !mongoose.isValidObjectId(id)) return { inativa: false, motivo: null, mensagem: null }; // sem referência: nada a verificar
    p = await Propriedade.findById(id).select('ativo parceiro_id').lean();
  }
  if (!p) return { inativa: true, motivo: 'inexistente', mensagem: 'Propriedade não encontrada.' };
  if (p.ativo === false) return { inativa: true, motivo: 'casa', mensagem: MSG_CASA_INATIVA };
  if (p.parceiro_id) {
    const dono = await Utilizador.findById(p.parceiro_id).select('ativo eliminado_em').lean();
    if (dono && (dono.ativo === false || dono.eliminado_em)) {
      return { inativa: true, motivo: 'proprietario', mensagem: MSG_DONO_INATIVO };
    }
  }
  return { inativa: false, motivo: null, mensagem: null };
}

/** true se a casa não pode ter limpezas (inativa ou com dono inativo). */
async function casaInativa(propriedade) {
  return (await estadoDaCasa(propriedade)).inativa;
}

module.exports = { estadoDaCasa, casaInativa, MSG_CASA_INATIVA, MSG_DONO_INATIVO };
