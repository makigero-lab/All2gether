/**
 * Estados da tarefa: UMA SÓ fonte de verdade para rótulo, variante de Badge e
 * significado. As cores vivem nos tokens `--status-*` (globals.css); aqui só se
 * liga cada estado ao seu token. Nunca codificar cores de estado à mão.
 *
 * Semântica (confirmada no backend):
 *  - por_atribuir  : ainda ninguém tem a tarefa. É a espera normal (reserva nova,
 *                    tarefa libertada por uma ausência, ninguém disponível nesse dia).
 *  - nao_atribuida : o sistema TENTOU atribuir e não coube em ninguém (toda a
 *                    equipa acima do limite diário). Exige ação do gestor.
 */
export type EstadoTarefa =
  | "por_atribuir"
  | "nao_atribuida"
  | "atribuida"
  | "em_curso"
  | "concluida"
  | "cancelada";

export type VarianteEstado =
  | "porAtribuir"
  | "naoAtribuida"
  | "atribuida"
  | "emCurso"
  | "concluida"
  | "cancelada";

export interface InfoEstado {
  label: string;
  variant: VarianteEstado;
  /** Frase curta para tooltip/ajuda. */
  descricao: string;
  /** Nome do token (para cores fora de Badge, p. ex. gráficos): `hsl(var(--status-<token>))`. */
  token: "porat" | "naoat" | "atrib" | "curso" | "conc" | "canc";
}

export const ESTADOS_TAREFA: Record<EstadoTarefa, InfoEstado> = {
  por_atribuir: {
    label: "Por atribuir",
    variant: "porAtribuir",
    descricao: "Ainda não tem ninguém atribuído.",
    token: "porat",
  },
  nao_atribuida: {
    label: "Não atribuída",
    variant: "naoAtribuida",
    descricao: "Tentou-se atribuir e não coube em ninguém da equipa: atribuir à mão.",
    token: "naoat",
  },
  atribuida: {
    label: "Atribuída",
    variant: "atribuida",
    descricao: "Tem responsável e ainda não começou.",
    token: "atrib",
  },
  em_curso: {
    label: "Em curso",
    variant: "emCurso",
    descricao: "A limpeza já começou.",
    token: "curso",
  },
  concluida: {
    label: "Concluída",
    variant: "concluida",
    descricao: "Terminada.",
    token: "conc",
  },
  cancelada: {
    label: "Cancelada",
    variant: "cancelada",
    descricao: "Reserva ou tarefa cancelada.",
    token: "canc",
  },
};

/** Info do estado, ou um fallback neutro para valores desconhecidos. */
export function infoEstadoTarefa(estado: string | null | undefined): InfoEstado {
  return (
    (estado && (ESTADOS_TAREFA as Record<string, InfoEstado>)[estado]) || {
      label: estado || "—",
      variant: "cancelada",
      descricao: "",
      token: "canc",
    }
  );
}

/** Cor (CSS) do token de estado, para gráficos e FullCalendar. */
export function corEstadoTarefa(estado: string | null | undefined, fundo = false): string {
  const t = infoEstadoTarefa(estado).token;
  return `hsl(var(--status-${t}${fundo ? "-bg" : ""}))`;
}
