/**
 * Disponibilidade — Autocell
 *
 * Utilitário partilhado para validar se um utilizador está disponível para
 * receber uma tarefa num determinado dia.
 *
 * Um utilizador está INDISPONÍVEL se tiver uma Ausência APROVADA que cubra
 * o dia da tarefa (data_inicio <= dia <= data_fim).
 *
 * Usado por:
 *   - tarefaController.atribuirTarefa (atribuição manual)
 *   - tarefaController.reatribuirTarefa (reatribuição inteligente)
 *   - tarefaController.criarTarefa (criação manual com atribuição direta)
 *
 * v1.59.0 — Prompt 81: fix crítico de atribuir a staff de férias.
 */

const Ausencia = require('../models/Ausencia');

/**
 * Verifica se o utilizador tem uma ausência APROVADA que cubra o dia da tarefa.
 *
 * @param {string|import('mongoose').Types.ObjectId} utilizadorId
 * @param {Date} dataTarefa - dia da tarefa (qualquer hora; é normalizada)
 * @returns {Promise<{ indisponivel: boolean, ausencia?: { tipo: string, data_inicio: Date, data_fim: Date } }>}
 */
async function verificarDisponibilidadeUtilizador(utilizadorId, dataTarefa) {
  if (!utilizadorId || !dataTarefa) {
    return { indisponivel: false };
  }

  // Normaliza o dia da tarefa para meia-noite UTC.
  const d = new Date(dataTarefa);
  const diaTarefa = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );

  // Procura ausências aprovadas que cubram este dia.
  // Sobreposição: data_inicio <= diaTarefa <= data_fim.
  const ausencia = await Ausencia.findOne({
    utilizador_id: utilizadorId,
    estado: 'aprovada',
    data_inicio: { $lte: diaTarefa },
    data_fim: { $gte: diaTarefa },
  })
    .select('tipo data_inicio data_fim')
    .lean();

  if (ausencia) {
    return {
      indisponivel: true,
      ausencia: {
        tipo: ausencia.tipo,
        data_inicio: ausencia.data_inicio,
        data_fim: ausencia.data_fim,
      },
    };
  }

  return { indisponivel: false };
}

/**
 * Gera uma mensagem humanizada para o motivo de indisponibilidade.
 *
 * @param {{ tipo: string, data_inicio: Date, data_fim: Date }} ausencia
 * @returns {string}
 */
function mensagemIndisponivel(ausencia) {
  const tipoLabel =
    ausencia.tipo === 'ferias' ? 'Férias'
    : ausencia.tipo === 'doenca' ? 'Baixa por doença'
    : 'Ausência aprovada';

  const inicio = new Date(ausencia.data_inicio).toLocaleDateString('pt-PT');
  const fim = new Date(ausencia.data_fim).toLocaleDateString('pt-PT');

  if (inicio === fim) {
    return `${tipoLabel} neste dia (${inicio}).`;
  }
  return `${tipoLabel} de ${inicio} a ${fim}.`;
}

module.exports = {
  verificarDisponibilidadeUtilizador,
  mensagemIndisponivel,
};
