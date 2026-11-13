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
  cabeNoHorario,
} = require('./loadBalancer');
const { calcularInicioEquipa, obterRangeDia, carregarAgenda, prepararViagens, motivoNaoCabe } = require('./scheduler');
const H = require('./horario');
const { casaInativa } = require('./casaAtiva');
const Tarefa = require('../models/Tarefa');
const { idsEquipa, comMembro, normalizarEquipa } = require('./equipaTarefa');

const MOTIVO_SEM_EQUIPA = 'Sem equipa ativa';
const MOTIVO_INDISPONIVEL = 'Toda a equipa ausente, de folga ou fora da equipa exclusiva neste dia';
const MOTIVO_LOTACAO = 'Não cabe no horário de ninguém (09:00-18:00, com almoço e viagens)';
const MOTIVO_SEM_HORA_COMUM = 'Sem hora comum para a equipa (09:00-18:00, com almoço e viagens)';
// Limites para não multiplicar chamadas de viagem (pagas): candidatos extra e combinações testadas.
const MAX_CANDIDATOS_EXTRA = 4;
const MAX_COMBINACOES = 6;
const MOTIVO_ERRO = 'Erro ao verificar disponibilidade da equipa';

/**
 * Causa real de a atribuição ter falhado.
 * @returns {Promise<{ causa: 'sem_equipa'|'indisponivel'|'lotacao'|'erro', motivo: string, estado: 'por_atribuir'|'nao_atribuida' }>}
 */
async function diagnosticarFaltaDeStaff(empresaId, range, propriedadeId = null, excluirStaffIds = null, tempoLimpeza = null) {
  try {
    const { staff, disponiveis } = await obterStaffDisponivel(empresaId, range, propriedadeId, excluirStaffIds);
    if (staff.length === 0) {
      return { causa: 'sem_equipa', motivo: MOTIVO_SEM_EQUIPA, estado: 'por_atribuir' };
    }
    if (disponiveis.length === 0) {
      return { causa: 'indisponivel', motivo: MOTIVO_INDISPONIVEL, estado: 'por_atribuir' };
    }
    // Há quem esteja disponível mas ninguém cabe no horário (ou a limpeza é demasiado longa para qualquer dia).
    const motivo = tempoLimpeza && !H.duracaoCabeNoHorario(tempoLimpeza) ? motivoNaoCabe(Number(tempoLimpeza)) : MOTIVO_LOTACAO;
    return { causa: 'lotacao', motivo, estado: 'nao_atribuida' };
  } catch (e) {
    // Se falha a verificação, mantém por_atribuir (seguro).
    return { causa: 'erro', motivo: MOTIVO_ERRO, estado: 'por_atribuir' };
  }
}

/** Combinações de `k` elementos de `arr`, por ordem (os primeiros candidatos primeiro). */
function combinacoes(arr, k) {
  const out = [];
  const rec = (ini, atual) => {
    if (atual.length === k) { out.push([...atual]); return; }
    for (let i = ini; i < arr.length; i++) { atual.push(arr[i]); rec(i + 1, atual); atual.pop(); }
  };
  rec(0, []);
  return out;
}

/**
 * Equipa com várias pessoas sem hora comum: tenta outras combinações entre os candidatos
 * elegíveis (disponíveis e que cabem sozinhos), com limites pequenos de candidatos e de
 * combinações para não multiplicar chamadas de viagem pagas.
 * @returns {Promise<{ ids: any[], s: object }|null>}
 */
