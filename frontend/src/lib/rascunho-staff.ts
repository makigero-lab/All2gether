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
const PREFIXO = PREFIXO_RASCUNHO;

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

export function lerRascunho(tarefaId: string, nItens: number): RascunhoConclusao | null {
  try {
    const bruto = localStorage.getItem(PREFIXO + tarefaId);
    if (!bruto) return null;
    const r = JSON.parse(bruto);
    if (typeof r?.observacoes !== "string" || !Array.isArray(r?.itens)) return null;
    const itens = Array.from({ length: nItens }, (_, i) => r.itens[i] === true);
    return { observacoes: r.observacoes.slice(0, 2000), itens };
  } catch {
    return null;
  }
}

export function guardarRascunho(tarefaId: string, r: RascunhoConclusao): void {
  try {
    if (!r.observacoes && !r.itens.some(Boolean)) {
      localStorage.removeItem(PREFIXO + tarefaId);
      return;
    }
    localStorage.setItem(PREFIXO + tarefaId, JSON.stringify(r));
  } catch {
    // quota/modo privado: ignora
  }
}

export function limparRascunho(tarefaId: string): void {
  try {
    localStorage.removeItem(PREFIXO + tarefaId);
  } catch {
    // ignora
  }
}

/** Rascunho do texto de uma avaria (nunca as fotos), por tarefa. */
export function lerRascunhoAvaria(tarefaId: string): string {
  try {
    const t = localStorage.getItem(PREFIXO + "avaria_" + tarefaId);
    return typeof t === "string" ? t.slice(0, 2000) : "";
  } catch {
    return "";
  }
}

export function guardarRascunhoAvaria(tarefaId: string, texto: string): void {
  try {
    if (!texto.trim()) localStorage.removeItem(PREFIXO + "avaria_" + tarefaId);
    else localStorage.setItem(PREFIXO + "avaria_" + tarefaId, texto.slice(0, 2000));
  } catch {
    // ignora
  }
}

/** Remove todos os rascunhos (usado no logout, para não ficarem em aparelho partilhado). */
export function limparTodosRascunhos(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIXO)) localStorage.removeItem(k);
    }
  } catch {
    // ignora
  }
}
