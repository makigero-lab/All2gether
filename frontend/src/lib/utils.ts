import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combina classes Tailwind de forma segura (clsx + tailwind-merge).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Prompt 113 — Fix de fuso horário (Lisboa/WEST).
 *
 * Converte uma data de input HTML (`YYYY-MM-DD`, ex.: "2026-07-15") num ISO
 * que represente a MEIA-NOITE LOCAL do utilizador.
 *
 * Porquê: `new Date("2026-07-15")` (date-only) é interpretado pela spec JS
 * como meia-noite UTC. No backend (que armazena o instante), isso aparece em
 * Lisboa (UTC+1 no verão) como 01:00 do mesmo dia — e fica abaixo do
 * slotMinTime 08:00 do calendário, invisível nas vistas semanal/diária.
 *
 * Com esta função, o frontend constrói a data como LOCAL:
 *   `new Date("2026-07-15T00:00:00")` → meia-noite no fuso do browser
 *   `.toISOString()` → "2026-07-14T23:00:00.000Z" (Lisboa)
 *
 * O backend armazena este instante diretamente. Ao renderizar no browser,
 * volta a ser 00:00 local do dia 15 — correto.
 *
 * @param dataYYYYMMDD string no formato "YYYY-MM-DD"
 * @returns ISO string (com Z) da meia-noite local
 */
export function paraIsoMeiaNoiteLocal(dataYYYYMMDD: string): string {
  // `new Date("2026-07-15T00:00:00")` (sem Z) é interpretado como LOCAL.
  const d = new Date(`${dataYYYYMMDD}T00:00:00`);
  return d.toISOString();
}

/**
 * Prompt 113 — Determina se uma tarefa (pelo ISO da sua data) tem ou não
 * uma "hora real" de trabalho atribuída pelo load balancer.
 *
 * Tarefas criadas manualmente (só com data) são guardadas à meia-noite local
 * (00:00). Tarefas atribuídas pelo load balancer têm horas reais (09:00+).
 * No calendário, as primeiras devem aparecer como "todo o dia" (all-day)
 * para não ficarem abaixo do slotMinTime 08:00 (invisíveis).
 *
 * Heurística: se a hora local for anterior a 8 (ou seja, 00:00, 01:00 de
 * dados antigos em UTC midnight, etc.), consideramos que não tem hora real
 * de trabalho → render all-day.
 */
export function temHoraReal(dataISO: string): boolean {
  try {
    const d = new Date(dataISO);
    // Hora LOCAL (o browser está em Lisboa).
    return d.getHours() >= 8;
  } catch {
    return true;
  }
}
