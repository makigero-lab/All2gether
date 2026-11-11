/**
 * Utilitários do ecrã do staff para funcionar com rede instável:
 *  - traduzirErroRede: devolve mensagem pt-PT quando o erro é de rede.
 *  - rascunho da conclusão (notas + marcas da checklist flat) em localStorage.
 *
 * RGPD: o rascunho NUNCA guarda fotos nem dados do hóspede; apenas texto
 * livre das notas do próprio staff e booleanos da checklist.
 */

export const MSG_SEM_LIGACAO = "Sem ligação. Os dados continuam aqui, tenta outra vez.";

export const PREFIXO_RASCUNHO = "a2g_rascunho_tarefa_";
/** Chaves do staff (por empresa e utilizador): `a2g_rascunho_tarefa_v2_<empresa>_<utilizador>_<tarefa>`. */
const PREFIXO_V2 = PREFIXO_RASCUNHO + "v2_";
/** Chaves do rascunho do parceiro (rascunho-reservas.ts): têm a sua própria validade. */
const PREFIXO_RESERVAS = PREFIXO_RASCUNHO + "reservas_";

/** Validade do rascunho do staff: 7 dias desde a última alteração (igual ao do parceiro). */
export const VALIDADE_RASCUNHO_STAFF_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArmazemCompleto {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** O localStorage, ou null se não houver/estiver bloqueado. */
function armazemLocal(): ArmazemCompleto | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Dono do rascunho (empresa + utilizador); sem ele não se guarda nem lê nada. */
export function donoRascunho(u: { id?: string; empresa_id?: string } | null | undefined): string {
  return u?.id && u?.empresa_id ? `${u.empresa_id}_${u.id}` : "";
}

const chaveTarefa = (dono: string, tarefaId: string) => `${PREFIXO_V2}${dono}_${tarefaId}`;
const chaveAvaria = (dono: string, tarefaId: string) => `${PREFIXO_V2}${dono}_avaria_${tarefaId}`;

/** Lê o JSON guardado; apaga e devolve null se for ilegível, sem data ou expirado. */
function lerComPrazo(chave: string, armazem: ArmazemCompleto, agora: number): Record<string, unknown> | null {
  try {
    const bruto = armazem.getItem(chave);
    if (!bruto) return null;
    const r = JSON.parse(bruto);
    if (!r || typeof r !== "object" || typeof r.guardado_em !== "number" || agora - r.guardado_em > VALIDADE_RASCUNHO_STAFF_MS) {
      try { armazem.removeItem(chave); } catch { /* ignora */ }
      return null;
    }
    return r as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True se o erro parece falha de rede (fetch rejeitado / offline). */
export function eErroDeRede(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true; // fetch: "Failed to fetch", "Load failed", "NetworkError..."
  const msg = e instanceof Error ? e.message : "";
  return /failed to fetch|load failed|networkerror|network request failed/i.test(msg);
}

/** Mensagem a mostrar: texto de rede traduzido, ou a mensagem do erro, ou o fallback. */
export function mensagemErro(e: unknown, fallback: string): string {
  if (eErroDeRede(e)) return MSG_SEM_LIGACAO;
  return e instanceof Error && e.message ? e.message : fallback;
}

export type RascunhoConclusao = { observacoes: string; itens: boolean[] };

export function lerRascunho(
  dono: string, tarefaId: string, nItens: number,
  armazem: ArmazemCompleto | null = armazemLocal(), agora: number = Date.now()
): RascunhoConclusao | null {
  if (!dono || !armazem) return null;
  const r = lerComPrazo(chaveTarefa(dono, tarefaId), armazem, agora);
  if (!r || typeof r.observacoes !== "string" || !Array.isArray(r.itens)) return null;
  const marcas = r.itens as unknown[];
  const itens = Array.from({ length: nItens }, (_, i) => marcas[i] === true);
  return { observacoes: r.observacoes.slice(0, 2000), itens };
}

/** Devolve false se não conseguiu guardar (quota, modo privado). */
export function guardarRascunho(
  dono: string, tarefaId: string, r: RascunhoConclusao,
  armazem: ArmazemCompleto | null = armazemLocal(), agora: number = Date.now()
): boolean {
  if (!dono || !armazem) return false;
  try {
    if (!r.observacoes && !r.itens.some(Boolean)) {
      armazem.removeItem(chaveTarefa(dono, tarefaId));
      return true;
    }
    armazem.setItem(chaveTarefa(dono, tarefaId), JSON.stringify({ ...r, guardado_em: agora }));
    return true;
  } catch {
    return false;
  }
}

export function limparRascunho(dono: string, tarefaId: string, armazem: ArmazemCompleto | null = armazemLocal()): void {
  if (!dono || !armazem) return;
  try {
    armazem.removeItem(chaveTarefa(dono, tarefaId));
  } catch {
    // ignora
  }
}

/** Rascunho do texto de uma avaria (nunca as fotos), por tarefa. */
export function lerRascunhoAvaria(
  dono: string, tarefaId: string,
  armazem: ArmazemCompleto | null = armazemLocal(), agora: number = Date.now()
): string {
  if (!dono || !armazem) return "";
  const r = lerComPrazo(chaveAvaria(dono, tarefaId), armazem, agora);
  return r && typeof r.texto === "string" ? r.texto.slice(0, 2000) : "";
}

export function guardarRascunhoAvaria(
  dono: string, tarefaId: string, texto: string,
  armazem: ArmazemCompleto | null = armazemLocal(), agora: number = Date.now()
): boolean {
  if (!dono || !armazem) return false;
  try {
    if (!texto.trim()) armazem.removeItem(chaveAvaria(dono, tarefaId));
    else armazem.setItem(chaveAvaria(dono, tarefaId), JSON.stringify({ texto: texto.slice(0, 2000), guardado_em: agora }));
    return true;
  } catch {
    return false;
  }
}

/** Quantos rascunhos há guardados neste aparelho (para avisar antes de sair). */
export function contarRascunhos(armazem: ArmazemCompleto | null = armazemLocal()): number {
  if (!armazem) return 0;
  try {
    let n = 0;
    for (let i = 0; i < armazem.length; i++) {
      const k = armazem.key(i);
      if (k && k.startsWith(PREFIXO_RASCUNHO)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Remove todos os rascunhos (usado no logout, para não ficarem em aparelho partilhado). */
export function limparTodosRascunhos(armazem: ArmazemCompleto | null = armazemLocal()): void {
  if (!armazem) return;
  try {
    for (let i = armazem.length - 1; i >= 0; i--) {
      const k = armazem.key(i);
      if (k && k.startsWith(PREFIXO_RASCUNHO)) armazem.removeItem(k);
    }
  } catch {
    // ignora
  }
}

/**
 * Limpeza ao abrir uma tarefa: apaga as chaves antigas do staff (sem utilizador, formato
 * anterior: ficam ignoradas e não se podem atribuir a ninguém) e as do formato novo que
 * já expiraram. Não toca nas do parceiro (`reservas_`).
 */
export function limparRascunhosObsoletos(armazem: ArmazemCompleto | null = armazemLocal(), agora: number = Date.now()): number {
  if (!armazem) return 0;
  let n = 0;
  try {
    for (let i = armazem.length - 1; i >= 0; i--) {
      const k = armazem.key(i);
      if (!k || !k.startsWith(PREFIXO_RASCUNHO) || k.startsWith(PREFIXO_RESERVAS)) continue;
      if (!k.startsWith(PREFIXO_V2)) {
        armazem.removeItem(k);
        n++;
      } else {
        lerComPrazo(k, armazem, agora); // apaga se expirou ou não tem data
        if (armazem.getItem(k) === null) n++;
      }
    }
  } catch {
    // ignora
  }
  return n;
}
