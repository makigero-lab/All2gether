/**
 * Pesquisa nas listas do gestor (propriedades, proprietários): filtra no
 * cliente, insensível a maiúsculas e acentos. Todas as palavras escritas têm
 * de aparecer (em qualquer ordem) em algum dos campos.
 */

/** Minúsculas, sem acentos e com espaços normalizados. */
export function normalizarTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** true se a pesquisa estiver vazia ou todas as palavras existirem nos campos. */
export function correspondePesquisa(pesquisa: string, campos: unknown[]): boolean {
  const palavras = normalizarTexto(pesquisa).split(" ").filter(Boolean);
  if (palavras.length === 0) return true;
  const palheiro = campos.map(normalizarTexto).join(" | ");
  return palavras.every((p) => palheiro.includes(p));
}
