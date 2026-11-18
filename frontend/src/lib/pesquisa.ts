/**
 * Pesquisa nas listas do gestor (propriedades, proprietários): filtra no
 * cliente, insensível a maiúsculas e acentos. Todas as palavras escritas têm
 * de aparecer (em qualquer ordem) em algum dos campos. As abreviaturas de
 * arruamentos são expandidas dos dois lados («avenida» encontra «Av.»).
 */

const ABREVIATURAS: [RegExp, string][] = [
  [/(^|[\s,(])Av(?:ª|\.)?(?=\s)/gi, "Avenida"],
  [/(^|[\s,(])R\.(?=\s)/gi, "Rua"],
  [/(^|[\s,(])P(?:ç|c)a?\.(?=\s)/gi, "Praça"],
  [/(^|[\s,(])Lg\.(?=\s)/gi, "Largo"],
  [/(^|[\s,(])Tv\.(?=\s)/gi, "Travessa"],
  [/(^|[\s,(])Trav\.(?=\s)/gi, "Travessa"],
  [/(^|[\s,(])Estr\.(?=\s)/gi, "Estrada"],
  [/(^|[\s,(])Al\.(?=\s)/gi, "Alameda"],
  [/(^|[\s,(])Calç\.(?=\s)/gi, "Calçada"],
  [/(^|[\s,(])Bc\.(?=\s)/gi, "Beco"],
];

/** Expande abreviaturas comuns de arruamentos («Av. X» → «Avenida X»). */
export function expandirAbreviaturas(texto: string): string {
  let t = `${texto} `;
  for (const [re, plena] of ABREVIATURAS) t = t.replace(re, (_m, pre: string) => `${pre}${plena}`);
  return t.trimEnd();
}

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

/** Normaliza depois de expandir abreviaturas (para comparar os dois lados). */
function paraComparar(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return normalizarTexto(expandirAbreviaturas(String(valor)));
}

/** true se a pesquisa estiver vazia ou todas as palavras existirem nos campos. */
export function correspondePesquisa(pesquisa: string, campos: unknown[]): boolean {
  // Na pesquisa só se expande o que tem ponto («av.»): «av» a meio de «Avelar» continua a servir.
  // Nos campos das casas expande-se sempre («Av. dos…» encontra «avenida»).
  const consulta = String(pesquisa ?? "").includes(".") ? paraComparar(pesquisa) : normalizarTexto(pesquisa);
  const palavras = consulta.split(" ").filter(Boolean);
  if (palavras.length === 0) return true;
  const palheiro = campos.map(paraComparar).join(" | ");
  return palavras.every((p) => palheiro.includes(p));
}
