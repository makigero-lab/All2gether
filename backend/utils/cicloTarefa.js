/**
 * Ciclo da tarefa — efeitos laterais partilhados (All2gether)
 *
 *  - Avisos no SINO do parceiro (sem push): limpeza concluída, cancelada ou alterada pelo gestor.
 *  - Ao concluir uma manutenção ligada a uma avaria, a avaria fica resolvida.
 *
 * Todas as funções são best-effort (nunca lançam) e idempotentes: o aviso usa uma chave por
 * evento, por isso repetir a chamada (reenvio, dois cliques) não duplica nada no sino.
 */
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const ReservaManual = require('../models/ReservaManual');
const { notificarSino } = require('./notificar');
const { resolverAvariaDaManutencao } = require('./avarias');
const H = require('./horario');
const Notificacao = require('../models/Notificacao');

const FUSO = 'Europe/Lisbon';

/** «11:42» em Lisboa. */
function horaLisboa(d) {
  return new Intl.DateTimeFormat('pt-PT', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
}

/** «06/11» do dia da tarefa (dia UTC guardado). */
function diaCurto(d) {
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Id do parceiro dono desta limpeza (reserva manual ou propriedade), ou null. */
async function parceiroDaTarefa(tarefa) {
  const t = tarefa && tarefa.toObject ? tarefa.toObject() : tarefa;
  if (!t) return null;
  const reserva = await ReservaManual.findOne({ tarefa_gerada_id: t._id }).select('parceiro_id').lean();
  if (reserva && reserva.parceiro_id) return String(reserva.parceiro_id);
  // Qualquer limpeza de uma casa de proprietário (criada pelo gestor, vinda do Smoobu ou pela rotina)
  // é dele: o parceiro vê-as na tabela de Reservas (só de leitura) e recebe os avisos.
  const p = await Propriedade.findById(t.propriedade_id).select('parceiro_id').lean();
  if (p && p.parceiro_id) return String(p.parceiro_id);
  return null;
}

async function nomeCasa(tarefa) {
  const p = await Propriedade.findById(tarefa.propriedade_id).select('nome').lean();
  return (p && p.nome) || 'a casa';
}

/**
 * Aviso ao parceiro. `evento`: 'concluida' | 'cancelada' | 'alterada' (pelo gestor)
 * | 'cancelada_smoobu' | 'alterada_smoobu' (a reserva mudou no Smoobu).
 */
async function avisarParceiro(tarefa, evento) {
  try {
    if (!tarefa || tarefa.tipo !== 'limpeza') return false;
    const parceiroId = await parceiroDaTarefa(tarefa);
    if (!parceiroId) return false;
    const casa = await nomeCasa(tarefa);
    const url = '/parceiro/reservas';
    let mensagem;
    let chave;
    let substituir = null;
    if (evento === 'concluida') {
      const quando = tarefa.hora_conclusao || tarefa.concluida_em || new Date();
      mensagem = `Limpeza concluída às ${horaLisboa(quando)}: ${casa} (${diaCurto(tarefa.data)}).`;
      chave = `limpeza_concluida:${tarefa._id}`;
    } else if (evento === 'cancelada') {
      mensagem = `Limpeza cancelada pelo gestor: ${casa} (${diaCurto(tarefa.data)}).`;
      chave = `limpeza_cancelada:${tarefa._id}`;
    } else if (evento === 'cancelada_smoobu') {
      mensagem = `Limpeza cancelada (a reserva foi cancelada no Smoobu): ${casa} (${diaCurto(tarefa.data)}).`;
      chave = `limpeza_cancelada:${tarefa._id}`;
    } else {
      const hora = H.temHoraReal(tarefa.data) ? ` às ${horaLisboa(tarefa.data)}` : '';
      mensagem = evento === 'alterada_smoobu'
        ? `Limpeza alterada (a reserva mudou no Smoobu): ${casa}, agora a ${diaCurto(tarefa.data)}${hora}.`
        : `Limpeza alterada pelo gestor: ${casa}, agora a ${diaCurto(tarefa.data)}${hora}.`;
      // A chave leva a hora; a notificação é substituída (ver abaixo) para o sino mostrar sempre a atual.
      chave = `limpeza_alterada:${tarefa._id}:${new Date(tarefa.data).toISOString()}`;
      substituir = `limpeza_alterada:${tarefa._id}:`;
    }
    if (substituir) {
      // Remove avisos de alteração anteriores com outra hora (mantém o da hora atual, para não repetir em reenvios).
      await Notificacao.deleteMany({
        utilizador_id: parceiroId,
        chave: { $regex: new RegExp('^' + substituir), $ne: chave },
      });
    }
    return await notificarSino(parceiroId, mensagem, {
      tipo: String(evento).startsWith('cancelada') ? 'tarefa_cancelada' : 'aviso',
      url,
      empresa_id: tarefa.empresa_id ? String(tarefa.empresa_id) : null,
      tarefa_id: tarefa._id,
      chave,
    });
  } catch (e) {
    console.error('⚠️  avisarParceiro:', e.message);
    return false;
  }
}

/** Efeitos de uma tarefa que acabou de ser concluída (staff, rota legada ou gestor). */
async function aoConcluirTarefa(tarefa) {
  try {
    const t = tarefa && tarefa.toObject ? tarefa.toObject() : tarefa;
    if (!t) return;
    if (t.tipo === 'manutencao') await resolverAvariaDaManutencao(t);
    if (t.tipo === 'limpeza') await avisarParceiro(t, 'concluida');
  } catch (e) {
    console.error('⚠️  aoConcluirTarefa:', e.message);
  }
}

/**
 * Início automático que ninguém tocou (nem botão nem checklist): conta como limpeza NÃO iniciada
 * (o job só presumiu que começou). Smoobu cancela/move-a como uma atribuída.
 */
function inicioAutomaticoSemToque(t) {
  return !!t && t.estado === 'em_curso' && t.inicio_origem === 'automatico'
    && !t.iniciada_por && !t.primeiro_item_checklist_em;
}

module.exports = {
  inicioAutomaticoSemToque, avisarParceiro, aoConcluirTarefa, parceiroDaTarefa, horaLisboa, diaCurto };
