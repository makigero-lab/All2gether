/**
 * Atribuição automática partilhada — All2gether.
 *
 * Um único sítio para:
 *   - diagnosticarFaltaDeStaff: explica PORQUÊ ninguém foi atribuído (sem equipa,
 *     ausência/folga, ou lotação). Usa obterStaffDisponivel do load balancer.
 *   - planearAtribuicao: corre o motor (staff_necessario, scheduler sequencial) e
 *     devolve os campos prontos a gravar numa tarefa nova. Usado pelo parceiro e
 *     pela importação de Excel.
 */

const {
  obterStaffDisponivel,
  determinarUtilizadorAtribuido,
  determinarEquipaAtribuida,
} = require('./loadBalancer');
const { calcularInicioTarefaUtilizador, obterRangeDia } = require('./scheduler');

const MOTIVO_SEM_EQUIPA = 'Sem equipa ativa';
const MOTIVO_INDISPONIVEL = 'Toda a equipa ausente, de folga ou fora da equipa exclusiva neste dia';
const MOTIVO_LOTACAO = 'Lotação máxima excedida (toda a equipa > 8h/dia)';
const MOTIVO_ERRO = 'Erro ao verificar disponibilidade da equipa';

/**
 * Causa real de a atribuição ter falhado.
 * @returns {Promise<{ causa: 'sem_equipa'|'indisponivel'|'lotacao'|'erro', motivo: string, estado: 'por_atribuir'|'nao_atribuida' }>}
 */
async function diagnosticarFaltaDeStaff(empresaId, range, propriedadeId = null, excluirStaffIds = null) {
  try {
    const { staff, disponiveis } = await obterStaffDisponivel(empresaId, range, propriedadeId, excluirStaffIds);
    if (staff.length === 0) {
      return { causa: 'sem_equipa', motivo: MOTIVO_SEM_EQUIPA, estado: 'por_atribuir' };
    }
    if (disponiveis.length === 0) {
      return { causa: 'indisponivel', motivo: MOTIVO_INDISPONIVEL, estado: 'por_atribuir' };
    }
    // Há quem esteja disponível mas ninguém cabe no limite diário.
    return { causa: 'lotacao', motivo: MOTIVO_LOTACAO, estado: 'nao_atribuida' };
  } catch (e) {
    // Se falha a verificação, mantém por_atribuir (seguro).
    return { causa: 'erro', motivo: MOTIVO_ERRO, estado: 'por_atribuir' };
  }
}

/**
 * Corre o motor de atribuição para uma tarefa nova de limpeza.
 *
 * @param {object} p
 * @param {*} p.empresaId
 * @param {object} p.propriedade - precisa de _id, coordenadas, staff_necessario
 * @param {Date} p.dia - qualquer instante do dia (normalizado para o dia UTC)
 * @param {number} p.tempoLimpeza
 * @returns {Promise<{
 *   utilizador_id, equipa_atribuida: Array, data: Date, tempo_viagem_minutos: number,
 *   estado: string, motivo_nao_atribuicao: string|null, faltam: number }>}
 */
async function planearAtribuicao({ empresaId, propriedade, dia, tempoLimpeza }) {
  const range = obterRangeDia(dia);
  const staffNecessario = Math.max(1, Number(propriedade.staff_necessario) || 1);
  const tempo = Number(tempoLimpeza) || propriedade.tempo_limpeza_minutos || 45;

  const dataPadrao = new Date(range.start);
  dataPadrao.setUTCHours(10, 0, 0, 0); // 10:00 UTC por defeito

  const plano = {
    utilizador_id: null,
    equipa_atribuida: [],
    data: dataPadrao,
    tempo_viagem_minutos: 0,
    estado: 'por_atribuir',
    motivo_nao_atribuicao: null,
    faltam: 0,
  };

  try {
    let ids = [];
    let viagemLB = 0;
    if (staffNecessario > 1) {
      const r = await determinarEquipaAtribuida(
        empresaId, range, propriedade.coordenadas, tempo, propriedade._id, staffNecessario
      );
      ids = (r?.equipa || []).map((m) => m.utilizadorId);
    } else {
      const r = await determinarUtilizadorAtribuido(
        empresaId, range, propriedade.coordenadas, tempo, propriedade._id
      );
      if (r?.utilizadorId) ids = [r.utilizadorId];
      viagemLB = Number(r?.tempoViagem) || 0;
    }

    if (ids.length === 0) {
      const d = await diagnosticarFaltaDeStaff(empresaId, range, propriedade._id);
      plano.estado = d.estado;
      plano.motivo_nao_atribuicao = d.motivo;
      return plano;
    }

    // Todos os membros têm de estar presentes: começa quando o último consegue.
    let dataAgendada = dataPadrao;
    let viagem = viagemLB;
    for (const id of ids) {
      try {
        const s = await calcularInicioTarefaUtilizador(id, range.start, propriedade.coordenadas, tempo);
        if (s?.data && s.data > dataAgendada) dataAgendada = s.data;
        if (s?.tempoViagem) viagem = Math.max(viagem, Number(s.tempoViagem) || 0);
      } catch (errScheduler) {
        console.warn('⚠️  [atribuicao] scheduler falhou (mantém 10:00 UTC):', errScheduler.message);
      }
    }

    plano.utilizador_id = ids[0];
    plano.equipa_atribuida = ids;
    plano.data = dataAgendada;
    plano.tempo_viagem_minutos = viagem;
    plano.estado = 'atribuida';
    plano.faltam = Math.max(0, staffNecessario - ids.length);
  } catch (err) {
    console.warn('⚠️  [atribuicao] falhou (tarefa fica por atribuir):', err.message);
    plano.motivo_nao_atribuicao = 'Erro na auto-atribuição';
  }
  return plano;
}

module.exports = {
  diagnosticarFaltaDeStaff,
  planearAtribuicao,
  MOTIVO_SEM_EQUIPA,
  MOTIVO_INDISPONIVEL,
  MOTIVO_LOTACAO,
};
