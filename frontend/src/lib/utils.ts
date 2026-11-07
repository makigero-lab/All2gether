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
 * Regra: só é "sem hora" a tarefa exatamente à meia-noite (00:00 UTC, o
 * marcador de data sem hora, ou 00:00 locais). Qualquer outra hora é real e
 * mostra-se sempre, mesmo que seja errada: nunca se esconde um erro.
 */
export function temHoraReal(dataISO: string): boolean {
  try {
    const d = parsearDataSegura(dataISO);
    if (!d) return true;
    const meiaNoiteUTC = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    const meiaNoiteLocal = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    return !(meiaNoiteUTC || meiaNoiteLocal);
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
 * Prompt 127/132 — Extrai a hora (HH:mm) de uma string ISO, convertendo
 * de UTC para o fuso de Portugal (Europe/Lisbon).
 *
 * O backend (Prompt 128) grava a hora de Portugal como UTC ajustado:
 * se o gestor envia "11:00", o backend grava como "10:00:00.000Z" (verão UTC+1).
 *
 * Esta função converte o instante UTC de volta para a hora de Portugal
 * usando Intl.DateTimeFormat com timeZone: 'Europe/Lisbon'. Assim,
 * "2026-07-15T10:00:00.000Z" → "11:00" (verão) ✅
 *
 * Se a string não tiver componente de tempo, devolve "—".
 * Se for 00:00 (meia-noite em Portugal), devolve "—" (sem hora real).
 */
export function extrairHoraISO(iso: string | null | undefined): string {
  if (!iso) return "—";
  const str = String(iso).trim();

  // Se não tem componente de tempo, não há hora.
  if (!str.includes("T") && !str.match(/\s\d{2}:\d{2}/)) return "—";

  try {
    const d = parsearDataSegura(str);
    if (!d) return "—";

    // Converte para hora de Portugal usando Intl.
    const horaPT = new Intl.DateTimeFormat("pt-PT", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Lisbon",
    }).format(d);

    // Se for "00:00" (meia-noite em Portugal), considera sem hora real.
    if (horaPT === "00:00") return "—";

    return horaPT;
  } catch {
    return "—";
  }
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

/**
 * FIX (google maps integration) — Gera um URL para abrir uma localização no
 * Google Maps (app web ou mobile).
 *
 * Aceita:
 *   - Coordenadas { lat, lng } → usa o formato `?query=lat,lng` (mais preciso).
 *   - String de morada → usa o formato `?query=morada` (URL-encoded).
 *
 * Usa o endpoint universal `https://www.google.com/maps/search/?api=1&query=...`
 * que funciona em browser, iOS e Android (abre a app nativa se instalada).
 *
 * @param input coordenadas { lat, lng } ou string de morada
 * @returns URL do Google Maps, ou null se input for inválido.
 */
export function googleMapsUrl(
  input: { lat: number; lng: number } | string | null | undefined
): string | null {
  if (!input) return null;

  // Se for coordenadas { lat, lng }.
  if (typeof input === "object" && input !== null) {
    const { lat, lng } = input;
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lng)
    ) {
      return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }
    return null;
  }

  // Se for string de morada.
  const morada = String(input).trim();
  if (!morada) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(morada)}`;
}

/**
 * Escapa um valor para o inserir de forma segura em HTML construído por
 * concatenação (ex.: janela de impressão com document.write).
 * Aceita qualquer valor; null/undefined viram texto vazio.
 */
export function escaparHtml(valor: unknown): string {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Resposta de redistribuição devolvida ao aprovar/confirmar uma ausência. */
export type RedistribuicaoDTO = {
  total: number;
  desatribuidas: number;
  reatribuicao?: {
    total?: number;
    reatribuidas?: number;
    orfas?: number;
    /** Limpezas que continuam com equipa incompleta (falta pelo menos 1 pessoa). */
    parciais?: number;
    faltam?: { propriedade?: string; faltam?: number }[];
    erro?: string;
  } | null;
  aviso?: string;
};

/** Resultado da reatribuição só é fiável se não houve erro e os números existem. */
function reatribuicaoFiavel(
  r: RedistribuicaoDTO | null | undefined
): { reatribuidas: number; orfas: number; vagasTarefas: number; vagas: number } | null {
  const re = r?.reatribuicao;
  if (re && !re.erro && typeof re.reatribuidas === "number" && typeof re.orfas === "number") {
    const lista = Array.isArray(re.faltam) ? re.faltam : [];
    const vagas = lista.reduce((acc, f) => acc + (Number(f?.faltam) || 0), 0);
    const vagasTarefas = Math.max(Number(re.parciais) || 0, lista.length);
    return { reatribuidas: re.reatribuidas, orfas: re.orfas, vagasTarefas, vagas: vagas || vagasTarefas };
  }
  return null;
}

/**
 * Quantas tarefas ficaram por atribuir depois da ausência. Com reatribuição
 * fiável são as órfãs reais (podem incluir tarefas que já estavam por atribuir
 * no período); se a reatribuição falhou, são as que acabaram de ser desatribuídas.
 */
export function tarefasPorAtribuir(r: RedistribuicaoDTO | null | undefined): number {
  const re = reatribuicaoFiavel(r);
  // Inclui as limpezas com equipa incompleta: também precisam de "Reatribuir automaticamente".
  if (re) return re.orfas + re.vagasTarefas;
  return Math.max(0, r?.desatribuidas ?? 0);
}

/**
 * Texto verdadeiro sobre o que aconteceu às tarefas depois de uma ausência:
 * reatribuídas automaticamente vs. por atribuir.
 *
 * A reatribuição processa TODAS as tarefas por atribuir da empresa no período,
 * não só as da pessoa ausente: por isso usa os números reais (`reatribuidas` e
 * `orfas`) e avisa quando excedem as desatribuídas. Se a reatribuição falhou
 * (`erro`) ou não veio na resposta, diz que ficaram por atribuir.
 */
export function textoRedistribuicao(
  prefixo: string,
  r: RedistribuicaoDTO | null | undefined,
  semTarefas: string
): string {
  const desatribuidas = r?.desatribuidas ?? 0;
  const re = reatribuicaoFiavel(r);
  if (re) {
    const partes: string[] = [];
    if (re.reatribuidas > 0) partes.push(`${plural(re.reatribuidas, "tarefa reatribuída", "tarefas reatribuídas")} automaticamente`);
    if (re.orfas > 0) partes.push(`${re.orfas} por atribuir (ninguém disponível)`);
    if (re.vagasTarefas > 0) {
      partes.push(
        re.vagasTarefas === 1
          ? `1 limpeza ficou a faltar ${re.vagas} ${re.vagas === 1 ? "pessoa" : "pessoas"}`
          : `${re.vagasTarefas} limpezas ficaram a faltar pessoas (${re.vagas} vagas)`
      );
    }
    if (partes.length === 0) return `${prefixo} ${semTarefas}`;
    const extra =
      re.reatribuidas + re.orfas > desatribuidas + re.vagasTarefas
        ? " Inclui outras tarefas do período que já estavam por atribuir."
        : "";
    return `${prefixo} ${partes.join("; ")}.${extra}`;
  }
  if (r?.reatribuicao?.erro) {
    return desatribuidas > 0
      ? `${prefixo} Não foi possível reatribuir automaticamente: ${plural(desatribuidas, "tarefa", "tarefas")} por atribuir.`
      : `${prefixo} Não foi possível reatribuir automaticamente.`;
  }
  if (!(desatribuidas > 0)) return `${prefixo} ${semTarefas}`;
  return `${prefixo} ${plural(desatribuidas, "tarefa")} por atribuir.`;
}

/**
 * «1 tarefa» / «2 tarefas»: singular e plural reais (nunca «tarefa(s)»).
 * O plural regular acrescenta «s»; para outros passa-se a forma do plural.
 */
export function plural(n: number | string | null | undefined, singular: string, pluralForma?: string): string {
  // parseFloat aceita «1 reserva» (encadeado: plural(plural(1, "reserva"), "criada") => «1 reserva criada»)
  const num = typeof n === "string" ? parseFloat(n) : Number(n);
  return `${n ?? 0} ${num === 1 ? singular : pluralForma ?? `${singular}s`}`;
}

/**
 * Checklist que o staff vê: a da PRÓPRIA tarefa (do tipo de limpeza) e, só se vier vazia
 * (tarefas antigas), a da casa.
 */
export function checklistDaTarefa(
  tarefa: { checklist?: unknown; propriedade_id?: { checklist?: unknown } | null } | null | undefined
): string[] {
  const dela = Array.isArray(tarefa?.checklist) ? (tarefa!.checklist as string[]) : [];
  if (dela.length > 0) return dela;
  const dacasa = tarefa?.propriedade_id?.checklist;
  return Array.isArray(dacasa) ? (dacasa as string[]) : [];
}

/** Data por extenso igual nos três portais: «Sexta-feira, 6 de novembro». */
export function dataPorExtenso(d: Date): string {
  const partes = new Intl.DateTimeFormat("pt-PT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Lisbon",
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  const semana = p("weekday");
  return `${semana.charAt(0).toUpperCase()}${semana.slice(1)}, ${p("day")} de ${p("month")}`;
}
