/**
 * Filtro rápido «Hoje / Amanhã» da lista de tarefas do gestor.
 * Os dias são os de calendário de Lisboa; o dia de uma tarefa é o dia (UTC) de `data`,
 * como em todo o sistema (as horas de trabalho caem sempre no mesmo dia UTC).
 */

import { hojeLisboaISO, somarDiasISO } from "./reservas-externas";

export type DiaRapido = "hoje" | "amanha";

/** Dias (aaaa-mm-dd) que o filtro deixa passar; vazio = sem filtro. */
export function diasDoFiltro(escolhidos: Iterable<DiaRapido>, agora: Date = new Date()): string[] {
  const set = new Set(escolhidos);
  const hoje = hojeLisboaISO(agora);
  const dias: string[] = [];
  if (set.has("hoje")) dias.push(hoje);
  if (set.has("amanha")) dias.push(somarDiasISO(hoje, 1));
  return dias;
}

/** A tarefa passa o filtro? Sem dias = passa tudo; data inválida não passa quando há filtro. */
export function passaFiltroRapido(dataISO: string | null | undefined, dias: string[]): boolean {
  if (dias.length === 0) return true;
  const d = typeof dataISO === "string" ? dataISO.slice(0, 10) : "";
  return dias.includes(d);
}

const CHAVE = "all2gether_tarefas_filtro_dias";

/** Escolha lembrada por utilizador (opcional; nunca lança). */
export function lerEscolhaGuardada(utilizadorId: string | null | undefined): DiaRapido[] {
  try {
    const bruto = window.localStorage.getItem(`${CHAVE}:${utilizadorId || "anon"}`);
    const arr = bruto ? JSON.parse(bruto) : [];
    return Array.isArray(arr) ? arr.filter((x): x is DiaRapido => x === "hoje" || x === "amanha") : [];
  } catch {
    return [];
  }
}

export function guardarEscolha(utilizadorId: string | null | undefined, escolha: DiaRapido[]): void {
  try {
    window.localStorage.setItem(`${CHAVE}:${utilizadorId || "anon"}`, JSON.stringify(escolha));
  } catch {
    /* sem armazenamento: continua a funcionar sem lembrar */
  }
}
