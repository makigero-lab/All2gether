/**
 * Configuração e helpers para chamadas à API backend (All2gether).
 *
 * v1.14.0 — Arquitetura com cookie httpOnly + proxy:
 *   As chamadas à API admin vão para SAME-ORIGIN (/api/gestor/...), não
 *   diretamente para o backend. O catch-all proxy em
 *   app/api/gestor/[...path]/route.ts lê o token do cookie httpOnly e
 *   injeta o header Authorization ao encaminhar para o backend.
 *
 *   Isto significa que o browser NUNCA tem acesso ao token JWT — ele
 *   vive exclusivamente no cookie httpOnly, e apenas o servidor Next.js
 *   o lê para adicionar o header.
 */

/* ------------------------------------------------------------------ */
/* Helpers de fetch admin (same-origin via proxy)                     */
/* ------------------------------------------------------------------ */

/**
 * Faz um GET a um endpoint admin (via proxy same-origin).
 * O token é injetado automaticamente pelo proxy no servidor.
 */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
  });
  return handleResponse<T>(res);
}

/**
 * Faz um POST a um endpoint admin com JSON no corpo.
 */
export async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    cache: "no-store",
  });
  return handleResponse<T>(res);
}

/**
 * Faz um PUT a um endpoint admin com JSON no corpo.
 */
export async function adminPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    cache: "no-store",
  });
  return handleResponse<T>(res);
}

/**
 * Faz um PATCH a um endpoint admin com JSON no corpo.
 */
export async function adminPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
    cache: "no-store",
  });
  return handleResponse<T>(res);
}

/**
 * Faz um DELETE a um endpoint admin.
 */
export async function adminDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
  });
  return handleResponse<T>(res);
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let mensagem = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.erro) mensagem = data.erro;
    } catch {
      /* corpo não-JSON, manter mensagem padrão */
    }
    throw new Error(mensagem);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Tipos que espelham os modelos do backend                            */
/* ------------------------------------------------------------------ */

export type Role = "admin" | "gestor" | "staff" | "parceiro";

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
  hora_limite: string;
  tempo_estimado_minutos: number;
  estado: EstadoTarefa;
  tipo: TipoTarefa;
  endereco?: string;
  checklist?: string[];
  // v1.56.0 (Prompt 78) — data ISO real da tarefa (para extrair hora de início).
  data?: string;
  // Prompt 95 (Fase 1.5) — Detalhes da reserva Smoobu (para card de destaque).
  detalhes_reserva?: DetalhesReservaDTO | null;
  // Prompt 114 — Lotação máxima da propriedade (para destaque no detalhe).
  capacidade_hospedes?: number | null;
  // Prompt 126 — Observações/notes internas da propriedade (ex.: regras de acesso).
  observacoes_propriedade?: string | null;
  // Prompt 133 — Checklist dinâmica (snapshot do ModeloChecklist associado à
  // propriedade no momento da criação da tarefa). Quando existe, o detalhe do
  // staff renderiza secções + items em vez da checklist flat (array de strings).
  checklist_dinamica?: Array<{
    nome: string;
    items: Array<{ texto: string; concluido: boolean }>;
  }>;
  // Prompt 138 (136 V2) — Tempo de viagem (em minutos) entre a tarefa
  // anterior do staff e esta. Guardado pelo scheduler para o frontend
  // poder desenhar rotas e mostrar o itinerário.
  tempo_viagem_minutos?: number | null;
}

/**
 * Prompt 133 — Modelo de Checklist (template gerido pelo gestor).
 * Cada modelo pertence a uma empresa e tem secções com items.
 */
export interface ModeloChecklistDTO {
  _id: string;
  empresa_id: string;
  nome: string;
  descricao?: string;
  seccoes: Array<{
    nome: string;
    items: string[];
  }>;
  createdAt?: string;
  updatedAt?: string;
}