async function procurarEquipaComHoraComum({ empresaId, range, propriedade, tempo, escolhidos }) {
  const k = escolhidos.length;
  const jaTentada = escolhidos.map(String).sort().join('|');
  const { disponiveis } = await obterStaffDisponivel(empresaId, range, propriedade._id, null);
  const pool = [...escolhidos];
  let extra = 0;
  for (const u of disponiveis) {
    if (extra >= MAX_CANDIDATOS_EXTRA) break;
    if (pool.some((x) => String(x) === String(u._id))) continue;
    if (await cabeNoHorario(u._id, range, propriedade.coordenadas, tempo, propriedade._id)) { pool.push(u._id); extra++; }
  }
  let tentadas = 0;
  for (const combo of combinacoes(pool, k)) {
    if (combo.map(String).sort().join('|') === jaTentada) continue;
    if (tentadas++ >= MAX_COMBINACOES) break;
    const s = await calcularInicioEquipa(combo, range.start, propriedade.coordenadas, tempo, null, propriedade._id);
    if (s.cabe) return { ids: combo, s };
  }
  return null;
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
  // Casa inativa (ou de proprietário inativo): nunca se atribui ninguém.
  if (await casaInativa(propriedade)) {
    return {
      utilizador_id: null, equipa_atribuida: [], data: H.horaPadraoDoDia(range.start), tempo_viagem_minutos: 0,
      estado: 'por_atribuir', motivo_nao_atribuicao: 'Casa inativa (ou proprietário inativo): sem atribuição.', faltam: 0,
    };
  }
  const staffNecessario = Math.max(1, Number(propriedade.staff_necessario) || 1);
  const tempo = Number(tempoLimpeza) || propriedade.tempo_limpeza_minutos || 45;

  const dataPadrao = H.horaPadraoDoDia(range.start); // 10:00 de Lisboa por defeito

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
      const d = await diagnosticarFaltaDeStaff(empresaId, range, propriedade._id, null, tempo);
      plano.estado = d.estado;
      plano.motivo_nao_atribuicao = d.motivo;
      return plano;
    }

    // Todos os membros têm de estar presentes: começa quando todos conseguem (horario.js).
    let s = await calcularInicioEquipa(ids, range.start, propriedade.coordenadas, tempo, null, propriedade._id);
    if (!s.cabe && ids.length > 1) {
      // A dupla escolhida não tem hora comum: tenta outras combinações de candidatos elegíveis.
      const alt = await procurarEquipaComHoraComum({ empresaId, range, propriedade, tempo, escolhidos: ids });
      if (alt) { ids = alt.ids; s = alt.s; }
    }
    if (!s.cabe) {
      // Cada um cabia sozinho, mas não há hora comum: fica por atribuir, com o motivo real.
      plano.estado = 'nao_atribuida';
      plano.motivo_nao_atribuicao = ids.length > 1 ? MOTIVO_SEM_HORA_COMUM : (s.motivo || MOTIVO_LOTACAO);
      return plano;
    }
    const dataAgendada = s.data;
    const viagem = Math.max(viagemLB, Number(s.tempoViagem) || 0);

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
async function temSobreposicao(utilizadorId, data, duracaoMin, excluirTarefaId = null, coord = null) {
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
 * A limpeza, na hora em que está, cumpre o horário desta pessoa (janela 09:00-18:00,
 * sem sobreposição com viagens, almoço possível)? Usa a agenda real; a própria
 * tarefa fica de fora. Sem hora real (meia-noite) devolve true (ainda não agendada).
 * @returns {Promise<boolean>}
 */
async function cabeNaAgendaNaHora(utilizadorId, data, duracaoMin, excluirTarefaId, coord = null, propId = null) {
  if (!H.temHoraReal(data)) return true;
  const ag = await carregarAgenda(utilizadorId, data, excluirTarefaId);
  const dur = Number(duracaoMin) || 45;
  const ini = H.minutosLocais(data);
  // Hora já fora da janela (dados antigos): não a «piora»; só recusa sobreposições.
  if (ini < H.HORARIO.INICIO_DIA || ini >= H.HORARIO.FIM_DIA) {
    return !(await temSobreposicao(utilizadorId, data, dur, excluirTarefaId));
  }
  const nova = { duracao: dur, coord, propId, nova: true, ini, fim: ini + dur };
  const viagemFn = await prepararViagens(ag, nova, new Date(data));
  return H.cabeNoDia(ag, nova, viagemFn);
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
  if (await casaInativa(propriedade)) return out; // casa inativa: não se preenchem vagas

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
      if (!(await cabeNaAgendaNaHora(id, tarefa.data, tempo, tarefa._id, propriedade.coordenadas, propriedade._id))) out.conflitos++;
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

/**
 * Trata UMA tarefa sem pessoa ou com vaga (a mesma lógica da Fase A do cão de
 * guarda e do preenchimento após o fim de uma ausência).
 *  - vaga numa equipa incompleta -> `preencherVagaTarefa`;
 *  - sem pessoa -> `planearAtribuicao` + gravação CONDICIONAL (filtro de estado):
 *    duas execuções em simultâneo não duplicam atribuições nem avisos;
 *  - 'em_curso' sem pessoa e com trabalho feito: não se mexe (o gestor decide).
 * @param {object} tarefa - lean, com `propriedade_id` populado (nome, coordenadas, staff_necessario)
 * @param {Date} dia - dia (UTC) onde o motor procura pessoas
 * @returns {Promise<{ resultado: 'atribuida'|'orfa'|'em_curso_com_trabalho', novos: any[], propNome: string }>}
 */
async function atribuirTarefaEmFalta(tarefa, dia) {
  const propriedade = tarefa.propriedade_id || {};
  const propNome = propriedade.nome ?? 'Propriedade';
  const fantasma = semPessoa(tarefa);
  if (fantasma && !recuperavelSemPessoa(tarefa)) {
    return { resultado: 'em_curso_com_trabalho', novos: [], propNome };
  }
  if (tarefa.estado === 'atribuida' && !fantasma) {
    const v = await preencherVagaTarefa({ empresaId: tarefa.empresa_id, tarefa, propriedade });
    return { resultado: v.novos.length > 0 ? 'atribuida' : 'orfa', novos: v.novos, propNome };
  }
  const plano = await planearAtribuicao({
    empresaId: tarefa.empresa_id,
    propriedade,
    dia,
    tempoLimpeza: tarefa.tempo_limpeza_minutos || 45,
  });
  if (plano.estado === 'atribuida') {
    const r = await Tarefa.updateOne(
      { _id: tarefa._id, estado: tarefa.estado, utilizador_id: null },
      {
        $set: {
          utilizador_id: plano.utilizador_id,
          equipa_atribuida: plano.equipa_atribuida,
          estado: 'atribuida',
          data: plano.data,
          tempo_viagem_minutos: plano.tempo_viagem_minutos,
          motivo_nao_atribuicao: null,
          pessoas_em_falta: plano.faltam,
          desatribuida_manual: false,
        },
      }
    );
    // Só conta (e avisa) quem gravou mesmo.
    return r.modifiedCount === 1
      ? { resultado: 'atribuida', novos: plano.equipa_atribuida, propNome }
      : { resultado: 'orfa', novos: [], propNome };
  }
  // Causa real: lotação -> 'nao_atribuida'; ausência/folga/sem equipa -> 'por_atribuir'.
  await Tarefa.updateOne(
    { _id: tarefa._id, utilizador_id: null, estado: tarefa.estado },
    { $set: { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao } }
  );
  return { resultado: 'orfa', novos: [], propNome };
}

/**
 * Quando alguém volta a ficar disponível (ausência cancelada ou rejeitada), preenche
 * NA HORA as vagas dos dias [max(inicio, hoje), fim] da empresa: tarefas sem pessoa
 * (`por_atribuir`/`nao_atribuida`/fantasma recuperável) e equipas com vaga. O motor
 * escolhe a melhor pessoa disponível (não tem de ser a que voltou). Nunca toca em
 * concluida/cancelada nem em em_curso com trabalho feito.
 *
 * Best-effort: NUNCA lança. Serializado por empresa (lock Mongo) para que duas
 * execuções simultâneas não dupliquem atribuições nem notificações.
 * @returns {Promise<{ total: number, atribuidas: number, orfas: number, erro?: string }>}
 */
async function preencherVagasPeriodo(empresaId, inicio, fim) {
  const vazio = { total: 0, atribuidas: 0, orfas: 0 };
  let dono = null;
  const chave = `vagas:${empresaId}`;
  const { obterLock, libertarLock, renovarLock } = require('./lockEmpresa');
  try {
    const agora = new Date();
    const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
    const de = new Date(Math.max(new Date(inicio).getTime(), hoje.getTime()));
    const ate = new Date(new Date(fim).getTime() + 24 * 60 * 60 * 1000);
    if (ate <= de) return vazio;

    dono = await obterLock(chave, { ttlMs: 60000, esperaMs: 5000 });
    if (!dono) return { ...vazio, erro: 'ocupado' };

    // Lê DEPOIS de obter o lock: uma execução anterior já preencheu o que podia.
    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      data: { $gte: de, $lt: ate },
      // Manutenções (avarias) não vão para a equipa de limpeza: o gestor atribui-as à mão.
      tipo: { $ne: 'manutencao' },
      $or: [
        // Tarefas que o gestor desatribuiu à mão de propósito ficam de fora.
        { estado: { $in: ['por_atribuir', 'nao_atribuida'] }, utilizador_id: null, desatribuida_manual: { $ne: true } },
        { estado: 'atribuida', pessoas_em_falta: { $gt: 0 } },
        FILTRO_SEM_PESSOA,
      ],
    })
      .populate({ path: 'propriedade_id', select: 'nome coordenadas staff_necessario tempo_limpeza_minutos' })
      .lean();

    let atribuidas = 0;
    let orfas = 0;
    const recebidas = new Map(); // pessoa -> nomes de propriedades (um aviso por pessoa)
    for (let i = 0; i < tarefas.length; i++) {
      const t = tarefas[i];
      // Heartbeat: o ciclo pode demorar mais que o TTL (60 s); renova a cada 20 tarefas.
      if (i > 0 && i % 20 === 0) await renovarLock(chave, dono, 60000);
      try {
        const d = new Date(t.data);
        const dia = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const r = await atribuirTarefaEmFalta(t, dia);
        if (r.resultado === 'atribuida') {
          atribuidas++;
          for (const id of r.novos) {
            const k = String(id);
            recebidas.set(k, [...(recebidas.get(k) || []), r.propNome]);
          }
        } else {
          orfas++;
        }
      } catch (e) {
        orfas++;
        console.error(`⚠️  [preencherVagasPeriodo] tarefa ${t._id}:`, e.message);
      }
    }

    const { notificarUtilizador } = require('./notificar');
    for (const [id, props] of recebidas) {
      // Uma falha numa pessoa não impede os avisos às outras.
      try {
        await notificarUtilizador(
          id,
          '🧹 Nova Limpeza Atribuída',
          props.length === 1
            ? `Foste escalado para limpar a ${props[0]}.`
            : `Foste escalado para ${props.length} limpezas: ${[...new Set(props)].join(', ')}.`,
          '/staff',
          { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId), criarInApp: true }
        );
      } catch (e) {
        console.error('⚠️  [preencherVagasPeriodo] notificar:', e.message);
      }
    }
    return { total: tarefas.length, atribuidas, orfas };
  } catch (err) {
    console.error('⚠️  [preencherVagasPeriodo] falhou (best-effort):', err.message);
    return { ...vazio, erro: err.message };
  } finally {
    if (dono) await libertarLock(chave, dono);
  }
}

