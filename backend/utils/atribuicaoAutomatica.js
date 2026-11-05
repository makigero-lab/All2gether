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
const Tarefa = require('../models/Tarefa');
const { idsEquipa, comMembro, normalizarEquipa } = require('./equipaTarefa');

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

/**
 * A pessoa já tem outra limpeza que se sobrepõe a [data, data + duração]?
 * (usa tempo de limpeza + viagem de cada tarefa; ignora canceladas/concluídas
 * e a própria tarefa).
 */
async function temSobreposicao(utilizadorId, data, duracaoMin, excluirTarefaId = null) {
  const range = obterRangeDia(data);
  const filtro = {
    data: { $gte: range.start, $lt: range.end },
    estado: { $nin: ['cancelada', 'concluida'] },
  };
  if (excluirTarefaId) filtro._id = { $ne: excluirTarefaId };
  const outras = await Tarefa.find(comMembro(filtro, utilizadorId))
    .select('data tempo_limpeza_minutos tempo_viagem_minutos')
    .lean();
  const ini = new Date(data).getTime();
  const fim = ini + (Number(duracaoMin) || 45) * 60000;
  return outras.some((o) => {
    const oi = new Date(o.data).getTime() - (Number(o.tempo_viagem_minutos) || 0) * 60000;
    const of = new Date(o.data).getTime() + (Number(o.tempo_limpeza_minutos) || 45) * 60000;
    return oi < fim && of > ini;
  });
}

/**
 * Procura quem preencha SÓ a(s) vaga(s) de uma tarefa com equipa incompleta.
 * Não mexe na hora: candidatos cuja agenda choca com a hora da tarefa são
 * excluídos (nunca ficam com limpezas sobrepostas). A necessidade usa o
 * `staff_necessario` ATUAL da propriedade (se baixou, não pede mais pessoas).
 *
 * @returns {Promise<{ membros: string[], precisa: number, novos: any[], conflitos: number, faltam: number, staffNecessario: number }>}
 */
async function planearVaga({ empresaId, tarefa, propriedade, excluirExtra = [] }) {
  const membros = idsEquipa(tarefa);
  const staffNecessario = Math.max(1, Number(propriedade && propriedade.staff_necessario) || 1);
  const precisa = Math.min(Number(tarefa.pessoas_em_falta) || 0, Math.max(0, staffNecessario - membros.length));
  const out = { membros, precisa, novos: [], conflitos: 0, faltam: precisa, staffNecessario };
  if (precisa === 0) return out;

  const range = obterRangeDia(tarefa.data);
  const tempo = Number(tarefa.tempo_limpeza_minutos) || 45;
  const excl = new Set([...membros, ...excluirExtra.map(String)]);
  for (let tentativa = 0; tentativa < 6 && out.novos.length < precisa; tentativa++) {
    const r = await determinarEquipaAtribuida(
      empresaId, range, propriedade.coordenadas, tempo, propriedade._id, precisa - out.novos.length, new Set(excl)
    );
    const cand = (r?.equipa || []).map((m) => m.utilizadorId);
    if (cand.length === 0) break;
    for (const id of cand) {
      excl.add(String(id));
      if (await temSobreposicao(id, tarefa.data, tempo, tarefa._id)) out.conflitos++;
      else out.novos.push(id);
    }
  }
  out.faltam = precisa - out.novos.length;
  return out;
}

/**
 * Preenche (e grava) a vaga de uma tarefa 'atribuida' com equipa incompleta.
 * Só acrescenta pessoas; mantém responsável e hora. Atualiza sempre
 * `pessoas_em_falta` para o valor real (limpa contadores antigos).
 * @returns {Promise<{ novos: any[], faltam: number, conflitos: number }>}
 */
async function preencherVagaTarefa({ empresaId, tarefa, propriedade, excluirExtra = [] }) {
  const v = await planearVaga({ empresaId, tarefa, propriedade, excluirExtra });
  const faltam = v.faltam;
  if (v.novos.length > 0) {
    const eq = normalizarEquipa(v.membros[0] || v.novos[0], [...v.membros, ...v.novos]);
    await Tarefa.updateOne(
      { _id: tarefa._id, estado: 'atribuida' },
      { $set: { utilizador_id: eq.utilizador_id, equipa_atribuida: eq.equipa_atribuida, pessoas_em_falta: faltam } }
    );
  } else if (faltam !== (Number(tarefa.pessoas_em_falta) || 0)) {
    await Tarefa.updateOne({ _id: tarefa._id, estado: 'atribuida' }, { $set: { pessoas_em_falta: faltam } });
  }
  if (v.novos.length > 0) avisarColegasDoSubstituto(v.membros, v.novos, propriedade && propriedade.nome);
  return { novos: v.novos, faltam, conflitos: v.conflitos };
}

/** Quando entra um substituto, os colegas que já estavam na limpeza são avisados (push). */
function avisarColegasDoSubstituto(colegas, novos, nomeProp) {
  try {
    const { notificarUtilizador } = require('./notificar');
    for (const id of colegas || []) {
      notificarUtilizador(
        String(id),
        '👥 Novo colega na limpeza',
        `${novos.length === 1 ? 'Entrou um colega' : 'Entraram colegas'} na limpeza de ${nomeProp || 'uma propriedade'}. Vê a equipa no detalhe.`,
        '/staff'
      );
    }
  } catch (e) {
    // fire-and-forget
  }
}

/**
 * Tarefas 'atribuida'/'em_curso' SEM ninguém (utilizador_id null e equipa vazia):
 * estado incoerente (ex.: pessoa eliminada). Filtro Mongo reutilizável.
 */
const FILTRO_SEM_PESSOA = {
  estado: { $in: ['atribuida', 'em_curso'] },
  utilizador_id: null,
  $or: [{ equipa_atribuida: { $exists: false } }, { equipa_atribuida: { $size: 0 } }],
};

/** Versão em JS do FILTRO_SEM_PESSOA (para documentos já carregados). */
function semPessoa(t) {
  return !!t && ['atribuida', 'em_curso'].includes(t.estado) && !t.utilizador_id && idsEquipa(t).length === 0;
}

/**
 * Há sinais de que a limpeza já foi feita em parte (item da checklist marcado,
 * fotos, avarias, notas do staff ou sacos de roupa)? Decisão: se sim, uma
 * 'em_curso' sem pessoa NÃO é mexida automaticamente (o gestor decide).
 */
function temProgresso(t) {
  const checklist = (t.checklist_dinamica || []).some((g) => (g.items || []).some((i) => i.concluido));
  return checklist
    || (t.fotos_conclusao || []).length > 0
    || (t.avarias || []).length > 0
    || !!(t.observacoes_staff && String(t.observacoes_staff).trim())
    || (Number(t.sacos_roupa_suja) || 0) > 0;
}

/** Uma tarefa sem pessoa que pode voltar a ser atribuída do zero (nada foi feito). */
function recuperavelSemPessoa(t) {
  return semPessoa(t) && (t.estado === 'atribuida' || !temProgresso(t));
}

module.exports = {
  FILTRO_SEM_PESSOA,
  semPessoa,
  temProgresso,
  recuperavelSemPessoa,
  avisarColegasDoSubstituto,
  preencherVagaTarefa,
  temSobreposicao,
  planearVaga,
  diagnosticarFaltaDeStaff,
  planearAtribuicao,
  MOTIVO_SEM_EQUIPA,
  MOTIVO_INDISPONIVEL,
  MOTIVO_LOTACAO,
};
