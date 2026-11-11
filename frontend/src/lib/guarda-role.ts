/**
 * Decisão do RouteGuard quando o role que o /me devolve (BD) não bate com a área aberta.
 *
 * O middleware decide pelo role do JWT; o guard, pelo da BD. Se o role mudou na BD e o JWT
 * ainda é o antigo, mandar para o painel "certo" faz o middleware devolver ao sítio de onde
 * veio, em ciclo. Se já fomos mandados para o mesmo destino há pouco, o ciclo está a
 * acontecer: o token está desatualizado e só um logout limpo resolve.
 */

export const CHAVE_REDIRECIONAMENTO = "a2g_guard_redir";
/** Janela em que um segundo redirecionamento para o mesmo destino conta como ciclo. */
export const JANELA_CICLO_MS = 20_000;

export interface MarcaRedirecionamento {
  para: string;
  ts: number;
}

export type DecisaoRoleErrado = "redirecionar" | "logout";

/** `marca` = o que ficou guardado do último redirecionamento (ou null). */
export function decidirRoleErrado(destino: string, marca: MarcaRedirecionamento | null, agora: number = Date.now()): DecisaoRoleErrado {
  if (marca && marca.para === destino && agora - marca.ts >= 0 && agora - marca.ts <= JANELA_CICLO_MS) return "logout";
  return "redirecionar";
}

export function lerMarca(armazem: Pick<Storage, "getItem"> | null): MarcaRedirecionamento | null {
  try {
    const bruto = armazem?.getItem(CHAVE_REDIRECIONAMENTO);
    if (!bruto) return null;
    const m = JSON.parse(bruto);
    return typeof m?.para === "string" && typeof m?.ts === "number" ? { para: m.para, ts: m.ts } : null;
  } catch {
    return null;
  }
}
