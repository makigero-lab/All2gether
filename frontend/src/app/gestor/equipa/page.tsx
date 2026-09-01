"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  Users,
  Loader2,
  AlertCircle,
  RefreshCw,
  Pencil,
  Trash2,
  Power,
  Phone,
  Siren,
  CalendarOff,
  Calendar,
  Search,
  // Ícones usados pela aba de Aprovações
  CalendarCheck,
  Check,
  X,
  CheckCircle2,
  User,
  Eye,
  EyeOff,
  Lock,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  adminGet,
  adminPost,
  adminPut,
  adminPatch,
  adminDelete,
  type UtilizadorDTO,
  type PropriedadeDTO,
  type Role,
} from "@/lib/api";
import { PaginationBar } from "@/components/admin/pagination-bar";
import { Switch } from "@/components/ui/switch";
import { formatarDataSegura, parsearDataSegura } from "@/lib/utils";

/**
 * Página de Equipa — Painel de Administração.
 *
 * Esta página agrega duas secções em Tabs do shadcn/ui:
 *  - "Lista de Staff": CRUD completo de membros (Admin, Responsável e Staff).
 *  - "Aprovações de Férias": pedidos de ausência pendentes (aprovar / rejeitar).
 *
 * A aba de Staff consome a API real (GET/POST/PUT/PATCH/DELETE /api/gestor/equipa)
 * com JWT no header Authorization (via helpers adminGet/adminPost/...).
 * A aba de Aprovações consome GET /api/gestor/ausencias?estado=pendente,...
 * e PATCH /api/gestor/ausencias/:id/estado.
 *
 * Como ambas as secções partilham o mesmo componente, todos os estados, funções
 * e handlers da aba de Aprovações estão prefixados com `apr_` para evitar
 * colisões com os da aba de Staff (ex.: `loading`, `erro`, `carregar`).
 */

/* ------------------------------------------------------------------ */
/* Constantes — Equipa                                                 */
/* ------------------------------------------------------------------ */

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  gestor: "Gestor",
  staff: "Staff",
  parceiro: "Parceiro",
};

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline"> = {
  admin: "default",
  gestor: "secondary",
  staff: "outline",
  parceiro: "outline",
};

const DIAS_SEMANA = [
  { valor: 0, label: "Dom" },
  { valor: 1, label: "Seg" },
  { valor: 2, label: "Ter" },
  { valor: 3, label: "Qua" },
  { valor: 4, label: "Qui" },
  { valor: 5, label: "Sex" },
  { valor: 6, label: "Sáb" },
];

/* ------------------------------------------------------------------ */
/* Constantes & tipos — Aprovações                                     */
/* ------------------------------------------------------------------ */

interface AusenciaDTO {
  _id: string;
  utilizador_id: string;
  utilizador: {
    _id: string;
    nome: string;
    email: string;
    role: Role;
  } | null;
  data_inicio: string;
  data_fim: string;
  tipo: string;
  estado: string;
  justificacao?: string;
  notas?: string;
  createdAt: string;
}

const TIPO_LABEL: Record<string, string> = {
  ferias: "Férias",
  doenca: "Doença",
  outro: "Outro",
};

const TIPO_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  ferias: "default",
  doenca: "secondary",
  outro: "outline",
};

/** Formata uma data ISO (yyyy-MM-dd) para "d MMM yyyy" em PT. */
function formatarData(iso: string): string {
  return formatarDataSegura(
    iso,
    (d) => format(d, "d MMM yyyy", { locale: pt }),
    iso
  );
}

/* ------------------------------------------------------------------ */
/* Sub-componente — Folgas Semanais                                    */
/* ------------------------------------------------------------------ */

