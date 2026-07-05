/**
 * Dados fictícios (Mock Data) — Autocell Frontend
 *
 * NOTA: ainda sem ligação à API. Estes dados apenas servem para visualizar o
 * design, o layout e o comportamento responsivo.
 *
 * A estrutura espelha os modelos do backend (Mongoose) para facilitar a
 * integração futura:
 *   - Propriedade  (backend/models/Propriedade.js)
 *   - Utilizador   (backend/models/Utilizador.js)
 *   - Tarefa       (backend/models/Tarefa.js)
 */

export type EstadoTarefa =
  | "por_atribuir"
  | "atribuida"
  | "em_curso"
  | "concluida"
  | "cancelada";

export type TipoTarefa =
  | "limpeza"
  | "check_in"
  | "check_out"
  | "manutencao"
  | "outro";

export interface TarefaMock {
  id: string;
  propriedade_nome: string;
  /** Hora limite formatada (HHhMM) para apresentação. */
  hora_limite: string;
  /** Estimativa em minutos (espelha tempo_limpeza_minutos do backend). */
  tempo_estimado_minutos: number;
  estado: EstadoTarefa;
  tipo: TipoTarefa;
  /** Endereço curto para contexto (opcional). */
  endereco?: string;
  /**
   * Checklist de limpeza (passos a concluir pelo Staff no ecrã de detalhe).
   * Cada string é um item a marcar. Se vier vazio, é gerada uma checklist
   * por defeito no ecrã de detalhe.
   */
  checklist?: string[];
}

export interface MembroEquipaMock {
  id: string;
  nome: string;
  email: string;
  role: "admin" | "gestor" | "staff";
  ativo: boolean;
  /** Tarefas atribuídas hoje (para o dashboard). */
  tarefas_hoje: number;
  /** Minutos de carga acumulada hoje. */
  carga_minutos: number;
}

export interface PropriedadeMock {
  id: string;
  nome: string;
  smoobu_id: string;
  tempo_limpeza_minutos: number;
  ativo: boolean;
}

/* ------------------------------------------------------------------ */
/* Staff autenticado (simulado)                                        */
/* ------------------------------------------------------------------ */
export const staffAtual = {
  id: "u-001",
  nome: "João Silva",
  role: "staff" as const,
};

/* ------------------------------------------------------------------ */
/* Tarefas de limpeza do dia (rota /staff)                             */
/* ------------------------------------------------------------------ */
export const tarefasHoje: TarefaMock[] = [
  {
    id: "t-001",
    propriedade_nome: "Apartamento Maré Alta",
    hora_limite: "10h00",
    tempo_estimado_minutos: 75,
    estado: "atribuida",
    tipo: "limpeza",
    endereco: "Rua das Flores 12, Cascais",
    checklist: [
      "Trocar Lençóis",
      "Limpar WC",
      "Repor Café",
      "Verificar toalhas",
      "Lixar e varrer chão",
    ],
  },
  {
    id: "t-002",
    propriedade_nome: "Estúdio Solar de Alfama",
    hora_limite: "12h30",
    tempo_estimado_minutos: 45,
    estado: "atribuida",
    tipo: "check_out",
    endereco: "Beco do Carrasco 3, Lisboa",
    checklist: [
      "Trocar Lençóis",
      "Limpar WC",
      "Repor Café",
      "Recolher lixo",
    ],
  },
  {
    id: "t-003",
    propriedade_nome: "Casa da Serra",
    hora_limite: "15h00",
    tempo_estimado_minutos: 120,
    estado: "atribuida",
    tipo: "limpeza",
    endereco: "Estrada da Pena 45, Sintra",
    checklist: [
      "Trocar Lençóis",
      "Limpar WC",
      "Repor Café",
      "Limpar cozinha",
      "Lavar janelas",
      "Aspirar e limpar chão",
    ],
  },
  {
    id: "t-004",
    propriedade_nome: "Loja Tagus View",
    hora_limite: "17h30",
    tempo_estimado_minutos: 60,
    estado: "por_atribuir",
    tipo: "limpeza",
    endereco: "Cais do Sodré 8, Lisboa",
    checklist: [
      "Trocar Lençóis",
      "Limpar WC",
      "Repor Café",
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Membros da equipa (dashboard /admin)                                */
/* ------------------------------------------------------------------ */
export const equipa: MembroEquipaMock[] = [
  {
    id: "u-001",
    nome: "João Silva",
    email: "joao.silva@autocell.pt",
    role: "staff",
    ativo: true,
    tarefas_hoje: 3,
    carga_minutos: 240,
  },
  {
    id: "u-002",
    nome: "Maria Ferreira",
    email: "maria.ferreira@autocell.pt",
    role: "staff",
    ativo: true,
    tarefas_hoje: 2,
    carga_minutos: 165,
  },
  {
    id: "u-003",
    nome: "Pedro Costa",
    email: "pedro.costa@autocell.pt",
    role: "staff",
    ativo: false,
    tarefas_hoje: 0,
    carga_minutos: 0,
  },
  {
    id: "u-005",
    nome: "Responsável Limpezas",
    email: "manager@autocell.pt",
    role: "gestor",
    ativo: true,
    tarefas_hoje: 1,
    carga_minutos: 60,
  },
  {
    id: "u-004",
    nome: "Ana Ribeiro",
    email: "ana.ribeiro@autocell.pt",
    role: "admin",
    ativo: true,
    tarefas_hoje: 0,
    carga_minutos: 0,
  },
];

/* ------------------------------------------------------------------ */
/* Propriedades (dashboard /admin)                                     */
/* ------------------------------------------------------------------ */
export const propriedades: PropriedadeMock[] = [
  {
    id: "p-001",
    nome: "Apartamento Maré Alta",
    smoobu_id: "67890",
    tempo_limpeza_minutos: 75,
    ativo: true,
  },
  {
    id: "p-002",
    nome: "Estúdio Solar de Alfama",
    smoobu_id: "67891",
    tempo_limpeza_minutos: 45,
    ativo: true,
  },
  {
    id: "p-003",
    nome: "Casa da Serra",
    smoobu_id: "67892",
    tempo_limpeza_minutos: 120,
    ativo: true,
  },
  {
    id: "p-004",
    nome: "Loja Tagus View",
    smoobu_id: "67893",
    tempo_limpeza_minutos: 60,
    ativo: true,
  },
];

/* ------------------------------------------------------------------ */
/* Resumo do dashboard (/admin)                                        */
/* ------------------------------------------------------------------ */
export const resumoDashboard = {
  totalPropriedades: propriedades.length,
  membrosEquipaAtivos: equipa.filter(
    (m) => m.ativo && (m.role === "staff" || m.role === "gestor")
  ).length,
  tarefasHoje: tarefasHoje.length,
  tarefasPorAtribuir: tarefasHoje.filter((t) => t.estado === "por_atribuir")
    .length,
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Checklist por defeito usada quando uma tarefa não traz checklist própria. */
export const checklistPorDefeito: string[] = [
  "Trocar Lençóis",
  "Limpar WC",
  "Repor Café",
];

/**
 * Procura uma tarefa por ID (no array de tarefas de hoje).
 * Devolve `null` se não existir.
 */
export function getTarefaPorId(id: string): TarefaMock | null {
  return tarefasHoje.find((t) => t.id === id) ?? null;
}
