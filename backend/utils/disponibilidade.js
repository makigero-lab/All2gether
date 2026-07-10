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
 * Prompt 113 — Tornado robusto a offset de fuso horário (Lisboa/WEST):
 *   A comparação passa a ser feita pela DATA DE CALENDÁRIO de Lisboa
 *   (YYYY-MM-DD) em vez do instante UTC midnight. Isto garante que uma
 *   tarefa criada às 00:00 local (23:00Z do dia anterior em UTC) ainda
 *   conta como "mesmo dia" para efeitos de férias/ausência — que podem
 *   estar armazenadas quer em UTC midnight quer em local midnight.
 */

const Ausencia = require('../models/Ausencia');

/**
 * Devolve a data de calendário (YYYY-MM-DD) de um instante no fuso de
 * Lisboa (Europe/Lisbon). Usa Intl.DateTimeFormat (suportado pelo Node sem
 * libs externas). Ex.: 2026-07-14T23:00:00Z → "2026-07-15" (Lisboa UTC+1).
 */
const fmtLisboa = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Lisbon',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dataLisboa(instante) {
  try {
    return fmtLisboa.format(new Date(instante)); // en-CA → YYYY-MM-DD
  } catch {
    return null;
  }
}

/**
 * Verifica se o utilizador tem uma ausência APROVADA que cubra o dia da tarefa.
 *
 * @param {string|import('mongoose').Types.ObjectId} utilizadorId
 * @param {Date|string|number} dataTarefa - instante da tarefa (qualquer hora)
 * @returns {Promise<{ indisponivel: boolean, ausencia?: { tipo: string, data_inicio: Date, data_fim: Date } }>}
 */
async function verificarDisponibilidadeUtilizador(utilizadorId, dataTarefa) {
  if (!utilizadorId || !dataTarefa) {
    return { indisponivel: false };
  }

  const diaStr = dataLisboa(dataTarefa);
  if (!diaStr) {
    return { indisponivel: false };
  }

  // Janela de pesquisa ampla (±1 dia em torno do dia da tarefa) para apanhar
  // ausências armazenadas em UTC midnight ou local midnight. Depois filtra
  // em JS pela data de Lisboa para precisão total.
  const diaInicio = new Date(diaStr + 'T00:00:00Z');
  const diaFim = new Date(diaInicio.getTime() + 48 * 60 * 60 * 1000); // +2 dias

  const candidatos = await Ausencia.find({
    utilizador_id: utilizadorId,
    estado: 'aprovada',
    data_inicio: { $lte: diaFim },
    data_fim: { $gte: diaInicio },
  })
    .select('tipo data_inicio data_fim')
    .lean();

  // Compara pela data de Lisboa (robusto a offset).
  const emAusencia = candidatos.find((a) => {
    const ini = dataLisboa(a.data_inicio);
    const fim = dataLisboa(a.data_fim);
    if (!ini || !fim) return false;
    return diaStr >= ini && diaStr <= fim;
  });

  if (emAusencia) {
    return {
      indisponivel: true,
      ausencia: {
        tipo: emAusencia.tipo,
        data_inicio: emAusencia.data_inicio,
        data_fim: emAusencia.data_fim,
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

  const inicio = dataLisboa(ausencia.data_inicio);
  const fim = dataLisboa(ausencia.data_fim);

  if (inicio === fim) {
    return `${tipoLabel} neste dia (${inicio}).`;
  }
  return `${tipoLabel} de ${inicio} a ${fim}.`;
}

module.exports = {
  verificarDisponibilidadeUtilizador,
  mensagemIndisponivel,
};
