/**
 * Proteção das linhas que o proprietário NÃO pode editar nem apagar: limpezas das casas dele que
 * não são reservas dele (do Smoobu ou criadas pela gestão). A listagem das reservas externas
 * (só de leitura) vive em reservasExternas.js.
 */
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');

const MSG_LIMPEZA_DA_GESTAO = 'Esta reserva ou limpeza é gerida pela All2gether (ou vem do Smoobu): não pode ser editada nem apagada por ti. Fala com o gestor.';

/** O id é de uma limpeza da gestão numa casa deste proprietário? (para recusar editar/apagar com 403) */
async function limpezaDaGestaoDoParceiro(id, parceiroId) {
  const t = await Tarefa.findById(id).select('propriedade_id tipo').lean().catch(() => null);
  if (!t || t.tipo !== 'limpeza') return false;
  return !!(await Propriedade.exists({ _id: t.propriedade_id, parceiro_id: parceiroId }));
}

module.exports = { limpezaDaGestaoDoParceiro, MSG_LIMPEZA_DA_GESTAO };
