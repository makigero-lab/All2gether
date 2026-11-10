/**
 * Horário de trabalho — All2gether (UM só sítio para as regras e o cálculo).
 *
 * Regras (hora de Lisboa, com hora de verão):
 *   - Dia de trabalho das 09:00 às 17:30; uma limpeza pode acabar até às 18:00.
 *   - Almoço de 1 h depois da limpeza que acabar a partir das 12:00; começa
 *     entre as 12:00 e as 14:00 (nenhuma limpeza empurra o início para depois).
 *   - Domingo é um dia normal (só contam folgas e ausências).
 *   - Viagens contam na agenda.
 *
 * Este módulo é PURO (sem base de dados nem rede): recebe a agenda já carregada
 * e uma função de viagem síncrona. O `scheduler.js` carrega os dados e a
 * `distancia.js` calcula as viagens (Google Maps com cache e fallback).
 *
 * Os instantes são Date UTC; as horas do dia são «minutos desde a meia-noite
 * de Lisboa». O «dia» de uma tarefa é o dia UTC de `data` (09:00-18:00 locais
 * caem sempre no mesmo dia UTC).
 */

const FUSO = 'Europe/Lisbon';

const MIN = (h, m = 0) => h * 60 + m;

const HORARIO = Object.freeze({
  INICIO_DIA: MIN(9, 0), // nenhuma limpeza começa antes
  FIM_DIA: MIN(17, 30), // nenhuma limpeza começa a partir daqui
  FIM_MAXIMO_LIMPEZA: MIN(18, 0), // uma limpeza acaba, no máximo, às 18:00
  ALMOCO_DURACAO: 60,
  ALMOCO_JANELA_INICIO: MIN(12, 0), // o almoço nunca começa antes
  ALMOCO_INICIO_MAXIMO: MIN(14, 0), // nem depois (limite do INÍCIO do almoço)
  HORA_PADRAO_SEM_ATRIBUICAO_UTC: 10, // placeholder de tarefas ainda sem pessoa
});

/** Janela do dia (09:00-18:00) em minutos. */
const JANELA_DIA_MINUTOS = HORARIO.FIM_MAXIMO_LIMPEZA - HORARIO.INICIO_DIA;
/**
 * Pré-filtro barato de carga (janela menos almoço = 480 min). A decisão real é
 * `cabeNoDia` (que conta início, fim, almoço e viagens); isto só serve para
 * perguntas simples como «esta duração alguma vez cabe?».
 */
const CAPACIDADE_MAXIMA_MINUTOS = JANELA_DIA_MINUTOS - HORARIO.ALMOCO_DURACAO;

