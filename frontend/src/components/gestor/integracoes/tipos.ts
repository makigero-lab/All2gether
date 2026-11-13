/** Tipos e ajudas da área Integrações do gestor (respostas de /api/gestor/integracoes/resumo e afins). */

export type EstadoCelula = "ativa" | "erro" | "pausada" | "suspensa";
export type EstadoLinha = "ok" | "erro" | "por_aceitar" | "pausada" | "sem_ligacao";

export interface CelulaCanal {
  fonte_id: string;
  canal: "airbnb" | "booking" | "vrbo" | "outro";
  canal_texto: string;
  estado: EstadoCelula;
  motivo_estado: string | null;
  estado_texto: string | null;
  url_mascara: string | null;
  ultima_leitura_em: string | null;
  ultimo_sucesso_em: string | null;
  em_validacao: boolean;
  aviso_validacao: string | null;
  erro: { codigo: string; mensagem: string; em: string | null } | null;
}

export interface CasaResumo {
  _id: string;
  nome: string;
  ativo: boolean;
  smoobu: boolean;
  por_confirmar: number;
  airbnb: CelulaCanal | null;
  booking: CelulaCanal | null;
  outros: CelulaCanal[];
}

export interface ProprietarioResumo {
  _id: string;
  nome: string;
  email: string;
  ativo: boolean;
  acordo: "nao_exigido" | "aceite" | "por_aceitar";
  estado: EstadoLinha;
  n_erros: number;
  n_ligadas: number;
  n_ligacoes: number;
  n_por_confirmar: number;
  ultima_leitura_em: string | null;
  primeiro_erro: { casa: string; canal: string; fonte_id: string; codigo?: string; mensagem: string; em: string | null } | null;
  casas: CasaResumo[];
}

export interface ResumoIntegracoes {
  proprietarios: ProprietarioResumo[];
  totais: { erros: number; por_confirmar: number; sem_ligacao: number; em_pausa: number; por_aceitar: number };
  ligado: boolean;
  modo_teste: boolean;
  acordo_obrigatorio: boolean;
}

export type Filtro = "todos" | "erro" | "por_confirmar" | "sem_ligacao" | "pausada";

/** Aplica o filtro de uma linha (função pura, testável). */
export function passaFiltro(p: ProprietarioResumo, f: Filtro): boolean {
  switch (f) {
    case "erro": return p.n_erros > 0;
    case "por_confirmar": return p.n_por_confirmar > 0;
    case "sem_ligacao": return p.estado === "sem_ligacao";
    case "pausada": return p.estado === "pausada" || p.estado === "por_aceitar";
    default: return true;
  }
}

/** Linhas com erro primeiro; a ordem alfabética (já vinda do servidor) mantém-se dentro de cada grupo. */
export function ordenarLinhas(l: ProprietarioResumo[]): ProprietarioResumo[] {
  return [...l].sort((a, b) => Number(b.n_erros > 0) - Number(a.n_erros > 0));
}

/** Canal que o link parece ser, pelo domínio (sugere trocar em vez de recusar). */
export function canalDoLink(texto: string): "airbnb" | "booking" | "outro" | null {
  const t = texto.trim().toLowerCase();
  if (!t) return null;
  if (/^https?:\/\/([a-z0-9-]+\.)*airbnb\.[a-z.]+\//.test(t)) return "airbnb";
  if (/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//.test(t)) return "booking";
  return /^https?:\/\//.test(t) ? "outro" : null;
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** «14 nov» a partir de 2026-11-14. */
export function diaMes(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1] ?? ""}`;
}

/** «há 20 min», «há 3 h», «há 2 dias». */
export function haQuanto(iso: string | null): string {
  if (!iso) return "ainda não";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}

export function msgErro(e: unknown, omissao: string): string {
  const m = (e as { message?: string })?.message;
  return m && m.length < 300 ? m : omissao;
}
