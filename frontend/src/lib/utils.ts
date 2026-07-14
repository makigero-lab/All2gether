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
    const d = parsearDataSegura(dataISO);
    if (!d) return true;
    // Hora LOCAL (o browser está em Lisboa).
    return d.getHours() >= 8;
  } catch {
    return true;
  }
}

/**
 * Prompt Extra (Vacina Anti-Safari) — Parsing de datas compatível com iOS/Safari.
 *
 * O Safari (WebKit) NÃO suporta:
 *   - `new Date("2026-07-15 14:00:00")` (espaço em vez de T) → Invalid Date
 *   - `new Date("2026-07-15")` (date-only) → interpretado como UTC (não local)
 *
 * Esta função normaliza QUALQUER string de data para o formato seguro
 * ISO 8601 antes de a passar ao `new Date()`:
 *   1. Substitui espaços por "T" (YYYY-MM-DD HH:mm:ss → YYYY-MM-DDTHH:mm:ss)
 *   2. Se for date-only (YYYY-MM-DD), adiciona "T00:00:00" (interpretado como LOCAL)
 *   3. Devolve o objeto Date (ou null se inválida)
 *
 * Usar SEMPRE esta função em vez de `new Date(iso)` direto para strings
 * que vêm do backend (que podem ter formato com espaço, ex.: checkin/checkout
 * do Smoobu).
 *
 * @param input string de data (ISO, date-only, ou com espaço)
 * @returns Date válido ou null se a data for inválida
 */
export function parsearDataSegura(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

  let str = String(input).trim();

  // 1. Se for date-only "YYYY-MM-DD", adiciona T00:00:00 (LOCAL, não UTC).
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    str = `${str}T00:00:00`;
  }

  // 2. Substitui espaço por "T" (Safari não suporta "YYYY-MM-DD HH:mm:ss").
  //    Mas só se tiver o padrão YYYY-MM-DD seguido de espaço + HH:mm.
  str = str.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");

  // 3. Cria o Date. Se não tiver Z (UTC), é interpretado como LOCAL.
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Prompt Extra (Vacina Anti-Safari) — Formata uma data de forma segura.
 *
 * Usa `parsearDataSegura` internamente para garantir compatibilidade com
 * Safari/iOS. Devolve string formatada ou fallback.
 *
 * @param input string de data
 * @param formatFn função de formatação (ex.: do date-fns)
 * @param fallback string a devolver se a data for inválida
 */
export function formatarDataSegura(
  input: string | Date | null | undefined,
  formatFn: (d: Date) => string,
  fallback = "—"
): string {
  const d = parsearDataSegura(input);
  if (!d) return fallback;
  try {
    return formatFn(d);
  } catch {
    return fallback;
  }
}

/**
 * Prompt 127 — Extrai a hora (HH:mm) diretamente da string ISO sem aplicar
 * a conversão de fuso horário local do browser.
 *
 * O problema: `new Date(iso).getHours()` usa a timezone do BROWSER (Lisboa
 * UTC+1 no verão). Se o backend gravou a tarefa como `new Date("2026-07-15T11:00")`
 * (LOCAL do servidor), o ISO enviado é "2026-07-15T10:00:00.000Z" (UTC). O
 * browser converte de UTC para local (+1h) e mostra 12:00 em vez de 11:00.
 *
 * Esta função faz parse MANUAL da string ISO, extraindo a hora diretamente
 * do texto (não converte para Date). Assim, "2026-07-15T11:00:00.000Z" → "11:00",
 * independentemente do fuso do browser.
 *
 * Se a string não tiver componente de tempo, devolve "—".
 */
export function extrairHoraISO(iso: string | null | undefined): string {
  if (!iso) return "—";
  const str = String(iso).trim();

  // Tenta extrair HH:mm da string ISO (após o "T").
  // Formatos suportados: "2026-07-15T11:00:00.000Z", "2026-07-15T11:00",
  // "2026-07-15 11:00:00" (Safari fallback).
  const match = str.match(/T(\d{2}):(\d{2})/) || str.match(/\s(\d{2}):(\d{2})/);
  if (!match) return "—";

  const horas = parseInt(match[1], 10);
  const minutos = parseInt(match[2], 10);
  if (Number.isNaN(horas) || Number.isNaN(minutos)) return "—";

  // Se for 00:00 (meia-noite), considera "sem hora real" → devolve "—".
  if (horas === 0 && minutos === 0) return "—";

  return `${String(horas).padStart(2, "0")}:${String(minutos).padStart(2, "0")}`;
}

/**
 * Prompt 127 — Calcula a hora de fim (início + minutos) sem converter fuso.
 * Usa extrairHoraISO para obter o início e soma os minutos matematicamente.
 */
export function calcularHoraFimISO(iso: string | null | undefined, minutos: number): string {
  const inicio = extrairHoraISO(iso);
  if (inicio === "—") return "—";

  const [h, m] = inicio.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "—";

  let totalMin = h * 60 + m + (minutos || 0);
  // Wrap around 24h (se passar da meia-noite, mostra a hora do dia seguinte).
  totalMin = totalMin % (24 * 60);

  const fimH = Math.floor(totalMin / 60);
  const fimM = totalMin % 60;
  return `${String(fimH).padStart(2, "0")}:${String(fimM).padStart(2, "0")}`;
}