/**
 * A ausência deixou de valer (cancelada ou rejeitada): preenche NA HORA as vagas do
 * período, de hoje em diante, sem clique. Best-effort: nunca lança e nunca demora mais
 * de `limiteMs` a devolver (se o motor for lento, continua em segundo plano e a
 * resposta HTTP segue com `em_segundo_plano`).
 * @returns {Promise<{ total, atribuidas, orfas, erro?: string, em_segundo_plano?: boolean }>}
 */
async function preencherVagasAposAusencia(ausencia, limiteMs = 10000) {
  const trabalho = Promise.resolve()
    .then(() => preencherVagasPeriodo(ausencia.empresa_id, ausencia.data_inicio, ausencia.data_fim))
    .catch((e) => ({ total: 0, atribuidas: 0, orfas: 0, erro: e.message }));
  let timer;
  const prazo = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ total: 0, atribuidas: 0, orfas: 0, em_segundo_plano: true }), limiteMs);
    if (timer.unref) timer.unref();
  });
  const r = await Promise.race([trabalho, prazo]);
  clearTimeout(timer);
  return r;
}

module.exports = {
  preencherVagasAposAusencia,
  atribuirTarefaEmFalta,
  preencherVagasPeriodo,
  FILTRO_SEM_PESSOA,
  semPessoa,
  temProgresso,
  recuperavelSemPessoa,
  avisarColegasDoSubstituto,
  preencherVagaTarefa,
  temSobreposicao,
  cabeNaAgendaNaHora,
  planearVaga,
  diagnosticarFaltaDeStaff,
  planearAtribuicao,
  MOTIVO_SEM_EQUIPA,
  MOTIVO_INDISPONIVEL,
  MOTIVO_LOTACAO,
};
