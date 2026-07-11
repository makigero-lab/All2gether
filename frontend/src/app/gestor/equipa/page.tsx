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
  // Ícones usados pela aba de Aprovações
  CalendarCheck,
  Check,
  X,
  CheckCircle2,
  User,
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
  type Role,
} from "@/lib/api";
import { PaginationBar } from "@/components/admin/pagination-bar";
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
};

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline"> = {
  admin: "default",
  gestor: "secondary",
  staff: "outline",
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

  // Paginação client-side.
  const [pagina, setPagina] = useState(1);
  const [tamPagina, setTamPagina] = useState(25);
  const totalPaginas = Math.max(1, Math.ceil(utilizadores.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const utilizadoresPagina = utilizadores.slice(
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
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErro, setEditErro] = useState<string | null>(null);

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

  // IDs dos utilizadores com ausência aprovada para hoje (para mostrar badge).
  const [ausentesHoje, setAusentesHoje] = useState<Set<string>>(new Set());

  /** Carrega os utilizadores da API + ausências aprovadas para hoje. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const hoje = new Date();

      const [data, ausenciasRes] = await Promise.all([
        adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
        adminGet<{
          ausencias: {
            utilizador_id: string;
            data_inicio: string;
            data_fim: string;
            estado: string;
          }[];
        }>("/api/gestor/ausencias?estado=aprovada"),
      ]);
      setUtilizadores(data.utilizadores ?? []);

      // Filtra as ausências aprovadas que cobrem hoje.
      const hojeUTC = new Date(
        Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
      );
      const setAusentes = new Set<string>();
      for (const a of ausenciasRes.ausencias ?? []) {
        const ini = parsearDataSegura(a.data_inicio);
        const fim = parsearDataSegura(a.data_fim);
        if (ini && fim && hojeUTC >= ini && hojeUTC <= fim && a.utilizador_id) {
          setAusentes.add(a.utilizador_id);
        }
      }
      setAusentesHoje(setAusentes);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar equipa.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

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
      });
      setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "" });
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
    setEditForm({
      nome: u.nome,
      email: u.email,
      role: u.role,
      password: "",
      responsavel_id: u.responsavel_id ?? "",
      dias_folga: u.dias_folga ?? [],
      telefone: u.telefone ?? "",
    });
    setEditErro(null);
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
                        placeholder="exemplo@autocell.pt"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="password" className="text-sm font-medium">
                        Password
                      </label>
                      <Input
                        id="password"
                        type="password"
                        value={form.password}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, password: e.target.value }))
                        }
                        placeholder="Mín. 6 caracteres"
                        required
                      />
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
                        Role
                      </label>
                      <select
                        id="role"
                        value={form.role}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, role: e.target.value as Role }))
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="staff">Staff</option>
                        <option value="gestor">Responsável</option>
                      </select>
                    </div>
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
                  </div>

                  {/* Folgas Semanais Fixas */}
                  <FolgasSemanaisCheckboxes
                    diasFolga={form.dias_folga}
                    onChange={(dias) => setForm((f) => ({ ...f, dias_folga: dias }))}
                  />

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
                        setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "" });
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
              ) : utilizadores.length === 0 ? (
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
                        const ausenteHoje = ausentesHoje.has(u._id);
                        return (
                        <tr key={u._id} className={`hover:bg-muted/30 ${ausenteHoje ? "opacity-65" : ""}`}>
                          <td className="px-4 py-3 font-medium">
                            <div className="flex items-center gap-2">
                              {u.nome}
                              {ausenteHoje && (
                                <Badge variant="destructive" className="text-[10px]">
                                  Ausente Hoje
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
                                {/* Eliminar */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => setEliminando(u)}
                                  aria-label={`Eliminar ${u.nome}`}
                                  title="Eliminar"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
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
              {!loading && utilizadores.length > 0 && (
                <PaginationBar
                  page={paginaSegura}
                  totalPages={totalPaginas}
                  total={utilizadores.length}
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
                    Role
                  </label>
                  <select
                    id="edit-role"
                    value={editForm.role}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, role: e.target.value as Role }))
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="staff">Staff</option>
                    <option value="gestor">Responsável</option>
                  </select>
                </div>
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
                <div className="space-y-1.5">
                  <label htmlFor="edit-password" className="text-sm font-medium">
                    Nova Password{" "}
                    <span className="font-normal text-muted-foreground">
                      (opcional)
                    </span>
                  </label>
                  <Input
                    id="edit-password"
                    type="password"
                    value={editForm.password}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, password: e.target.value }))
                    }
                    placeholder="Deixa vazio para manter"
                  />
                  <p className="text-xs text-muted-foreground">
                    Útil para redefinir a password se o funcionário se esquecer.
                  </p>
                </div>

                {/* Folgas Semanais Fixas */}
                <FolgasSemanaisCheckboxes
                  diasFolga={editForm.dias_folga}
                  onChange={(dias) =>
                    setEditForm((f) => ({ ...f, dias_folga: dias }))
                  }
                />

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
