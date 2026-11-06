/**
 * Ordenação da tabela de reservas do parceiro (lógica pura, testável).
 *
 * Datas ordenam-se como datas (AAAA-MM-DD), números como números e texto em
 * pt-PT sem distinguir maiúsculas/acentos. Valores vazios ficam SEMPRE no fim,
 * quer a ordem seja ascendente quer descendente. A ordenação é estável (empates
 * mantêm a ordem anterior). A preferência guarda-se em localStorage.
 */

export type Direcao = "asc" | "desc";
export type TipoOrdem = "texto" | "data" | "numero";

export interface Ordem {
  chave: string;
  direcao: Direcao;
}

/** Por omissão: check-in ascendente. */
export const ORDEM_OMISSAO: Ordem = { chave: "check_in", direcao: "asc" };

export const CHAVE_ORDEM_ARMAZEM = "a2g_ordem_reservas_parceiro";

const RE_DATA = /^\d{4}-\d{2}-\d{2}/;

type Normalizado = { vazio: true } | { vazio: false; n?: number; t?: string };

function normalizar(v: string | number | null | undefined, tipo: TipoOrdem): Normalizado {
  if (v === null || v === undefined) return { vazio: true };
  if (tipo === "numero") {
    const n = typeof v === "number" ? v : parseFloat(String(v).trim().replace(",", "."));
    return Number.isFinite(n) ? { vazio: false, n } : { vazio: true };
  }
  const s = String(v).trim();
  if (s === "") return { vazio: true };
  if (tipo === "data") return RE_DATA.test(s) ? { vazio: false, t: s.slice(0, 10) } : { vazio: true };
  return { vazio: false, t: s };
}

/** Ordena uma cópia da lista; vazios no fim; estável. */
export function ordenarPor<T>(
  itens: readonly T[],
  valor: (t: T) => string | number | null | undefined,
  tipo: TipoOrdem,
  direcao: Direcao
): T[] {
  const sinal = direcao === "desc" ? -1 : 1;
  const pares = itens.map((item, i) => ({ item, i, v: normalizar(valor(item), tipo) }));
  pares.sort((a, b) => {
    if (a.v.vazio && b.v.vazio) return a.i - b.i;
    if (a.v.vazio) return 1;
    if (b.v.vazio) return -1;
    let c = 0;
    if (tipo === "numero") c = (a.v.n as number) - (b.v.n as number);
    else if (tipo === "data") c = (a.v.t as string) < (b.v.t as string) ? -1 : (a.v.t as string) > (b.v.t as string) ? 1 : 0;
    else c = (a.v.t as string).localeCompare(b.v.t as string, "pt", { sensitivity: "base", numeric: true });
    return c !== 0 ? c * sinal : a.i - b.i;
  });
  return pares.map((p) => p.item);
}

/** Clicar na mesma coluna inverte a direção; noutra coluna começa em ascendente. */
export function alternarOrdem(atual: Ordem, chave: string): Ordem {
  if (atual.chave === chave) return { chave, direcao: atual.direcao === "asc" ? "desc" : "asc" };
  return { chave, direcao: "asc" };
}

/**
 * Mantém as linhas na ordem congelada (ids) enquanto a pessoa edita: as que já estavam
 * ficam nas mesmas posições, as novas (não congeladas) vão para o fim, as que saíram caem.
 */
export function aplicarOrdemCongelada<T>(itens: readonly T[], congelada: readonly string[] | null, id: (t: T) => string): T[] {
  if (!congelada) return [...itens];
  const pos = new Map(congelada.map((k, i) => [k, i]));
  const noFim = congelada.length;
  return itens
    .map((item, i) => ({ item, i, p: pos.has(id(item)) ? (pos.get(id(item)) as number) : noFim }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.item);
}

interface ArmazemOrdem {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Lê a preferência; só aceita chaves conhecidas (qualquer outra coisa = omissão). */
export function lerOrdem(armazem: ArmazemOrdem, chavesValidas: readonly string[]): Ordem {
  try {
    const o = JSON.parse(armazem.getItem(CHAVE_ORDEM_ARMAZEM) ?? "null");
    if (o && typeof o.chave === "string" && chavesValidas.includes(o.chave) && (o.direcao === "asc" || o.direcao === "desc")) {
      return { chave: o.chave, direcao: o.direcao };
    }
  } catch {
    // ignora
  }
  return ORDEM_OMISSAO;
}

export function guardarOrdem(armazem: ArmazemOrdem, o: Ordem): void {
  try {
    armazem.setItem(CHAVE_ORDEM_ARMAZEM, JSON.stringify(o));
  } catch {
    // quota / modo privado
  }
}
