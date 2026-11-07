/**
 * Quem pode fazer esta limpeza (atribuição manual do gestor).
 *
 * Devolve só as pessoas que o motor automático também aceitaria para o dia:
 * ativas, sem ausência nem folga, dentro da equipa exclusiva da casa e a quem
 * a limpeza cabe no horário (09:00-18:00, com almoço e viagens), com a hora
 * prevista de cada uma. Usa o mesmo cálculo de `scheduler.js`/`horario.js`;
 * as viagens do Google Maps passam pela cache de `distancia.js` (cada par de
 * coordenadas só é pedido uma vez por hora), por isso abrir o seletor não
 * dispara chamadas pagas repetidas.
 *
 * Modos:
 *  - 'vaga': a limpeza já tem equipa mas falta gente (staff_necessario > membros).
 *    A hora não mexe; só serve quem tiver a agenda livre nessa hora.
 *  - 'responsavel': escolher uma pessoa passa-a a responsável (os outros membros
 *    ficam), como em PATCH /atribuir e /reatribuir.
 */

const { obterStaffDisponivel } = require('./loadBalancer');
const { obterRangeDia, calcularInicioTarefaUtilizador, motivoNaoCabe } = require('./scheduler');
const { cabeNaAgendaNaHora, diagnosticarFaltaDeStaff, MOTIVO_LOTACAO } = require('./atribuicaoAutomatica');
const H = require('./horario');
const { idsEquipa } = require('./equipaTarefa');

const MOTIVO_VAGA_SEM_HORA = 'Ninguém com a agenda livre à hora desta limpeza.';

/**
 * @param {{ empresaId: *, tarefa: object, propriedade: object, acao?: 'atribuir'|'reatribuir' }} p
 * @returns {Promise<{ modo: 'vaga'|'responsavel', disponiveis: Array<{ _id: string, nome: string, hora_prevista: string, tempo_viagem_minutos: number }>, motivo: string|null }>}
 */
async function listarDisponiveis({ empresaId, tarefa, propriedade, acao = 'reatribuir' }) {
  const range = obterRangeDia(tarefa.data);
  const tempo = Number(tarefa.tempo_limpeza_minutos) || 45;
  const membros = idsEquipa(tarefa).map(String);
  const respAtual = tarefa.utilizador_id ? String(tarefa.utilizador_id._id || tarefa.utilizador_id) : null;
  const staffNec = Math.max(1, Number(propriedade.staff_necessario) || 1);
  const modo = membros.length > 0 && membros.length < staffNec && Number(tarefa.pessoas_em_falta) > 0 ? 'vaga' : 'responsavel';
  const coord = propriedade.coordenadas;
  const comHora = H.temHoraReal(tarefa.data);

  // Quem já está na limpeza não aparece (já faz parte dela).
  const excluidos = new Set(membros);
  const { disponiveis: elegiveis } = await obterStaffDisponivel(empresaId, range, propriedade._id, excluidos);

  const ok = [];
  for (const u of elegiveis) {
    const id = String(u._id);
    let hora = null;
    let viagem = 0;
    if (modo === 'vaga') {
      if (comHora) {
        if (!(await cabeNaAgendaNaHora(id, tarefa.data, tempo, tarefa._id, coord, propriedade._id))) continue;
        hora = new Date(tarefa.data);
      }
    } else if (acao === 'atribuir' && comHora) {
      // PATCH /atribuir mantém a hora que a limpeza já tem.
      if (!(await cabeNaAgendaNaHora(id, tarefa.data, tempo, tarefa._id, coord, propriedade._id))) continue;
      hora = new Date(tarefa.data);
    }
    if (!hora) {
      const equipa = modo === 'vaga'
        ? [...membros, id]
        : [id, ...membros.filter((m) => m !== respAtual)];
      const r = await calcularInicioTarefaUtilizador(
        equipa.length > 1 ? equipa : id, tarefa.data, coord, tempo, tarefa._id, propriedade._id
      );
      if (!r.cabe) continue;
      hora = r.data;
      viagem = Number(r.tempoViagem) || 0;
    }
    ok.push({ _id: id, nome: u.nome, hora_prevista: hora.toISOString(), tempo_viagem_minutos: viagem });
  }
  ok.sort((a, b) => a.hora_prevista.localeCompare(b.hora_prevista) || a.nome.localeCompare(b.nome, 'pt'));
  if (ok.length > 0) return { modo, disponiveis: ok, motivo: null };

  // Ninguém: o motivo real.
  let motivo;
  if (!H.duracaoCabeNoHorario(tempo)) {
    motivo = motivoNaoCabe(tempo);
  } else if (elegiveis.length > 0) {
    motivo = modo === 'vaga' ? MOTIVO_VAGA_SEM_HORA : MOTIVO_LOTACAO;
  } else {
    const d = await diagnosticarFaltaDeStaff(empresaId, range, propriedade._id, excluidos, tempo);
    motivo = d.motivo;
  }
  return { modo, disponiveis: [], motivo };
}

module.exports = { listarDisponiveis, MOTIVO_VAGA_SEM_HORA };
