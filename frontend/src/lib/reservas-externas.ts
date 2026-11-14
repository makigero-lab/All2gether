/**
 * Ajudas puras da lista «Reservas por confirmar» (períodos vindos de calendários externos), partilhadas pelo gestor
 * e pelo proprietário: datas com ano, ordem por chegada, filtro rápido por data e frases dos avisos.
 * Sem imports, para poderem ser testadas sozinhas.
 */

export interface PeriodoExterno { check_in: string; check_out: string; noites: number; motivo?: string | null; canal_texto?: string }

/** Filtro rápido por data de chegada. «todas» é o valor por defeito: nada fica escondido sem o gestor escolher. */
export type FiltroChegada = "todas" | "semana" | "7dias";

export const OPCOES_CHEGADA: { valor: FiltroChegada; texto: string; dica: string }[] = [
  { valor: "todas", texto: "Todas", dica: "Todos os períodos por confirmar" },
  { valor: "semana", texto: "Esta semana", dica: "Chegadas até domingo (e períodos já em curso)" },
  { valor: "7dias", texto: "Próximos 7 dias", dica: "Chegadas nos próximos 7 dias (e períodos já em curso)" },
];

/** Dia de hoje em Lisboa (aaaa-mm-dd), seja qual for o fuso do computador. */
export function hojeLisboaISO(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}

/** Soma dias a uma data aaaa-mm-dd (em UTC, sem saltos de hora de verão). */
export function somarDiasISO(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Último dia a incluir no filtro (aaaa-mm-dd), ou null para «todas». A semana acaba no domingo; no domingo é só hoje. */
export function ultimoDiaDoFiltro(f: FiltroChegada, hoje: string): string | null {
  if (f === "7dias") return somarDiasISO(hoje, 7);
  if (f === "semana") {
    const diaSemana = new Date(`${hoje}T00:00:00Z`).getUTCDay(); // 0 = domingo
    return somarDiasISO(hoje, diaSemana === 0 ? 0 : 7 - diaSemana);
  }
  return null;
}

/** Aplica o filtro no ecrã (o gestor filtra no servidor; o proprietário tem listas curtas e filtra aqui). */
export function passaFiltroChegada(x: Pick<PeriodoExterno, "check_in">, f: FiltroChegada, hoje: string): boolean {
  const ate = ultimoDiaDoFiltro(f, hoje);
  return ate === null || x.check_in <= ate;
}

/** Datas mais cedo primeiro (chegada e, a seguir, saída). Devolve uma cópia. */
export function ordenarPorChegada<T extends Pick<PeriodoExterno, "check_in" | "check_out">>(lista: T[]): T[] {
  return [...lista].sort((a, b) => (a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : a.check_out < b.check_out ? -1 : a.check_out > b.check_out ? 1 : 0));
}

/** «14/11/2026». */
export const dataComAno = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** «14/11/2026 a 16/11/2026». */
export const periodoComAno = (x: Pick<PeriodoExterno, "check_in" | "check_out">): string => `${dataComAno(x.check_in)} a ${dataComAno(x.check_out)}`;

/** Frase junto de «Escolher todos» quando há períodos longos que ficam de fora; null se não há. */
export function textoLongosDeFora(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 de mais de 30 noites fica de fora:" : `${n} de mais de 30 noites ficam de fora:`;
}

/** Texto do diálogo de confirmação de «Marcar como bloqueio» em lote. */
export function textoConfirmarBloqueio(n: number): { titulo: string; descricao: string; confirmar: string } {
  return {
    titulo: n === 1 ? "Marcar 1 período como bloqueio?" : `Marcar ${n} períodos como bloqueio?`,
    descricao: `${n === 1 ? "Fica ignorado" : "Ficam ignorados"}: não ${n === 1 ? "cria" : "criam"} limpezas e não voltamos a perguntar. Acontece já e não se desfaz aqui.`,
    confirmar: n === 1 ? "Marcar como bloqueio" : `Marcar ${n} como bloqueio`,
  };
}
