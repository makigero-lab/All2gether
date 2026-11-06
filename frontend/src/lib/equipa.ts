/** Texto "Equipa: Carla (resp.) + Tu" para o staff saber com quem trabalha. */
export interface MembroEquipa {
  _id: string;
  nome: string;
  responsavel: boolean;
  /** É a própria pessoa autenticada. */
  eu?: boolean;
}

/** Devolve "Carla (resp.) + Tu" ou null se a limpeza não tem equipa (menos de 2 pessoas). */
export function textoEquipa(membros?: MembroEquipa[] | null): string | null {
  if (!membros || membros.length < 2) return null;
  const partes = membros.map((m) => {
    const nome = m.eu ? "Tu" : m.nome.split(" ")[0] || m.nome;
    return m.responsavel ? `${nome} (resp.)` : nome;
  });
  return partes.join(" + ");
}

export interface MembroGestor {
  _id?: string;
  nome?: string | null;
}

/** Nomes dos membros (responsável primeiro, sem repetidos nem vazios). */
export function nomesEquipaGestor(resp?: MembroGestor | null, equipa?: MembroGestor[] | null): string[] {
  const vistos = new Set<string>();
  const nomes: string[] = [];
  for (const m of [resp, ...(equipa ?? [])]) {
    if (!m || !m.nome) continue;
    const chave = m._id ?? m.nome;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    nomes.push(m.nome);
  }
  return nomes;
}

/** "Ana (resp.) + Bruno" (primeiros nomes); só "Ana" se for uma pessoa; null se ninguém. */
export function textoEquipaGestor(resp?: MembroGestor | null, equipa?: MembroGestor[] | null): string | null {
  const nomes = nomesEquipaGestor(resp, equipa).map((n) => n.split(" ")[0] || n);
  if (nomes.length === 0) return null;
  if (nomes.length === 1) return nomes[0];
  return `${nomes[0]} (resp.) + ${nomes.slice(1).join(" + ")}`;
}

/** "Falta 1 pessoa" / "Faltam 2 pessoas" ou null. */
export function textoFalta(n?: number | null): string | null {
  const v = Number(n) || 0;
  if (v <= 0) return null;
  return v === 1 ? "Falta 1 pessoa" : `Faltam ${v} pessoas`;
}
