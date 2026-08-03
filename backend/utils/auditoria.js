/**
 * Helper de Auditoria — All2gether
 *
 * Regista ações administrativas na coleção Auditoria.
 * Função fire-and-forget (não bloqueia a resposta ao cliente).
 */

const Auditoria = require('../models/Auditoria');

/**
 * Regista uma ação de auditoria.
 *
 * Best-effort: qualquer erro ao gravar é apenas registado no log e ignorado,
 * de forma a nunca abortar o pedido principal do utilizador (semântica
 * equivalente a `next()` num middleware). A auditoria nunca deve provocar 502s.
 *
 * @param {object} params
 * @param {string} params.utilizador_id - ID do utilizador (do JWT)
 * @param {string} params.utilizador_nome - Nome do utilizador
 * @param {string} [params.empresa_id] - ID da empresa (opcional em Satélite single-tenant)
 * @param {string} params.acao - Tipo de ação (criar, atualizar, eliminar, etc)
 * @param {string} params.recurso - Tipo de recurso (propriedade, utilizador, tarefa, etc)
 * @param {string} [params.recurso_id] - ID do recurso afetado
 * @param {string} params.descricao - Descrição legível
 * @param {object} [params.detalhes] - Detalhes adicionais
 */
async function registarAuditoria({
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
  try {
    await Auditoria.create({
      utilizador_id,
      utilizador_nome,
      // Single-tenant (Satélite): empresa_id pode chegar undefined (ex.: Super
      // Admin via SSO sem empresa no contexto). O schema permite null.
      empresa_id: empresa_id || null,
      acao,
      recurso,
      recurso_id: recurso_id ? String(recurso_id) : null,
      descricao,
      detalhes: detalhes || {},
    });
  } catch (err) {
    // Apenas regista no log e segue — o pedido principal não é afetado.
    console.error('⚠️  Erro ao registar auditoria:', err.message);
  }
}

module.exports = { registarAuditoria };