/** Componente de checkboxes para Folgas Semanais Fixas (0=Dom a 6=Sáb). */
function FolgasSemanaisCheckboxes({
  diasFolga,
  onChange,
}: {
  diasFolga: number[];
  onChange: (dias: number[]) => void;
}) {
  function toggle(dia: number) {
    if (diasFolga.includes(dia)) {
      onChange(diasFolga.filter((d) => d !== dia));
    } else {
      onChange([...diasFolga, dia].sort((a, b) => a - b));
    }
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">
        Folgas Semanais Fixas{" "}
        <span className="font-normal text-muted-foreground">
          (dias de descanso habituais — o sistema ignora o staff nestes dias)
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        {DIAS_SEMANA.map((d) => {
          const checked = diasFolga.includes(d.valor);
          return (
            <button
              key={d.valor}
              type="button"
              onClick={() => toggle(d.valor)}
              className={`inline-flex h-9 min-w-[3rem] items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors ${
                checked
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function EquipaPageWrapper() {
  return (
    <Suspense fallback={null}>
      <EquipaPage />
    </Suspense>
  );
}

function EquipaPage() {
  // v1.68.0 (Prompt 91) — Permite abrir diretamente na tab de Aprovações
  // via ?tab=aprovacoes (usado pelo redirect /gestor/ausencias).
  const searchParams = useSearchParams();
  const tabInicial = searchParams.get("tab") === "aprovacoes" ? "aprovacoes" : "staff";

  // ===== Estado — Equipa (Staff) =====
  const [utilizadores, setUtilizadores] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // FIX (alocação bidirecional) — Lista de propriedades ativas da empresa
  // (para o multiselect de propriedades alocadas nos formulários). Carregada
  // em paralelo com os utilizadores no `carregar()`.
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  // FIX (pesquisa propriedades) — Termo de pesquisa para filtrar propriedades
  // no multiselect de "Propriedades Alocadas". Quando há muitas propriedades,
  // o gestor precisa de procurar pelo nome em vez de fazer scroll.
  const [pesquisaPropriedades, setPesquisaPropriedades] = useState("");

  // Paginação client-side.
  const [pagina, setPagina] = useState(1);
  const [tamPagina, setTamPagina] = useState(25);
  // Filtros (T1) — aplicados antes da paginação.
  // FIX (filtros default) — "Ativos" selecionado por defeito para reduzir
  // ruído visual (staff inativo só aparece se o gestor procurar explicitamente).
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "ativos" | "inativos">("ativos");
  const [filtroRole, setFiltroRole] = useState<"todos" | "staff" | "gestor" | "parceiro">("todos");
  const utilizadoresFiltrados = utilizadores.filter((u) => {
    if (filtroEstado === "ativos" && !u.ativo) return false;
    if (filtroEstado === "inativos" && u.ativo) return false;
    if (filtroRole !== "todos" && u.role !== filtroRole) return false;
    return true;
  });
  const totalPaginas = Math.max(1, Math.ceil(utilizadoresFiltrados.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const utilizadoresPagina = utilizadoresFiltrados.slice(
    (paginaSegura - 1) * tamPagina,
    paginaSegura * tamPagina
  );
  // Quando a lista muda (criar/eliminar/filtrar), reposiciona a página.
  useEffect(() => {
    if (pagina > totalPaginas) setPagina(totalPaginas);
  }, [pagina, totalPaginas]);

  // Formulário de criação
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form, setForm] = useState({
    nome: "",
    email: "",
    password: "",
    role: "staff" as Role,
    responsavel_id: "" as string,
    dias_folga: [] as number[],
    telefone: "",
    // FIX (alocação bidirecional) — Propriedades às quais este staff está
    // alocado (controlo geográfico). Array de IDs de Propriedade.
    propriedades_alocadas: [] as string[],
    // FIX (toggle exclusivo) — Se true, este staff SÓ é elegível para tarefas
    // de propriedades onde consta na equipa_preferencial.
    exclusivo_preferenciais: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);

  // Modal de edição
  const [editando, setEditando] = useState<UtilizadorDTO | null>(null);
  const [editForm, setEditForm] = useState({
    nome: "",
    email: "",
    role: "staff" as Role,
    password: "", // vazia = não alterar
    responsavel_id: "" as string,
    dias_folga: [] as number[],
    telefone: "",
    // HF10 — Folgas rotativas (datas específicas).
    folgas_rotativas: [] as { _id?: string; data: string; motivo: string }[],
    // FIX (alocação bidirecional) — Propriedades às quais este staff está
    // alocado (controlo geográfico). Array de IDs de Propriedade.
    propriedades_alocadas: [] as string[],
    // FIX (toggle exclusivo) — Se true, este staff SÓ é elegível para tarefas
    // de propriedades onde consta na equipa_preferencial.
    exclusivo_preferenciais: false,
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErro, setEditErro] = useState<string | null>(null);
  // HF10 — Estado do formulário de nova folga rotativa.
  const [novaFolga, setNovaFolga] = useState({ data: "", motivo: "" });
  // Toggle de visibilidade de password
  const [showFormPassword, setShowFormPassword] = useState(false);
  const [showEditPassword, setShowEditPassword] = useState(false);

  // Modal de confirmação de eliminação
  const [eliminando, setEliminando] = useState<UtilizadorDTO | null>(null);
  const [elimSubmitting, setElimSubmitting] = useState(false);

  // Modal de falta súbita
  const [faltaSubita, setFaltaSubita] = useState<UtilizadorDTO | null>(null);
  const [faltaSubmitting, setFaltaSubmitting] = useState(false);
  const [faltaResultado, setFaltaResultado] = useState<string | null>(null);

  // Modal de baixa prolongada
  const [baixaModal, setBaixaModal] = useState<UtilizadorDTO | null>(null);
  const [baixaForm, setBaixaForm] = useState({ data_inicio: "", data_fim: "" });
  const [baixaSubmitting, setBaixaSubmitting] = useState(false);
  const [baixaResultado, setBaixaResultado] = useState<string | null>(null);

  // Utilizadores que podem ser responsáveis (só gestor — admin não aparece).
  const responsaveisPossiveis = utilizadores.filter(
    (u) => u.role === "gestor"
  );

  // FIX (férias visíveis) — Mapa de utilizador_id -> tipo de ausência ativa
  // para hoje ('ferias' | 'doenca' | 'outro'). Usado para mostrar o badge
  // vermelho "De Férias" (ou "Doente"/"Ausente" consoante o tipo) na tabela
  // de staff. Antes era um Set<string> que não distinguia o tipo.
  const [ausentesHoje, setAusentesHoje] = useState<Record<string, string>>({});

  /** Carrega os utilizadores da API + ausências aprovadas para hoje. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const hoje = new Date();

      const [data, ausenciasRes, propriedadesRes] = await Promise.all([
        adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
        adminGet<{
          ausencias: {
            utilizador_id: string;
            data_inicio: string;
            data_fim: string;
            estado: string;
            tipo: string;
          }[];
        }>("/api/gestor/ausencias?estado=aprovada"),
        // FIX (alocação bidirecional) — Propriedades ativas para o multiselect
        // de propriedades alocadas no formulário de criação/edição.
        adminGet<{ propriedades: PropriedadeDTO[] }>(
          "/api/gestor/propriedades"
        ).catch(() => ({ propriedades: [] as PropriedadeDTO[] })),
      ]);
      setUtilizadores(data.utilizadores ?? []);
      setPropriedades(propriedadesRes.propriedades ?? []);

      // Filtra as ausências aprovadas que cobrem hoje e guarda o TIPO
      // (ferias/doenca/outro) para mostrar o badge correto.
      const hojeUTC = new Date(
        Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
      );
      const mapaAusentes: Record<string, string> = {};
      for (const a of ausenciasRes.ausencias ?? []) {
        const ini = parsearDataSegura(a.data_inicio);
        const fim = parsearDataSegura(a.data_fim);
        if (ini && fim && hojeUTC >= ini && hojeUTC <= fim && a.utilizador_id) {
          // Guarda o tipo da ausência (default 'ferias' se não vier na resposta).
          mapaAusentes[a.utilizador_id] = a.tipo || "ferias";
        }
      }
      setAusentesHoje(mapaAusentes);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar equipa.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // FIX (click-to-edit no calendário) — Lê ?editar=<userId> (vindo do
  // calendário / ausências) e abre automaticamente o modal de edição desse
  // funcionário assim que a equipa estiver carregada.
  const editarUserId = searchParams.get("editar");
  useEffect(() => {
    if (!editarUserId || utilizadores.length === 0) return;
    const alvo = utilizadores.find((u) => u._id === editarUserId);
    if (alvo) abrirEdicao(alvo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editarUserId, utilizadores]);

  /** Submete o formulário de novo membro. */
  async function handleSubmeter(e: React.FormEvent) {
    e.preventDefault();
    setFormErro(null);

    if (!form.nome.trim() || !form.email.trim() || !form.password) {
      setFormErro("Nome, Email e Password são obrigatórios.");
      return;
    }
    if (form.password.length < 6) {
      setFormErro("A password deve ter pelo menos 6 caracteres.");
      return;
    }

    setSubmitting(true);
    try {
      await adminPost("/api/gestor/equipa", {
        nome: form.nome.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        responsavel_id: form.responsavel_id || null,
        dias_folga: form.dias_folga,
        telefone: form.telefone,
        // FIX (alocação bidirecional) — Propriedades às quais este staff está
        // alocado (controlo geográfico).
        propriedades_alocadas: form.propriedades_alocadas,
        // FIX (toggle exclusivo) — Envia o estado do toggle de exclusividade.
        exclusivo_preferenciais: form.exclusivo_preferenciais,
      });
      setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "", propriedades_alocadas: [], exclusivo_preferenciais: false });
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar utilizador.");
    } finally {
      setSubmitting(false);
    }
  }

  /** Abre o modal de edição com os dados atuais do utilizador. */
  function abrirEdicao(u: UtilizadorDTO) {
    setEditando(u);
    // Normaliza folgas_rotativas: data pode vir como ISO string do backend.
    const folgas = (u.folgas_rotativas ?? []).map((fr) => ({
      _id: fr._id,
      // Converte para YYYY-MM-DD (formato do input type="date").
      data:
        typeof fr.data === "string"
          ? fr.data.slice(0, 10)
          : new Date(fr.data).toISOString().slice(0, 10),
      motivo: fr.motivo ?? "",
    }));
    setEditForm({
      nome: u.nome,
      email: u.email,
      role: u.role,
      password: "",
      responsavel_id: u.responsavel_id ?? "",
      dias_folga: u.dias_folga ?? [],
      telefone: u.telefone ?? "",
      folgas_rotativas: folgas,
      // FIX (alocação bidirecional) — Array de IDs de propriedades às quais
      // o staff está alocado (controlo geográfico).
      propriedades_alocadas: Array.isArray(u.propriedades_alocadas)
        ? [...u.propriedades_alocadas]
        : [],
      // FIX (toggle exclusivo) — Carrega o estado de exclusividade do staff.
      exclusivo_preferenciais: Boolean(u.exclusivo_preferenciais),
    });
    setNovaFolga({ data: "", motivo: "" });
    setEditErro(null);
  }

  /** HF10 — Adiciona uma folga rotativa ao editForm (local, sem guardar na BD). */
  function adicionarFolgaRotativa() {
    if (!novaFolga.data) {
      setEditErro("Seleciona uma data para a folga rotativa.");
      return;
    }
    // Evita duplicados (mesma data).
    const jaExiste = editForm.folgas_rotativas.some(
      (f) => f.data === novaFolga.data
    );
    if (jaExiste) {
      setEditErro("Já existe uma folga rotativa nessa data.");
      return;
    }
    setEditForm((f) => ({
      ...f,
      folgas_rotativas: [
        ...f.folgas_rotativas,
        { data: novaFolga.data, motivo: novaFolga.motivo.trim() },
      ].sort((a, b) => a.data.localeCompare(b.data)),
    }));
    setNovaFolga({ data: "", motivo: "" });
    setEditErro(null);
  }

  /** HF10 — Remove uma folga rotativa do editForm (local, sem guardar na BD). */
  function removerFolgaRotativa(data: string) {
    setEditForm((f) => ({
      ...f,
      folgas_rotativas: f.folgas_rotativas.filter((f2) => f2.data !== data),
    }));
  }

  /** Submete a edição (PUT). Password só é enviada se preenchida. */
  async function handleEditar(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    setEditErro(null);

    if (!editForm.nome.trim() || !editForm.email.trim()) {
      setEditErro("Nome e Email são obrigatórios.");
      return;
    }
    if (editForm.password && editForm.password.length < 6) {
      setEditErro("A nova password deve ter pelo menos 6 caracteres.");
      return;
    }

    setEditSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        nome: editForm.nome.trim(),
        email: editForm.email.trim(),
        role: editForm.role,
        responsavel_id: editForm.responsavel_id || null,
        dias_folga: editForm.dias_folga,
        telefone: editForm.telefone,
        // HF10 — Envia o array completo de folgas rotativas (substituição total).
        folgas_rotativas: editForm.folgas_rotativas.map((fr) => ({
          data: fr.data,
          motivo: fr.motivo,
        })),
        // FIX (alocação bidirecional) — Propriedades às quais este staff está
        // alocado (controlo geográfico). Envia sempre o array (vazio = sem
        // alocações) para o backend poder remover alocações desmarcadas.
        propriedades_alocadas: editForm.propriedades_alocadas,
        // FIX (toggle exclusivo) — Envia o estado do toggle de exclusividade.
        exclusivo_preferenciais: editForm.exclusivo_preferenciais,
      };
      if (editForm.password) body.password = editForm.password;

      await adminPut(`/api/gestor/equipa/${editando._id}`, body);
      setEditando(null);
      await carregar();
    } catch (e) {
      setEditErro(e instanceof Error ? e.message : "Erro ao atualizar.");
    } finally {
      setEditSubmitting(false);
    }
  }

  /** Alterna ativo/desativo (PATCH). */
  async function handleToggleAtivo(u: UtilizadorDTO) {
    // Otimismo: atualiza UI imediatamente; reverte se falhar.
    setUtilizadores((prev) =>
      prev.map((x) => (x._id === u._id ? { ...x, ativo: !x.ativo } : x))
    );
    try {
      await adminPatch(`/api/gestor/equipa/${u._id}/estado`);
    } catch (e) {
      // Reverte em caso de erro.
      setUtilizadores((prev) =>
        prev.map((x) => (x._id === u._id ? { ...x, ativo: u.ativo } : x))
      );
      setErro(e instanceof Error ? e.message : "Erro ao alterar estado.");
    }
  }

  /** Elimina utilizador (DELETE) com confirmação. */
  async function handleEliminar() {
    if (!eliminando) return;
    setElimSubmitting(true);
    try {
      await adminDelete(`/api/gestor/equipa/${eliminando._id}`);
      setEliminando(null);
      await carregar();
    } catch (e) {
      setEditErro(e instanceof Error ? e.message : "Erro ao eliminar.");
    } finally {
      setElimSubmitting(false);
    }
  }

  /** Reporta falta súbita (POST) e mostra resultado. */
  async function handleFaltaSubita() {
    if (!faltaSubita) return;
    setFaltaSubmitting(true);
    setFaltaResultado(null);
    try {
      const res = await adminPost<{ reatribuidas: number; orfas: number; total: number }>(
        `/api/gestor/equipa/${faltaSubita._id}/falta-subita`,
        {}
      );
      setFaltaResultado(
        `${res.reatribuidas} tarefa(s) reatribuída(s) aos colegas, ${res.orfas} tarefa(s) ficou(aram) por atribuir.`
      );
      await carregar();
    } catch (e) {
      setFaltaResultado(
        e instanceof Error ? e.message : "Erro ao processar falta súbita."
      );
    } finally {
      setFaltaSubmitting(false);
    }
  }

  // ===== Estado — Aprovações (prefix apr_) =====
  const [aprPendentes, setAprPendentes] = useState<AusenciaDTO[]>([]);
  const [aprLoading, setAprLoading] = useState(true);
  const [aprErro, setAprErro] = useState<string | null>(null);
  const [aprToast, setAprToast] = useState<{
    tipo: "sucesso" | "erro";
    msg: string;
  } | null>(null);
  const [aprProcessando, setAprProcessando] = useState<string | null>(null);
  // v1.62.0 (Prompt 85) — Alvo do dialog de eliminação de ausência.
  const [aprEliminarAlvo, setAprEliminarAlvo] = useState<AusenciaDTO | null>(null);

  /** Carrega as ausências pendentes da empresa. */
  const aprCarregar = useCallback(async () => {
    setAprLoading(true);
    setAprErro(null);
    try {
      const res = await adminGet<{ ausencias: AusenciaDTO[] }>(
        "/api/gestor/ausencias?estado=pendente,pendente_emergencia"
      );
      setAprPendentes(res.ausencias ?? []);
    } catch (e) {
      setAprErro(e instanceof Error ? e.message : "Erro ao carregar pedidos.");
    } finally {
      setAprLoading(false);
    }
  }, []);

  useEffect(() => {
    aprCarregar();
  }, [aprCarregar]);

  /** Aprova um pedido e mostra toast com o resultado da redistribuição. */
  async function aprAprovar(a: AusenciaDTO) {
    setAprProcessando(`aprovar-${a._id}`);
    setAprErro(null);
    try {
      const res = await adminPatch<{
        mensagem: string;
        redistribuicao: { total: number; reatribuidas: number; orfas: number } | null;
      }>(`/api/gestor/ausencias/${a._id}/estado`, { estado: "aprovada" });

      const r = res.redistribuicao;
      const msg =
        r && r.total > 0
          ? `Férias aprovadas. As tarefas deste funcionário foram redistribuídas com sucesso! (${r.reatribuidas} reatribuída(s)${r.orfas > 0 ? `, ${r.orfas} órfã(s)` : ""})`
          : "Férias aprovadas. Sem tarefas para redistribuir no período.";
      setAprToast({ tipo: "sucesso", msg });

      // Remove da lista de pendentes (já foi decidido).
      setAprPendentes((prev) => prev.filter((p) => p._id !== a._id));
    } catch (e) {
      setAprToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro ao aprovar: ${e.message}` : "Erro ao aprovar pedido.",
      });
    } finally {
      setAprProcessando(null);
    }
  }

  /** Rejeita um pedido. */
  async function aprRejeitar(a: AusenciaDTO) {
    setAprProcessando(`rejeitar-${a._id}`);
    setAprErro(null);
    try {
      await adminPatch(`/api/gestor/ausencias/${a._id}/estado`, {
        estado: "rejeitada",
      });
      setAprToast({ tipo: "sucesso", msg: "Pedido rejeitado." });
      setAprPendentes((prev) => prev.filter((p) => p._id !== a._id));
    } catch (e) {
      setAprToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro ao rejeitar: ${e.message}` : "Erro ao rejeitar pedido.",
      });
    } finally {
      setAprProcessando(null);
    }
  }

  /**
   * v1.62.0 (Prompt 85) — Elimina definitivamente uma ausência.
   * Chamado após confirmação no Dialog. Faz DELETE /api/gestor/ausencias/:id.
   */
  async function aprEliminar() {
    if (!aprEliminarAlvo) return;
    const alvo = aprEliminarAlvo;
    setAprProcessando(`eliminar-${alvo._id}`);
    setAprErro(null);
    try {
      await adminDelete(`/api/gestor/ausencias/${alvo._id}`);
      setAprToast({ tipo: "sucesso", msg: "Ausência eliminada com sucesso." });
      // Remove da lista de pendentes.
      setAprPendentes((prev) => prev.filter((p) => p._id !== alvo._id));
      setAprEliminarAlvo(null);
    } catch (e) {
      setAprToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro ao eliminar: ${e.message}` : "Erro ao eliminar ausência.",
      });
    } finally {
      setAprProcessando(null);
    }
  }

  // Auto-esconde o toast após 6s.
  useEffect(() => {
    if (!aprToast) return;
    const t = setTimeout(() => setAprToast(null), 6000);
    return () => clearTimeout(t);
  }, [aprToast]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho da página */}
      <div className="hidden flex-col gap-1 lg:flex">
        <h1 className="text-2xl font-bold tracking-tight">Equipa</h1>
        <p className="text-sm text-muted-foreground">
          Gere os membros da equipa (staff e gestores).
        </p>
      </div>

      <div className="w-full">
        {/* ============================================================ */}
        {/* Lista de Staff                                               */}
        {/* ============================================================ */}
        <div className="mt-4 flex flex-col gap-6">
          {/* Ações */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={carregar}
              disabled={loading}
              aria-label="Atualizar"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button onClick={() => setMostrarForm((v) => !v)}>
              <Plus className="h-4 w-4" />
              Adicionar Funcionário
            </Button>
          </div>

          {/* Filtros (T1) — Estado + Role */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filtroEstado}
              onChange={(e) => {
                setFiltroEstado(e.target.value as "todos" | "ativos" | "inativos");
                setPagina(1);
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Filtrar por estado"
            >
              <option value="todos">Estado: Todos</option>
              <option value="ativos">Estado: Ativos</option>
              <option value="inativos">Estado: Inativos</option>
            </select>
            <select
              value={filtroRole}
              onChange={(e) => {
                setFiltroRole(e.target.value as "todos" | "staff" | "gestor" | "parceiro");
                setPagina(1);
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Filtrar por role"
            >
              <option value="todos">Função: Todas</option>
              <option value="staff">Função: Staff</option>
              <option value="gestor">Função: Gestor</option>
              <option value="parceiro">Função: Parceiro</option>
            </select>
          </div>

          {/* Formulário inline de criação */}
          {mostrarForm && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-5 w-5 text-primary" />
                  Novo Funcionário
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmeter} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1.5">
                      <label htmlFor="nome" className="text-sm font-medium">
                        Nome
                      </label>
                      <Input
                        id="nome"
                        value={form.nome}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, nome: e.target.value }))
                        }
                        placeholder="Ex.: Maria Ferreira"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="email" className="text-sm font-medium">
                        Email
                      </label>
                      <Input
                        id="email"
                        type="email"
                        value={form.email}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, email: e.target.value }))
                        }
                        placeholder="exemplo@all2gether.pt"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="password" className="text-sm font-medium">
                        Password
                      </label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showFormPassword ? "text" : "password"}
                          value={form.password}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, password: e.target.value }))
                          }
                          placeholder="Mín. 6 caracteres"
                          required
                          className="pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowFormPassword((v) => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          aria-label={showFormPassword ? "Ocultar password" : "Mostrar password"}
                        >
                          {showFormPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="telefone" className="text-sm font-medium">
                        Telemóvel (WhatsApp)
                      </label>
                      <Input
                        id="telefone"
                        type="tel"
                        value={form.telefone}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, telefone: e.target.value }))
                        }
                        placeholder="+351 912 345 678"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="role" className="text-sm font-medium">
                        Tipo de utilizador
                      </label>
                      <select
                        id="role"
                        value={form.role}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, role: e.target.value as Role }))
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="staff">Staff (funcionário de limpezas)</option>
                        <option value="gestor">Responsável (gere a equipa)</option>
                        <option value="parceiro">Parceiro (B2B externo — cria reservas)</option>
                        <option value="fornecedor">Fornecedor (Lavandaria — gestão de roupa)</option>
                      </select>
                      {form.role === "parceiro" && (
                        <p className="text-xs text-muted-foreground">
                          Parceiros são externos: não têm folgas semanais nem responsável hierárquico.
                          Acedem ao portal B2B para criar reservas manuais nas suas propriedades.
                        </p>
                      )}
                    </div>
                    {form.role !== "parceiro" && (
                      <div className="space-y-1.5">
                        <label htmlFor="responsavel" className="text-sm font-medium">
                          Responsável{" "}
                          <span className="font-normal text-muted-foreground">
                            (opcional)
                          </span>
                        </label>
                        <select
                          id="responsavel"
                          value={form.responsavel_id}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, responsavel_id: e.target.value }))
                          }
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <option value="">— Sem responsável —</option>
                          {responsaveisPossiveis.map((r) => (
                            <option key={r._id} value={r._id}>
                              {r.nome} ({ROLE_LABEL[r.role]})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Folgas Semanais Fixas — só para staff/gestor (não parceiros) */}
                  {form.role !== "parceiro" && (
                    <FolgasSemanaisCheckboxes
                      diasFolga={form.dias_folga}
                      onChange={(dias) => setForm((f) => ({ ...f, dias_folga: dias }))}
                    />
                  )}

                  {/* FIX (alocação bidirecional) — Propriedades Alocadas
                      (controlo geográfico). Multiselect de checkboxes para
                      associar este staff a propriedades específicas.
                      FIX (pesquisa) — Campo de pesquisa para filtrar por nome
                      quando há muitas propriedades. Mostra TODAS as propriedades
                      (ativas e inativas), igual ao cartão "Equipa Preferencial"
                      no separador "Atribuição" da página de Propriedades. */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">
                      Propriedades Alocadas (controlo geográfico)
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Associa este staff a propriedades específicas. Usado para
                      controlo geográfico (ex: Lisboa vs Algarve).
                    </p>
                    {propriedades.length === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        Sem propriedades disponíveis.
                      </p>
                    ) : (
                      <>
                        {/* FIX (pesquisa propriedades) — Input de pesquisa */}
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            type="text"
                            placeholder="Pesquisar propriedade..."
                            value={pesquisaPropriedades}
                            onChange={(e) => setPesquisaPropriedades(e.target.value)}
                            className="h-8 pl-7 text-xs"
                          />
                        </div>
                        <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border border-input p-2 sm:grid-cols-2">
                          {propriedades
                            .filter((p) => p.ativo || form.propriedades_alocadas.includes(p._id))
                            .filter((p) =>
                              !pesquisaPropriedades.trim()
                                ? true
                                : p.nome.toLowerCase().includes(pesquisaPropriedades.toLowerCase().trim())
                            )
                            .map((p) => {
                            const checked =
                              form.propriedades_alocadas.includes(p._id);
                            return (
                              <label
                                key={p._id}
                                className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                                  checked
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-input text-muted-foreground hover:bg-muted/50"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setForm((f) => ({
                                      ...f,
                                      propriedades_alocadas: e.target.checked
                                        ? [...f.propriedades_alocadas, p._id]
                                        : f.propriedades_alocadas.filter(
                                            (id) => id !== p._id
                                          ),
                                    }));
                                  }}
                                  className="h-3.5 w-3.5"
                                />
                                <span className="flex-1 truncate" title={p.nome}>{p.nome}</span>
                                {!p.ativo && (
                                  <Badge variant="outline" className="text-[10px]">
                                    inativa
                                  </Badge>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                {/* FIX (toggle exclusivo) — Toggle "Exclusivo Preferenciais".
                    Se ativo, este staff SÓ recebe tarefas de propriedades onde
                    o seu ID consta na equipa_preferencial. Default: false. */}
                <div className="flex items-center justify-between gap-3 rounded-md border border-input p-3">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium leading-none">
                      Staff Exclusivo (só equipa preferencial)
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Se ativo, este funcionário só é elegível para tarefas das
                      propriedades onde está na equipa preferencial. Caso
                      contrário, pode ser atribuído a qualquer propriedade.
                    </p>
                  </div>
                  <Switch
                    checked={form.exclusivo_preferenciais}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, exclusivo_preferenciais: v }))}
                    aria-label="Staff exclusivo"
                  />
                </div>

                  {formErro && (
                    <p className="flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4" />
                      {formErro}
                    </p>
                  )}

                  <div className="flex items-center gap-2">
                    <Button type="submit" disabled={submitting}>
                      {submitting ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          A guardar…
                        </>
                      ) : (
                        "Guardar Funcionário"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setMostrarForm(false);
                        setFormErro(null);
                        setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "", propriedades_alocadas: [], exclusivo_preferenciais: false });
                      }}
                      disabled={submitting}
                    >
                      Cancelar
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Erro de carregamento */}
          {erro && !loading && (
            <Card className="border-destructive/50">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">Não foi possível carregar a equipa.</p>
                  <p className="text-xs opacity-80">{erro}</p>
                </div>
                <Button variant="outline" size="sm" onClick={carregar}>
                  Tentar novamente
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Tabela de utilizadores */}
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  A carregar equipa…
                </div>
              ) : utilizadoresFiltrados.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                  <Users className="h-10 w-10 opacity-40" />
                  <p className="text-sm">Ainda não há membros na equipa.</p>
                  <p className="text-xs">
                    Clica em “Adicionar Funcionário” para adicionar o primeiro.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-4 py-3 font-medium">Nome</th>
                        <th className="px-4 py-3 font-medium">Email</th>
                        <th className="px-4 py-3 font-medium">Telemóvel</th>
                        <th className="px-4 py-3 font-medium">Role</th>
                        <th className="px-4 py-3 font-medium">Responsável</th>
                        <th className="px-4 py-3 font-medium">Estado</th>
                        <th className="px-4 py-3 text-right font-medium">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {utilizadoresPagina.map((u) => {
                        // FIX (férias visíveis) — tipo de ausência ativa hoje
                        // ('ferias' | 'doenca' | 'outro' | undefined).
                        const ausenteTipo = ausentesHoje[u._id];
                        return (
                        <tr key={u._id} className={`hover:bg-muted/30 ${ausenteTipo ? "opacity-65" : ""}`}>
                          <td className="px-4 py-3 font-medium">
                            <div className="flex items-center gap-2">
                              {u.nome}
                              {/* FIX (visualização exclusivo) — Badge visível na
                                  tabela sempre que exclusivo_preferenciais for true. */}
                              {u.exclusivo_preferenciais && (
                                <Badge
                                  variant="outline"
                                  className="gap-1 text-[10px]"
                                  title="Staff exclusivo — só recebe tarefas de propriedades onde está na equipa preferencial"
                                >
                                  <Lock className="h-3 w-3" />
                                  Exclusivo
                                </Badge>
                              )}
                              {ausenteTipo === "ferias" && (
                                <Badge variant="destructive" className="text-[10px]">
                                  De Férias
                                </Badge>
                              )}
                              {ausenteTipo === "doenca" && (
                                <Badge variant="destructive" className="text-[10px]">
                                  Doente
                                </Badge>
                              )}
                              {ausenteTipo &&
                                ausenteTipo !== "ferias" &&
                                ausenteTipo !== "doenca" && (
                                  <Badge variant="destructive" className="text-[10px]">
                                    Ausente
                                  </Badge>
                                )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {u.email}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {u.telefone ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Phone className="h-3.5 w-3.5" />
                                {u.telefone}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={ROLE_VARIANT[u.role]}>
                              {ROLE_LABEL[u.role]}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {u.responsavel ? u.responsavel.nome : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={u.ativo ? "success" : "secondary"}>
                              {u.ativo ? "Ativo" : "Inativo"}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {/* Admin: linha só de leitura (sem ações) */}
                            {u.role === "admin" ? (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                {/* Editar */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => abrirEdicao(u)}
                                  aria-label={`Editar ${u.nome}`}
                                  title="Editar"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                {/* Ativar/Desativar */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleToggleAtivo(u)}
                                  aria-label={u.ativo ? "Desativar" : "Ativar"}
                                  title={u.ativo ? "Desativar" : "Ativar"}
                                >
                                  <Power className="h-4 w-4" />
                                </Button>
                                {/* FIX (soft-delete com desatribuição) — Botão "Eliminar"
                                    removido. O soft-delete é feito via "Inativar" (Power),
                                    que agora desatribui automaticamente as tarefas futuras.
                                    Utilizadores inativos continuam visíveis na lista para
                                    reativação. O hard-delete (eliminado_em) só é acessível
                                    via API direta para casos extremos. */}
                                {/* Falta súbita */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-amber-500 hover:text-amber-600"
                                  onClick={() => {
                                    setFaltaSubita(u);
                                    setFaltaResultado(null);
                                  }}
                                  aria-label={`Reportar falta súbita de ${u.nome}`}
                                  title="Reportar Falta Hoje"
                                >
                                  <Siren className="h-4 w-4" />
                                </Button>
                                {/* Baixa prolongada / férias */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-blue-500 hover:text-blue-600"
                                  onClick={() => {
                                    setBaixaModal(u);
                                    setBaixaForm({ data_inicio: "", data_fim: "" });
                                    setBaixaResultado(null);
                                  }}
                                  aria-label={`Registar baixa ou férias de ${u.nome}`}
                                  title="Registar Baixa / Férias"
                                >
                                  <CalendarOff className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Paginação */}
              {!loading && utilizadoresFiltrados.length > 0 && (
                <PaginationBar
                  page={paginaSegura}
                  totalPages={totalPaginas}
                  total={utilizadoresFiltrados.length}
                  pageSize={tamPagina}
                  onPageChange={setPagina}
                  onPageSizeChange={(n) => {
                    setTamPagina(n);
                    setPagina(1);
                  }}
                  label="membros"
                />
              )}
            </CardContent>
          </Card>

          {/* Modal de Edição */}
          <Dialog
            open={editando !== null}
            onOpenChange={(o) => !o && setEditando(null)}
          >
            <DialogHeader>
              <div>
                <DialogTitle>Editar Utilizador</DialogTitle>
                <DialogDescription>
                  Atualiza os dados do funcionário. Deixa a password vazia para
                  manter a atual.
                </DialogDescription>
              </div>
              <DialogClose onClick={() => setEditando(null)} />
            </DialogHeader>
            <form onSubmit={handleEditar}>
              <DialogContent className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="edit-nome" className="text-sm font-medium">
                    Nome
                  </label>
                  <Input
                    id="edit-nome"
                    value={editForm.nome}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, nome: e.target.value }))
                    }
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-email" className="text-sm font-medium">
                    Email
                  </label>
                  <Input
                    id="edit-email"
                    type="email"
                    value={editForm.email}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, email: e.target.value }))
                    }
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-telefone" className="text-sm font-medium">
                    Telemóvel (WhatsApp)
                  </label>
                  <Input
                    id="edit-telefone"
                    type="tel"
                    value={editForm.telefone}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, telefone: e.target.value }))
                    }
                    placeholder="+351 912 345 678"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-role" className="text-sm font-medium">
                    Tipo de utilizador
                  </label>
                  <select
                    id="edit-role"
                    value={editForm.role}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, role: e.target.value as Role }))
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="staff">Staff (funcionário de limpezas)</option>
                    <option value="gestor">Responsável (gere a equipa)</option>
                    <option value="parceiro">Parceiro (B2B externo — cria reservas)</option>
                    <option value="fornecedor">Fornecedor (Lavandaria — gestão de roupa)</option>
                  </select>
                  {editForm.role === "parceiro" && (
                    <p className="text-xs text-muted-foreground">
                      Parceiros são externos: não têm folgas semanais nem responsável hierárquico.
                      Acedem ao portal B2B para criar reservas manuais nas suas propriedades.
                    </p>
                  )}
                </div>
                {editForm.role !== "parceiro" && (
                  <div className="space-y-1.5">
                    <label htmlFor="edit-responsavel" className="text-sm font-medium">
                      Responsável{" "}
                      <span className="font-normal text-muted-foreground">
                        (opcional)
                      </span>
                    </label>
                    <select
                      id="edit-responsavel"
                      value={editForm.responsavel_id}
                      onChange={(e) =>
                        setEditForm((f) => ({
                          ...f,
                          responsavel_id: e.target.value,
                        }))
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <option value="">— Sem responsável —</option>
                      {responsaveisPossiveis
                        .filter((r) => r._id !== editando?._id)
                        .map((r) => (
                          <option key={r._id} value={r._id}>
                            {r.nome} ({ROLE_LABEL[r.role]})
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="edit-password" className="text-sm font-medium">
                    Nova Password{" "}
                    <span className="font-normal text-muted-foreground">
                      (opcional)
                    </span>
                  </label>
                  <div className="relative">
                    <Input
                      id="edit-password"
                      type={showEditPassword ? "text" : "password"}
                      value={editForm.password}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, password: e.target.value }))
                      }
                      placeholder="Deixa vazio para manter"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowEditPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showEditPassword ? "Ocultar password" : "Mostrar password"}
                    >
                      {showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Útil para redefinir a password se o funcionário se esquecer.
                  </p>
                </div>

                {/* Folgas Semanais Fixas — só para staff/gestor (não parceiros) */}
                {editForm.role !== "parceiro" && (
                  <FolgasSemanaisCheckboxes
                    diasFolga={editForm.dias_folga}
                    onChange={(dias) =>
                      setEditForm((f) => ({ ...f, dias_folga: dias }))
                    }
                  />
                )}

                {/* HF10 — Folgas Específicas / Rotativas — só para staff/gestor */}
                {editForm.role !== "parceiro" && (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-medium leading-none">
                      Folgas Específicas / Rotativas
                    </h4>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Datas específicas em que o funcionário não está disponível
                    (além das folgas semanais fixas). O sistema cria a tarefa
                    com alerta se o check-out calhar num destes dias.
                  </p>

                  {/* Formulário para adicionar nova folga */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex-1 space-y-1">
                      <label htmlFor="nova-folga-data" className="text-xs text-muted-foreground">
                        Data
                      </label>
                      <Input
                        id="nova-folga-data"
                        type="date"
                        value={novaFolga.data}
                        onChange={(e) =>
                          setNovaFolga((nf) => ({ ...nf, data: e.target.value }))
                        }
                        className="h-9"
                      />
                    </div>
                    <div className="flex-[2] space-y-1">
                      <label htmlFor="nova-folga-motivo" className="text-xs text-muted-foreground">
                        Motivo (opcional)
                      </label>
                      <Input
                        id="nova-folga-motivo"
                        type="text"
                        placeholder="Ex.: Férias, formação, médico…"
                        value={novaFolga.motivo}
                        onChange={(e) =>
                          setNovaFolga((nf) => ({ ...nf, motivo: e.target.value }))
                        }
                        className="h-9"
                        maxLength={200}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={adicionarFolgaRotativa}
                      disabled={!novaFolga.data}
                    >
                      <Plus className="h-4 w-4" />
                      Adicionar
                    </Button>
                  </div>

                  {/* Lista de folgas agendadas (ordenadas por data) */}
                  {editForm.folgas_rotativas.length === 0 ? (
                    <p className="text-xs italic text-muted-foreground">
                      Nenhuma folga específica agendada.
                    </p>
                  ) : (
                    <ul className="max-h-48 space-y-1 overflow-y-auto">
                      {editForm.folgas_rotativas.map((fr) => {
                        // Formata a data para pt-PT (dd/MM/yyyy).
                        let dataFormatada = fr.data;
                        try {
                          const d = new Date(fr.data + "T00:00:00");
                          dataFormatada = format(d, "dd/MM/yyyy", { locale: pt });
                        } catch {
                          // mantém o valor original
                        }
                        const isPassada = new Date(fr.data + "T00:00:00") < new Date(new Date().toDateString());
                        return (
                          <li
                            key={fr.data}
                            className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm ${
                              isPassada ? "opacity-50" : ""
                            }`}
                          >
                            <div className="flex flex-col">
                              <span className="font-medium">{dataFormatada}</span>
                              {fr.motivo && (
                                <span className="text-xs text-muted-foreground">
                                  {fr.motivo}
                                </span>
                              )}
                              {isPassada && (
                                <span className="text-xs text-muted-foreground">
                                  (passada)
                                </span>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                              onClick={() => removerFolgaRotativa(fr.data)}
                              aria-label={`Remover folga de ${dataFormatada}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                )}

                {/* FIX (alocação bidirecional) — Propriedades Alocadas
                    (controlo geográfico). Multiselect de checkboxes para
                    associar este staff a propriedades específicas.
                    FIX (pesquisa) — Campo de pesquisa para filtrar por nome
                    quando há muitas propriedades. Mostra TODAS as propriedades
                    (ativas e inativas), igual ao cartão "Equipa Preferencial"
                    no separador "Atribuição" da página de Propriedades. */}
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">
                    Propriedades Alocadas (controlo geográfico)
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Associa este staff a propriedades específicas. Usado para
                    controlo geográfico (ex: Lisboa vs Algarve).
                  </p>
                  {propriedades.length === 0 ? (
                    <p className="text-xs italic text-muted-foreground">
                      Sem propriedades disponíveis.
                    </p>
                  ) : (
                    <>
                      {/* FIX (pesquisa propriedades) — Input de pesquisa */}
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          type="text"
                          placeholder="Pesquisar propriedade..."
                          value={pesquisaPropriedades}
                          onChange={(e) => setPesquisaPropriedades(e.target.value)}
                          className="h-8 pl-7 text-xs"
                        />
                      </div>
                      <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border border-input p-2 sm:grid-cols-2">
                        {propriedades
                          .filter((p) => p.ativo || editForm.propriedades_alocadas.includes(p._id))
                          .filter((p) =>
                            !pesquisaPropriedades.trim()
                              ? true
                              : p.nome.toLowerCase().includes(pesquisaPropriedades.toLowerCase().trim())
                          )
                          .map((p) => {
                          const checked =
                            editForm.propriedades_alocadas.includes(p._id);
                          return (
                            <label
                              key={p._id}
                              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                                checked
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-input text-muted-foreground hover:bg-muted/50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setEditForm((f) => ({
                                    ...f,
                                    propriedades_alocadas: e.target.checked
                                      ? [...f.propriedades_alocadas, p._id]
                                      : f.propriedades_alocadas.filter(
                                          (id) => id !== p._id
                                        ),
                                  }));
                                }}
                                className="h-3.5 w-3.5"
                              />
                              <span className="flex-1 truncate" title={p.nome}>{p.nome}</span>
                              {!p.ativo && (
                                <Badge variant="outline" className="text-[10px]">
                                  inativa
                                </Badge>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>

                {/* FIX (toggle exclusivo) — Toggle "Exclusivo Preferenciais"
                    no formulário de edição. Sincroniza com o campo do backend. */}
                <div className="flex items-center justify-between gap-3 rounded-md border border-input p-3">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium leading-none">
                      Staff Exclusivo (só equipa preferencial)
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Se ativo, este funcionário só é elegível para tarefas das
                      propriedades onde está na equipa preferencial.
                    </p>
                  </div>
                  <Switch
                    checked={editForm.exclusivo_preferenciais}
                    onCheckedChange={(v) => setEditForm((f) => ({ ...f, exclusivo_preferenciais: v }))}
                    aria-label="Staff exclusivo"
                  />
                </div>

                {editErro && (
                  <p className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    {editErro}
                  </p>
                )}
              </DialogContent>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditando(null)}
                  disabled={editSubmitting}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={editSubmitting}>
                  {editSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      A guardar…
                    </>
                  ) : (
                    "Guardar Alterações"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Dialog>

          {/* Modal de Confirmação de Eliminação */}
          <Dialog
            open={eliminando !== null}
            onOpenChange={(o) => !o && setEliminando(null)}
          >
            <DialogHeader>
              <div>
                <DialogTitle>Eliminar Utilizador</DialogTitle>
                <DialogDescription>
                  Esta ação é permanente e não pode ser desfeita.
                </DialogDescription>
              </div>
              <DialogClose onClick={() => setEliminando(null)} />
            </DialogHeader>
            <DialogContent className="space-y-3">
              <p className="text-sm">
                Tens a certeza que queres eliminar{" "}
                <span className="font-semibold">{eliminando?.nome}</span> (
                {eliminando?.email})?
              </p>
              <p className="text-xs text-muted-foreground">
                O utilizador perderá imediatamente o acesso à plataforma. Se só
                quiseres suspender o acesso temporariamente, usa o botão de
                Desativar.
              </p>
              {editErro && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {editErro}
                </p>
              )}
            </DialogContent>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEliminando(null)}
                disabled={elimSubmitting}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleEliminar}
                disabled={elimSubmitting}
              >
                {elimSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    A eliminar…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    Eliminar Definitivamente
                  </>
                )}
              </Button>
            </DialogFooter>
          </Dialog>

          {/* Modal de Falta Súbita */}
          <Dialog
            open={faltaSubita !== null}
            onOpenChange={(o) => !o && setFaltaSubita(null)}
          >
            <DialogHeader>
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Siren className="h-5 w-5 text-amber-500" />
                  Reportar Falta Súbita
                </DialogTitle>
                <DialogDescription>
                  As tarefas de hoje serão redistribuídas pelos colegas disponíveis.
                </DialogDescription>
              </div>
              <DialogClose onClick={() => setFaltaSubita(null)} />
            </DialogHeader>
            <DialogContent className="space-y-3">
              <p className="text-sm">
                Reportar falta hoje para{" "}
                <span className="font-semibold">{faltaSubita?.nome}</span>?
              </p>
              <p className="text-xs text-muted-foreground">
                As tarefas de hoje deste funcionário serão redistribuídas pelos
                colegas disponíveis, usando o sistema de load balancing com
                tempo de viagem. Tarefas sem ninguém disponível ficarão por atribuir.
              </p>
              {faltaResultado && (
                <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200">
                  {faltaResultado}
                </div>
              )}
            </DialogContent>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFaltaSubita(null)}
                disabled={faltaSubmitting}
              >
                {faltaResultado ? "Fechar" : "Cancelar"}
              </Button>
              {!faltaResultado && (
                <Button
                  type="button"
                  className="bg-amber-500 text-white hover:bg-amber-600"
                  onClick={handleFaltaSubita}
                  disabled={faltaSubmitting}
                >
                  {faltaSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      A processar…
                    </>
                  ) : (
                    <>
                      <Siren className="h-4 w-4" />
                      Confirmar Falta
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </Dialog>

          {/* Modal de Baixa Prolongada / Férias */}
          <Dialog
            open={baixaModal !== null}
            onOpenChange={(o) => !o && setBaixaModal(null)}
          >
            <DialogHeader>
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <CalendarOff className="h-5 w-5 text-blue-500" />
                  Registar Baixa ou Férias
                </DialogTitle>
                <DialogDescription>
                  As tarefas futuras serão redistribuídas pelos colegas disponíveis.
                </DialogDescription>
              </div>
              <DialogClose onClick={() => setBaixaModal(null)} />
            </DialogHeader>
            <DialogContent className="space-y-4">
              {!baixaResultado ? (
                <>
                  <p className="text-sm">
                    Registar baixa para{" "}
                    <span className="font-semibold">{baixaModal?.nome}</span>?
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label htmlFor="baixa-inicio" className="text-sm font-medium">
                        Data de Início
                      </label>
                      <Input
                        id="baixa-inicio"
                        type="date"
                        value={baixaForm.data_inicio}
                        onChange={(e) =>
                          setBaixaForm((f) => ({ ...f, data_inicio: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="baixa-fim" className="text-sm font-medium">
                        Data de Fim
                      </label>
                      <Input
                        id="baixa-fim"
                        type="date"
                        value={baixaForm.data_fim}
                        onChange={(e) =>
                          setBaixaForm((f) => ({ ...f, data_fim: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Todas as tarefas atribuídas a este funcionário no período serão
                    reatribuídas usando o sistema de load balancing. As que não
                    tiverem ninguém disponível ficarão por atribuir.
                  </p>
                </>
              ) : (
                <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 p-3 text-sm text-blue-800 dark:text-blue-200">
                  {baixaResultado}
                </div>
              )}
            </DialogContent>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBaixaModal(null)}
                disabled={baixaSubmitting}
              >
                {baixaResultado ? "Fechar" : "Cancelar"}
              </Button>
              {!baixaResultado && (
                <Button
                  type="button"
                  className="bg-blue-500 text-white hover:bg-blue-600"
                  disabled={
                    !baixaForm.data_inicio ||
                    !baixaForm.data_fim ||
                    baixaSubmitting
                  }
                  onClick={async () => {
                    if (!baixaModal) return;
                    setBaixaSubmitting(true);
                    try {
                      const res = await adminPost<{
                        reatribuidas: number;
                        orfas: number;
                        total: number;
                      }>(`/api/gestor/equipa/${baixaModal._id}/baixa`, {
                        data_inicio: baixaForm.data_inicio,
                        data_fim: baixaForm.data_fim,
                        tipo: "ferias",
                      });
                      setBaixaResultado(
                        `Baixa registada. ${res.reatribuidas} tarefa(s) reatribuída(s) aos colegas, ${res.orfas} ficou(aram) por atribuir.`
                      );
                      await carregar();
                    } catch (e) {
                      setBaixaResultado(
                        e instanceof Error ? e.message : "Erro ao registar baixa."
                      );
                    } finally {
                      setBaixaSubmitting(false);
                    }
                  }}
                >
                  {baixaSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      A processar…
                    </>
                  ) : (
                    <>
                      <CalendarOff className="h-4 w-4" />
                      Confirmar Ausência
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </Dialog>
        </div>
      </div>

      {/* Dialog de confirmação de eliminação de ausência (mantido para o
          botão de eliminar da lista de staff, se aplicável) */}
      <Dialog
        open={aprEliminarAlvo !== null}
        onOpenChange={(o) => !o && setAprEliminarAlvo(null)}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Eliminar Ausência
          </DialogTitle>
          <DialogDescription>
            Tens a certeza que queres eliminar esta ausência? Esta ação é
            definitiva e não pode ser desfeita.
          </DialogDescription>
          <DialogClose onClick={() => setAprEliminarAlvo(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aprEliminarAlvo && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Funcionário</span>
                <span className="font-medium">
                  {aprEliminarAlvo.utilizador?.nome ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Tipo</span>
                <span className="font-medium">
                  {TIPO_LABEL[aprEliminarAlvo.tipo] ?? aprEliminarAlvo.tipo}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Período</span>
                <span className="font-medium tabular-nums">
                  {formatarData(aprEliminarAlvo.data_inicio)}
                  {aprEliminarAlvo.data_inicio !== aprEliminarAlvo.data_fim && (
                    <> → {formatarData(aprEliminarAlvo.data_fim)}</>
                  )}
                </span>
              </div>
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAprEliminarAlvo(null)}
            disabled={aprProcessando !== null}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={aprEliminar}
            disabled={aprProcessando !== null}
          >
            {aprProcessando !== null ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A eliminar…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                Eliminar Definitivamente
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
