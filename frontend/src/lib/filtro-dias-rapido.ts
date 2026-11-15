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
export function lerEscolhaGuardada(utilizadorId: string | null | undefined, agora: Date = new Date()): DiaRapido[] {
  try {
    const bruto = window.localStorage.getItem(`${CHAVE}:${utilizadorId || "anon"}`);
    const o = bruto ? JSON.parse(bruto) : null;
    // Só vale no mesmo dia de Lisboa em que foi escolhida: no dia seguinte começa sem filtro (e o formato antigo, sem dia, caduca).
    if (!o || Array.isArray(o) || o.dia !== hojeLisboaISO(agora) || !Array.isArray(o.escolha)) return [];
    return o.escolha.filter((x: unknown): x is DiaRapido => x === "hoje" || x === "amanha");
  } catch {
    return [];
  }
}

export function guardarEscolha(utilizadorId: string | null | undefined, escolha: DiaRapido[], agora: Date = new Date()): void {
  try {
    window.localStorage.setItem(`${CHAVE}:${utilizadorId || "anon"}`, JSON.stringify({ dia: hojeLisboaISO(agora), escolha }));
  } catch {
    /* sem armazenamento: continua a funcionar sem lembrar */
  }
}