const _fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSO,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function partesLisboa(d) {
  const o = {};
  for (const p of _fmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** Desfasamento de Lisboa em relação a UTC, em minutos (0 no inverno, 60 no verão). */
function offsetLisboaMin(d) {
  const p = partesLisboa(d);
  const comoUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((comoUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Minutos desde a meia-noite de Lisboa. */
function minutosLocais(d) {
  const p = partesLisboa(new Date(d));
  return p.hour * 60 + p.minute;
}

/** 'aaaa-mm-dd' do dia UTC de um instante. */
function diaUTC(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** Instante UTC correspondente a `min` minutos locais de Lisboa no dia 'aaaa-mm-dd'. */
function utcDeMinutosLocais(diaISO, min) {
  const [y, m, d] = diaISO.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 0, 0, 0) + min * 60000;
  let t = base - offsetLisboaMin(new Date(base)) * 60000;
  // Segunda passagem: perto das mudanças de hora o desfasamento muda.
  t = base - offsetLisboaMin(new Date(t)) * 60000;
  return new Date(t);
}

/**
 * Tarefa «sem hora real» = exatamente meia-noite (UTC, o marcador antigo de data
 * sem hora, ou 00:00 de Lisboa). Qualquer outra hora conta como real.
 */
function temHoraReal(d) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return false;
  const meiaNoiteUTC = x.getUTCHours() === 0 && x.getUTCMinutes() === 0 && x.getUTCSeconds() === 0;
  return !meiaNoiteUTC && minutosLocais(x) !== 0;
}

/** O intervalo [ini, ini+dur] (minutos locais) cumpre a janela do dia? */
function dentroDaJanela(ini, dur) {
  return ini >= HORARIO.INICIO_DIA && ini < HORARIO.FIM_DIA && ini + dur <= HORARIO.FIM_MAXIMO_LIMPEZA;
}

/** Uma limpeza desta duração cabe alguma vez num dia (com o almoço)? */
function duracaoCabeNoHorario(dur) {
  const d = Number(dur) || 0;
  // Antes do almoço: de 09:00 até ao fim máximo do início do almoço; depois: das 13:00 às 18:00.
  const antes = HORARIO.ALMOCO_INICIO_MAXIMO - HORARIO.INICIO_DIA;
  const depois = HORARIO.FIM_MAXIMO_LIMPEZA - (HORARIO.ALMOCO_JANELA_INICIO + HORARIO.ALMOCO_DURACAO);
  return d > 0 && d <= Math.max(antes, depois);
}

/* ------------------------------------------------------------------ */
/* Agenda de um dia                                                     */
/* ------------------------------------------------------------------ */
/*
 * Item da agenda: { ini, fim, coord?, propId?, viagem? }   (minutos locais)
 *   `viagem` = viagem gravada ANTES desta tarefa (só para pares já existentes).
 * Nova limpeza: { ini, fim, nova: true, coord?, propId? }
 * `viagemFn(a, b)` devolve os minutos de a para b (simétrica).
 */

function viagemEntre(viagemFn, a, b) {
  return Math.max(0, Number(viagemFn(a, b)) || 0);
}

/** Inícios possíveis do almoço nesta agenda (12:00 e fins de limpezas dentro da janela). */
function candidatosAlmoco(itens) {
  const set = new Set([HORARIO.ALMOCO_JANELA_INICIO]);
  for (const x of itens) {
    if (x.fim >= HORARIO.ALMOCO_JANELA_INICIO && x.fim <= HORARIO.ALMOCO_INICIO_MAXIMO) set.add(x.fim);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * O almoço cumpre as regras? Simula o dia por ordem de início:
 *   - só é preciso almoço se alguma limpeza acabar a partir das 12:00;
 *   - almoça-se logo a seguir à primeira limpeza que acaba a partir das 12:00
 *     (acabou às 12:00, almoça às 12:00) ou, se a pessoa está parada antes de uma
 *     limpeza que só começa depois do almoço, às 12:00;
 *   - o almoço começa, no máximo, às 14:00: nenhuma limpeza o empurra para depois;
 *   - a limpeza seguinte só começa depois do almoço (mais a viagem).
 * @returns {{ ok: boolean, necessario: boolean, inicio: number|null }}
 */
function verificarAlmoco(itens, viagemFn) {
  const necessario = itens.some((x) => x.fim >= HORARIO.ALMOCO_JANELA_INICIO);
  if (!necessario) return { ok: true, necessario: false, inicio: null };
  const ord = [...itens].sort((a, b) => a.ini - b.ini || a.fim - b.fim);
  const D = HORARIO.ALMOCO_DURACAO;
  let anterior = null;
  for (const x of ord) {
    const vAnt = anterior ? viagemEntre(viagemFn, anterior, x) : 0;
    // Parada antes desta limpeza: o almoço cabe às 12:00 (com a viagem depois dele).
    if (anterior === null || anterior.fim < HORARIO.ALMOCO_JANELA_INICIO) {
      if (x.ini >= HORARIO.ALMOCO_JANELA_INICIO + D + vAnt) {
        return { ok: true, necessario: true, inicio: HORARIO.ALMOCO_JANELA_INICIO };
      }
    }
    if (x.fim >= HORARIO.ALMOCO_JANELA_INICIO) {
      // Almoço logo a seguir a esta limpeza.
      const L = x.fim;
      if (L > HORARIO.ALMOCO_INICIO_MAXIMO) return { ok: false, necessario: true, inicio: null };
      const seguinte = ord[ord.indexOf(x) + 1];
      if (seguinte) {
        const v = viagemEntre(viagemFn, x, seguinte);
        if (seguinte.ini < L + D + v) return { ok: false, necessario: true, inicio: null };
      }
      return { ok: true, necessario: true, inicio: L };
    }
    anterior = x;
  }
  return { ok: true, necessario: true, inicio: null };
}

/** A nova limpeza respeita janela, não se sobrepõe (com viagem) e não impede o almoço? */
function cabeNoDia(itens, nova, viagemFn) {
  if (!dentroDaJanela(nova.ini, nova.fim - nova.ini)) return false;
  for (const x of itens) {
    const v = viagemEntre(viagemFn, x, nova);
    const depois = nova.ini >= x.fim + v;
    const antes = x.ini >= nova.fim + v;
    if (!depois && !antes) return false;
  }
  const com = verificarAlmoco([...itens, nova], viagemFn);
  if (com.ok) return true;
  // O dia já tinha o almoço comprometido (ex.: marcação manual): não o piora nem o bloqueia.
  return !verificarAlmoco(itens, viagemFn).ok;
}

/** Inícios a experimentar para a nova limpeza (ordenados, sem repetidos). */
function candidatosInicio(itens, nova, viagemFn) {
  const c = new Set([HORARIO.INICIO_DIA]);
  for (const x of itens) c.add(x.fim + viagemEntre(viagemFn, x, nova));
  for (const L of candidatosAlmoco(itens)) {
    const anterior = [...itens].sort((a, b) => b.fim - a.fim).find((x) => x.fim <= L) || null;
    c.add(L + HORARIO.ALMOCO_DURACAO + (anterior ? viagemEntre(viagemFn, anterior, nova) : 0));
  }
  return [...c].filter((m) => m >= HORARIO.INICIO_DIA).sort((a, b) => a - b);
}

/**
 * Primeiro início possível (minutos locais) para uma limpeza numa agenda, ou null.
 * @param {Array} itens - agenda existente
 * @param {{duracao:number, coord?:any, propId?:any}} nova
 */
function primeiroInicio(itens, nova, viagemFn) {
  const dur = Number(nova.duracao) || 45;
  if (!duracaoCabeNoHorario(dur)) return null;
  for (const ini of candidatosInicio(itens, { ...nova, nova: true }, viagemFn)) {
    if (cabeNoDia(itens, { ...nova, nova: true, ini, fim: ini + dur }, viagemFn)) return ini;
  }
  return null;
}

/**
 * Equipa: primeiro início em que TODOS os membros conseguem.
 * @param {Array<Array>} agendas - uma agenda por membro
 */
function primeiroInicioEquipa(agendas, nova, viagemFn) {
  const dur = Number(nova.duracao) || 45;
  if (!duracaoCabeNoHorario(dur)) return null;
  const todos = new Set();
  for (const ag of agendas) {
    for (const c of candidatosInicio(ag, { ...nova, nova: true }, viagemFn)) todos.add(c);
  }
  for (const ini of [...todos].sort((a, b) => a - b)) {
    const cand = { ...nova, nova: true, ini, fim: ini + dur };
    if (agendas.every((ag) => cabeNoDia(ag, cand, viagemFn))) return ini;
  }
  return null;
}

/** Fim previsto fora do horário (para avisar o gestor numa atribuição manual). */
function avisoForaDoHorario(dataInicio, duracaoMin) {
  if (!temHoraReal(dataInicio)) return null;
  const ini = minutosLocais(dataInicio);
  const dur = Number(duracaoMin) || 45;
  if (ini < HORARIO.INICIO_DIA) return 'começa antes das 09:00';
  if (ini + dur > HORARIO.FIM_MAXIMO_LIMPEZA) return 'acaba depois das 18:00';
  if (ini >= HORARIO.FIM_DIA) return 'começa depois das 17:30';
  return null;
}

/** Formata minutos locais como 'HH:MM'. */
function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

module.exports = {
  FUSO,
  HORARIO,
  JANELA_DIA_MINUTOS,
  CAPACIDADE_MAXIMA_MINUTOS,
  offsetLisboaMin,
  minutosLocais,
  diaUTC,
  utcDeMinutosLocais,
  temHoraReal,
  dentroDaJanela,
  duracaoCabeNoHorario,
  verificarAlmoco,
  cabeNoDia,
  candidatosInicio,
  primeiroInicio,
  primeiroInicioEquipa,
  avisoForaDoHorario,
  hhmm,
};