/** Prompt 95 — Detalhes da reserva Smoobu associada a uma tarefa. */
export interface DetalhesReservaDTO {
  checkin?: string | null;
  checkout?: string | null;
  pax?: number | null;
  nome_hospede?: string | null;
}

export interface PropriedadeDTO {
  _id: string;
  smoobu_id: string;
  nome: string;
  morada?: string;
  coordenadas?: { lat: number | null; lng: number | null };
  empresa_id: string;
  tempo_limpeza_minutos: number;
  ativo: boolean;
  checklist?: string[];
  // v1.61.0 (Prompt 84) — Capacidade máxima de hóspedes (do Smoobu).
  capacidade_hospedes?: number | null;
  // Prompt 92 (Fase 1.5) — Funcionário preferencial (Algoritmo VIP).
  funcionario_preferencial_id?: string | null;
  // Prompt 133 — Referência ao ModeloChecklist (template dinâmico).
  modelo_checklist_id?: string | null;
  // HF21 — Nº de staff necessário para limpar esta propriedade.
  staff_necessario?: number;
  // HF22 — Dias fixos de limpeza (0=Dom, 1=Seg, ..., 6=Sáb).
  dias_fixos_limpeza?: number[];
  // HF23 — Campos de gestão da propriedade.
  nome_responsavel?: string;
  contato?: string;
  frequencia_limpeza?: "semanal" | "quinzenal" | "mensal";
  horario_limpeza?: string;
  // FIX (parceiro associado) — Observações livres da propriedade (notas
  // internas do gestor). A lógica legacy de "Parceiro Associado: [nome]"
  // foi substituída por parceiro_id (relacional), mas o campo mantém-se
  // para notas livres gerais.
  observacoes?: string;
  // FIX (parceiro associado relacional) — ID do parceiro B2B associado.
  // Populado pelo backend com { _id, nome, email, role } para o frontend
  // mostrar no Badge sem extrair das observações.
  parceiro_id?: string | { _id: string; nome: string; email: string; role: string } | null;
  // FIX (morada estruturada) — Morada decomposta (rua, codigo_postal, cidade).
  // Retrocompatível: se vazio, o frontend faz fallback para `morada` (string única).
  morada_estruturada?: {
    rua: string;
    codigo_postal: string;
    cidade: string;
  };
  // FIX (morada estruturada) — Virtual do backend: morada completa concatenada.
  // Pode não estar presente se o backend não enviar virtuals (mas toJSON está configurado).
  moradaCompleta?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UtilizadorDTO {
  _id: string;
  nome: string;
  email: string;
  empresa_id: string;
  role: Role;
  responsavel_id: string | null;
  responsavel?: {
    _id: string;
    nome: string;
    email: string;
    role: Role;
  } | null;
  ativo: boolean;
  dias_folga?: number[];
  // HF10 — Folgas rotativas: datas específicas (além das fixas semanais).
  // Cada entrada é { data: string|Date, motivo: string }.
  // O webhook Smoobu verifica se o staff exclusivo tem folga rotativa no
  // dia do check-out e cria a tarefa com alerta se sim.
  folgas_rotativas?: {
    _id?: string;
    data: string | Date;
    motivo: string;
  }[];
  telefone?: string;
  // FIX (gestão de parceiros) — NIF e observações livres do utilizador.
  nif?: string;
  observacoes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type TipoAusencia = "ferias" | "folga";

export interface AusenciaDTO {
  _id: string;
  utilizador_id: string;
  utilizador?: {
    _id: string;
    nome: string;
    email: string;
    role: Role;
  } | null;
  empresa_id: string;
  data_inicio: string;
  data_fim: string;
  tipo: TipoAusencia;
  notas?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Resposta do POST /api/auth/login (via proxy — sem token, só utilizador) */
export interface LoginResponse {
  utilizador: {
    id: string;
    nome: string;
    email: string;
    role: Role;
    empresa_id: string;
  };
}
