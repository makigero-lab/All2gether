/**
 * Helper de Auditoria — FisioCell
 *
 * Regista ações administrativas na coleção Auditoria.
 * Função fire-and-forget (não bloqueia a resposta ao cliente).
 */

const Auditoria = require('../models/Auditoria');

/**
 * Regista uma ação de auditoria.
 *
 * @param {object} params
 * @param {string} params.utilizador_id - ID do utilizador (do JWT)
 * @param {string} params.utilizador_nome - Nome do utilizador
 * @param {string} params.empresa_id - ID da empresa
 * @param {string} params.acao - Tipo de ação (criar, atualizar, eliminar, etc)
 * @param {string} params.recurso - Tipo de recurso (propriedade, utilizador, tarefa, etc)
 * @param {string} [params.recurso_id] - ID do recurso afetado
 * @param {string} params.descricao - Descrição legível
 * @param {object} [params.detalhes] - Detalhes adicionais
 */
function registarAuditoria({
  utilizador_id,
  utilizador_nome,
  empresa_id,
  acao,
  recurso,
  recurso_id,
  descricao,
  detalhes,
}) {
  // Fire-and-forget: não esperamos nem propagamos erros.
  Auditoria.create({
    utilizador_id,
    utilizador_nome,
    empresa_id,
    acao,
    recurso,
    recurso_id: recurso_id ? String(recurso_id) : null,
    descricao,
    detalhes: detalhes || {},
  }).catch((err) => {
    console.error('⚠️  Erro ao registar auditoria:', err.message);
  });
}

module.exports = { registarAuditoria };
