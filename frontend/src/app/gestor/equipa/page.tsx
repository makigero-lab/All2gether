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
  AlertTriangle,
  Download,
  ShieldX,
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
import { ApagarDadosDialog } from "@/components/rgpd/apagar-dados-dialog";
import { descarregarFicheiro } from "@/lib/descarregar";
import { lerUtilizador } from "@/lib/auth";
import { NOME_COR_EQUIPA, PALETA_EQUIPA, mapaCoresEquipa } from "@/lib/cores-equipa";
import { Switch } from "@/components/ui/switch";
import { parsearDataSegura, tarefasPorAtribuir, textoRedistribuicao, type RedistribuicaoDTO, plural } from "@/lib/utils";

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
  staff: "Equipa",
  parceiro: "Proprietário",
  fornecedor: "Lavandaria",
};

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline"> = {
  admin: "default",
  gestor: "secondary",
  staff: "outline",
  parceiro: "outline",
  fornecedor: "outline",
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
    // FIX (atribuição bidirecional fornecedor) — Propriedades atribuídas a
    // este fornecedor (lavandaria). Só se aplica se role === 'fornecedor'.
    propriedades_atribuidas: [] as string[],
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
    // Cor da pessoa no calendário (#rrggbb); "" = automática.
    cor: "",
    // HF10 — Folgas rotativas (datas específicas).
    folgas_rotativas: [] as { _id?: string; data: string; motivo: string }[],
    // FIX (alocação bidirecional) — Propriedades às quais este staff está
    // alocado (controlo geográfico). Array de IDs de Propriedade.
    propriedades_alocadas: [] as string[],
    // FIX (toggle exclusivo) — Se true, este staff SÓ é elegível para tarefas
    // de propriedades onde consta na equipa_preferencial.
    exclusivo_preferenciais: false,
    // FIX (atribuição bidirecional fornecedor) — Propriedades atribuídas a
    // este fornecedor (lavandaria). Só se aplica se role === 'fornecedor'.
    propriedades_atribuidas: [] as string[],
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
  // RGPD: exportar / apagar os dados pessoais de uma pessoa (ações separadas das restantes).
  const [apagarDados, setApagarDados] = useState<UtilizadorDTO | null>(null);
  const [exportandoId, setExportandoId] = useState<string | null>(null);
  const [rgpdMsg, setRgpdMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [eu, setEu] = useState<{ id: string; role: string } | null>(null);
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const u = await lerUtilizador();
      if (!cancelado && u) setEu({ id: u.id, role: u.role });
    })();
    return () => {
      cancelado = true;
    };
  }, []);
  const [elimSubmitting, setElimSubmitting] = useState(false);

  // Modal de falta súbita
  const [faltaSubita, setFaltaSubita] = useState<UtilizadorDTO | null>(null);
  const [faltaSubmitting, setFaltaSubmitting] = useState(false);
  const [faltaResultado, setFaltaResultado] = useState<string | null>(null);

  // Modal de baixa prolongada
  const [baixaModal, setBaixaModal] = useState<UtilizadorDTO | null>(null);
  const [baixaForm, setBaixaForm] = useState({ data_inicio: "", data_fim: "", tipo: "ferias" });
  const [baixaSubmitting, setBaixaSubmitting] = useState(false);
  const [baixaResultado, setBaixaResultado] = useState<string | null>(null);
  // Nº de tarefas que SOBRARAM por atribuir depois da reatribuição automática
  // (>0 mostra o botão de nova tentativa).
  const [faltaPorAtribuir, setFaltaPorAtribuir] = useState(0);
  const [baixaPorAtribuir, setBaixaPorAtribuir] = useState(0);
  // Aviso de limpezas em curso que continuam com a pessoa (não são desatribuídas).
  const [faltaAviso, setFaltaAviso] = useState<string | null>(null);
  const [baixaAviso, setBaixaAviso] = useState<string | null>(null);
  // Nova tentativa de reatribuição (com clique), para as tarefas que sobraram por atribuir.
  const [autoAtribuindo, setAutoAtribuindo] = useState(false);
  const [autoTentou, setAutoTentou] = useState(false);
  const [autoErro, setAutoErro] = useState<string | null>(null);

  /**
   * Nova tentativa: reatribui automaticamente TODAS as tarefas por atribuir a partir de hoje.
   * O resultado inicial do diálogo é SUBSTITUÍDO pelo novo (sem mensagens contraditórias) e,
   * se ainda sobrarem tarefas, o botão mantém-se como "Tentar de novo".
   */
  async function handleReatribuirAuto(fluxo: "falta" | "baixa") {
    const prefixo = fluxo === "falta" ? "Falta registada." : "Baixa registada.";
    const setResultado = fluxo === "falta" ? setFaltaResultado : setBaixaResultado;
    const setPorAtribuir = fluxo === "falta" ? setFaltaPorAtribuir : setBaixaPorAtribuir;
    setAutoAtribuindo(true);
    setAutoErro(null);
    try {
      const res = await adminPost<{
        sucesso: boolean;
        processadas: number;
        reatribuidas: number;
        orfas: number;
        mensagem?: string;
      }>("/api/gestor/tarefas/auto-atribuir", {});
      setAutoTentou(true);
      setPorAtribuir(res.orfas ?? 0);
      setResultado(
        `${prefixo} ` +
          (res.processadas === 0
            ? res.mensagem ?? "Não há tarefas por atribuir a partir de hoje."
            : `Foram reatribuídas ${plural(res.reatribuidas, "tarefa")}. ` +
              (res.orfas > 0
                ? `${res.orfas} continuam por atribuir (sem staff disponível).`
                : "Nenhuma ficou por atribuir."))
      );
      await carregar();
    } catch (e) {
      // Mantém o botão (porAtribuir não muda) para nova tentativa.
      setAutoErro(
        e instanceof Error
          ? `Reatribuição falhou: ${e.message}`
          : "Erro ao reatribuir tarefas."
      );
    } finally {
      setAutoAtribuindo(false);
    }
  }

  /** Aviso bem visível: limpezas em curso continuam com a pessoa ausente. */
  function avisoEmCurso(texto: string) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{texto}</span>
      </div>
    );
  }

  /**
   * Bloco de nova tentativa (falta súbita e baixa). A reatribuição já correu
   * sozinha; este bloco só aparece se SOBRARAM tarefas por atribuir.
   */
  function renderReatribuir(porAtribuir: number, fluxo: "falta" | "baixa") {
    if (porAtribuir <= 0) return null;
    return (
      <div className="space-y-2 rounded-md border p-3">
        {(
          <>
            <p className="text-xs text-muted-foreground">
              Sobraram {plural(porAtribuir, "tarefa")} por atribuir (ninguém estava
              disponível ou a reatribuição falhou). Pode tentar de novo: o
              sistema distribui por colegas disponíveis TODAS as tarefas por
              atribuir a partir de hoje (não só as desta pessoa). Quem está
              ausente não recebe tarefas.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => handleReatribuirAuto(fluxo)}
                disabled={autoAtribuindo}
              >
                {autoAtribuindo ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    A reatribuir…
                  </>
                ) : autoTentou || autoErro ? (
                  "Tentar de novo"
                ) : (
                  "Reatribuir automaticamente"
                )}
              </Button>
            </div>
          </>
        )}
        {autoErro && <p className="text-sm text-red-600">{autoErro}</p>}
      </div>
    );
  }

  // Cor de cada funcionário no calendário (a mesma conta que o calendário faz: staff ativo).
  const coresEquipa = mapaCoresEquipa(utilizadores.filter((u) => u.role === "staff" && u.ativo));

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
      setFormErro("Nome, email e palavra-passe são obrigatórios.");
      return;
    }
    if (form.password.length < 10) {
      setFormErro("A password deve ter pelo menos 10 caracteres.");
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
        // FIX (atribuição bidirecional fornecedor) — Propriedades atribuídas
        // ao fornecedor (só aplicável se role === 'fornecedor').
        ...(form.role === "fornecedor"
          ? { propriedades_atribuidas: form.propriedades_atribuidas }
          : {}),
      });
      setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "", propriedades_alocadas: [], exclusivo_preferenciais: false, propriedades_atribuidas: [] });
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
      cor: u.cor ?? "",
      folgas_rotativas: folgas,
      // FIX (alocação bidirecional) — Array de IDs de propriedades às quais
      // o staff está alocado (controlo geográfico).
      propriedades_alocadas: Array.isArray(u.propriedades_alocadas)
        ? [...u.propriedades_alocadas]
        : [],
      // FIX (toggle exclusivo) — Carrega o estado de exclusividade do staff.
      exclusivo_preferenciais: Boolean(u.exclusivo_preferenciais),
      // FIX (atribuição bidirecional fornecedor) — Carrega as propriedades
      // atribuídas ao fornecedor (injetadas pelo backend no getEquipa).
      propriedades_atribuidas: Array.isArray(u.propriedades_atribuidas)
        ? [...u.propriedades_atribuidas]
        : [],
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
    if (editForm.password && editForm.password.length < 10) {
      setEditErro("A nova password deve ter pelo menos 10 caracteres.");
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
        // Cor no calendário (só equipa): "" volta à cor automática.
        ...(editForm.role === "staff" ? { cor: editForm.cor || null } : {}),
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
        // FIX (atribuição bidirecional fornecedor) — Propriedades atribuídas
        // ao fornecedor (só aplicável se role === 'fornecedor').
        ...(editForm.role === "fornecedor"
          ? { propriedades_atribuidas: editForm.propriedades_atribuidas }
          : {}),
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

  /** RGPD: descarrega o JSON com os dados pessoais de uma pessoa da equipa. */
  async function handleExportarDados(u: UtilizadorDTO) {
    setExportandoId(u._id);
    setRgpdMsg(null);
    try {
      await descarregarFicheiro(`/api/gestor/equipa/${u._id}/exportar-dados`, `dados-pessoais-${u._id}.json`);
      setRgpdMsg({ tipo: "ok", texto: `Dados de ${u.nome} descarregados.` });
    } catch (e) {
      setRgpdMsg({ tipo: "erro", texto: e instanceof Error ? e.message : "Não foi possível exportar os dados." });
    } finally {
      setExportandoId(null);
    }
  }

  /** Reporta falta súbita (POST) e mostra resultado. */
  async function handleFaltaSubita() {
    if (!faltaSubita) return;
    setFaltaSubmitting(true);
    setFaltaResultado(null);
    setFaltaPorAtribuir(0);
    setFaltaAviso(null);
    setAutoTentou(false);
    setAutoErro(null);
    try {
      const res = await adminPost<RedistribuicaoDTO>(
        `/api/gestor/equipa/${faltaSubita._id}/falta-subita`,
        {}
      );
      setFaltaPorAtribuir(tarefasPorAtribuir(res));
      setFaltaAviso(res.aviso ?? null);
      setFaltaResultado(
        textoRedistribuicao("Falta registada.", res, "Não havia tarefas para hoje.")
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
              Adicionar funcionário
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
              className="h-11 md:h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
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
              className="h-11 md:h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Filtrar por role"
            >
              <option value="todos">Função: Todas</option>
              <option value="staff">Função: Equipa</option>
              <option value="gestor">Função: Gestor</option>
              <option value="parceiro">Função: Proprietário</option>
            </select>
          </div>

          {/* Formulário inline de criação */}
          {mostrarForm && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-5 w-5 text-brand-text" />
                  Novo funcionário
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
                        Palavra-passe
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
                          aria-label={showFormPassword ? "Ocultar palavra-passe" : "Mostrar palavra-passe"}
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
                        placeholder="900 000 000"
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
                        className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="staff">Equipa (limpezas)</option>
                        <option value="gestor">Responsável (gere a equipa)</option>
                        <option value="parceiro">Proprietário (B2B externo — cria reservas)</option>
                        <option value="fornecedor">Lavandaria (gestão de roupa)</option>
                      </select>
                      {form.role === "parceiro" && (
                        <p className="text-xs text-muted-foreground">
                          Os proprietários são externos: não têm folgas semanais nem responsável hierárquico.
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
                          className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                                    ? "border-primary bg-primary/10 text-brand-text"
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
                                  <Badge variant="outline" className="text-xs">
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
                    aria-label="Equipa exclusiva"
                  />
                </div>

                  {/* FIX (atribuição bidirecional fornecedor) — Multi-select de
                      propriedades atribuídas, só visível se role === 'fornecedor'. */}
                  {form.role === "fornecedor" && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">
                        Propriedades Atribuídas (Lavandaria)
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Seleciona as propriedades que esta lavandaria irá servir.
                        O fornecedor só vê as tarefas das propriedades atribuídas.
                      </p>
                      {propriedades.length === 0 ? (
                        <p className="text-xs italic text-muted-foreground">
                          Sem propriedades disponíveis.
                        </p>
                      ) : (
                        <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border border-input p-2 sm:grid-cols-2">
                          {propriedades
                            .filter((p) => p.ativo || form.propriedades_atribuidas.includes(p._id))
                            .map((p) => {
                            const checked = form.propriedades_atribuidas.includes(p._id);
                            return (
                              <label
                                key={p._id}
                                className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                                  checked
                                    ? "border-primary bg-primary/10 text-brand-text"
                                    : "border-input text-muted-foreground hover:bg-muted/50"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setForm((f) => ({
                                      ...f,
                                      propriedades_atribuidas: e.target.checked
                                        ? [...f.propriedades_atribuidas, p._id]
                                        : f.propriedades_atribuidas.filter((id) => id !== p._id),
                                    }));
                                  }}
                                  className="h-3.5 w-3.5"
                                />
                                <span className="flex-1 truncate" title={p.nome}>{p.nome}</span>
                                {!p.ativo && (
                                  <Badge variant="outline" className="text-xs">
                                    inativa
                                  </Badge>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

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
                        "Guardar elemento da equipa"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setMostrarForm(false);
                        setFormErro(null);
                        setForm({ nome: "", email: "", password: "", role: "staff", responsavel_id: "", dias_folga: [], telefone: "", propriedades_alocadas: [], exclusivo_preferenciais: false, propriedades_atribuidas: [] });
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

          {rgpdMsg && (
            <Card className={rgpdMsg.tipo === "ok" ? "border-emerald-500/50" : "border-destructive/50"}>
              <CardContent
                role="status"
                className={`flex items-center justify-between gap-3 p-3 text-sm ${rgpdMsg.tipo === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
              >
                <span className="min-w-0 break-words">{rgpdMsg.texto}</span>
                <Button variant="ghost" size="sm" onClick={() => setRgpdMsg(null)}>
                  Fechar
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
                  <table className="rt w-full text-sm">
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
                              {u.role === "staff" && coresEquipa.get(u._id) && (
                                <span
                                  aria-hidden="true"
                                  title="Cor no calendário"
                                  className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                                  style={{ backgroundColor: coresEquipa.get(u._id) }}
                                />
                              )}
                              {u.nome}
                              {/* FIX (visualização exclusivo) — Badge visível na
                                  tabela sempre que exclusivo_preferenciais for true. */}
                              {u.exclusivo_preferenciais && (
                                <Badge
                                  variant="outline"
                                  className="gap-1 text-xs"
                                  title="Equipa exclusiva — só recebe tarefas de propriedades onde está na equipa preferencial"
                                >
                                  <Lock className="h-3 w-3" />
                                  Exclusivo
                                </Badge>
                              )}
                              {ausenteTipo === "ferias" && (
                                <Badge variant="destructive" className="text-xs">
                                  De férias
                                </Badge>
                              )}
                              {ausenteTipo === "doenca" && (
                                <Badge variant="destructive" className="text-xs">
                                  Doente
                                </Badge>
                              )}
                              {ausenteTipo &&
                                ausenteTipo !== "ferias" &&
                                ausenteTipo !== "doenca" && (
                                  <Badge variant="destructive" className="text-xs">
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
                                  className="h-11 w-11 md:h-8 md:w-8"
                                  onClick={() => abrirEdicao(u)}
                                  aria-label={`Editar ${u.nome}`}
                                  title="Editar"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                {/* Separador (só telemóvel): afasta as ações de desativar, falta e baixa das de edição */}
                                <span className="ml-3 h-6 w-px shrink-0 bg-border md:hidden" aria-hidden="true" />
                                {/* Ativar/Desativar */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11 md:h-8 md:w-8"
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
                                  className="h-11 w-11 md:h-8 md:w-8 text-amber-500 hover:text-amber-600"
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
                                  className="h-11 w-11 md:h-8 md:w-8 text-blue-500 hover:text-blue-600"
                                  onClick={() => {
                                    setBaixaModal(u);
                                    setBaixaForm({ data_inicio: "", data_fim: "", tipo: "ferias" });
                                    setBaixaResultado(null);
                                  }}
                                  aria-label={`Registar baixa ou férias de ${u.nome}`}
                                  title="Registar Baixa / Férias"
                                >
                                  <CalendarOff className="h-4 w-4" />
                                </Button>
                                {/* RGPD — separado das outras ações */}
                                <span className="ml-3 h-6 w-px shrink-0 bg-border" aria-hidden="true" />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11 md:h-8 md:w-8"
                                  onClick={() => handleExportarDados(u)}
                                  disabled={exportandoId === u._id}
                                  aria-label={`Exportar dados de ${u.nome}`}
                                  title="Exportar dados"
                                >
                                  {exportandoId === u._id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                </Button>
                                {/* Só quem pode: nunca a própria conta; gestores só pelo administrador */}
                                {eu && eu.id !== u._id && (u.role !== "gestor" || eu.role === "admin") && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-11 w-11 text-destructive hover:text-destructive md:h-8 md:w-8"
                                    onClick={() => setApagarDados(u)}
                                    aria-label={`Apagar dados pessoais de ${u.nome}`}
                                    title="Apagar dados pessoais"
                                  >
                                    <ShieldX className="h-4 w-4" />
                                  </Button>
                                )}
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
                <DialogTitle>Editar utilizador</DialogTitle>
                <DialogDescription>
                  Atualiza os dados do funcionário. Deixa a palavra-passe vazia para
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
                    placeholder="900 000 000"
                  />
                </div>
                {editForm.role === "staff" && (
                  <div className="space-y-1.5">
                    <span id="edit-cor-rotulo" className="text-sm font-medium">
                      Cor no calendário
                    </span>
                    <div role="group" aria-labelledby="edit-cor-rotulo" className="flex flex-wrap items-center gap-2">
                      {PALETA_EQUIPA.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={NOME_COR_EQUIPA[c] ?? c}
                          title={NOME_COR_EQUIPA[c] ?? c}
                          aria-pressed={editForm.cor.toLowerCase() === c}
                          onClick={() => setEditForm((f) => ({ ...f, cor: c }))}
                          className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-8 w-8 rounded-full border-2 transition ${editForm.cor.toLowerCase() === c ? "border-foreground ring-2 ring-ring ring-offset-2" : "border-transparent"}`}
                            style={{ backgroundColor: c }}
                          />
                        </button>
                      ))}
                      <button
                        type="button"
                        aria-pressed={editForm.cor === ""}
                        onClick={() => setEditForm((f) => ({ ...f, cor: "" }))}
                        className={`h-11 rounded-full border px-4 text-xs font-medium ${editForm.cor === "" ? "border-foreground bg-muted" : "border-input"}`}
                      >
                        Automática
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      A cor aparece nos cartões do calendário. Automática: a cor é escolhida pela ordem de criação.
                    </p>
                  </div>
                )}
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
                    className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="staff">Equipa (limpezas)</option>
                    <option value="gestor">Responsável (gere a equipa)</option>
                    <option value="parceiro">Proprietário (B2B externo — cria reservas)</option>
                    <option value="fornecedor">Lavandaria (gestão de roupa)</option>
                  </select>
                  {editForm.role === "parceiro" && (
                    <p className="text-xs text-muted-foreground">
                      Os proprietários são externos: não têm folgas semanais nem responsável hierárquico.
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
                      className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                    Nova palavra-passe{" "}
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
                      aria-label={showEditPassword ? "Ocultar palavra-passe" : "Mostrar palavra-passe"}
                    >
                      {showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Útil para redefinir a palavra-passe se o funcionário se esquecer.
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
                    <Calendar className="h-4 w-4 text-brand-text" />
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
                        className="h-11 md:h-9"
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
                        className="h-11 md:h-9"
                        maxLength={200}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-11 md:h-9"
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
                                  ? "border-primary bg-primary/10 text-brand-text"
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
                                <Badge variant="outline" className="text-xs">
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
                    aria-label="Equipa exclusiva"
                  />
                </div>

                {/* FIX (atribuição bidirecional fornecedor) — Multi-select de
                    propriedades atribuídas (edição), só se role === 'fornecedor'. */}
                {editForm.role === "fornecedor" && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">
                      Propriedades Atribuídas (Lavandaria)
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Seleciona as propriedades que esta lavandaria irá servir.
                      O fornecedor só vê as tarefas das propriedades atribuídas.
                    </p>
                    {propriedades.length === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        Sem propriedades disponíveis.
                      </p>
                    ) : (
                      <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border border-input p-2 sm:grid-cols-2">
                        {propriedades
                          .filter((p) => p.ativo || editForm.propriedades_atribuidas.includes(p._id))
                          .map((p) => {
                          const checked = editForm.propriedades_atribuidas.includes(p._id);
                          return (
                            <label
                              key={p._id}
                              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                                checked
                                  ? "border-primary bg-primary/10 text-brand-text"
                                  : "border-input text-muted-foreground hover:bg-muted/50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setEditForm((f) => ({
                                    ...f,
                                    propriedades_atribuidas: e.target.checked
                                      ? [...f.propriedades_atribuidas, p._id]
                                      : f.propriedades_atribuidas.filter((id) => id !== p._id),
                                  }));
                                }}
                                className="h-3.5 w-3.5"
                              />
                              <span className="flex-1 truncate" title={p.nome}>{p.nome}</span>
                              {!p.ativo && (
                                <Badge variant="outline" className="text-xs">
                                  inativa
                                </Badge>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

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
          <ApagarDadosDialog
            pessoa={apagarDados}
            onFechar={() => setApagarDados(null)}
            onConcluido={(texto) => {
              setApagarDados(null);
              setRgpdMsg({ tipo: "ok", texto });
              void carregar();
            }}
          />

          <Dialog
            open={eliminando !== null}
            onOpenChange={(o) => !o && setEliminando(null)}
          >
            <DialogHeader>
              <div>
                <DialogTitle>Eliminar utilizador</DialogTitle>
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
                    Eliminar definitivamente
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
                  Reportar falta súbita
                </DialogTitle>
                <DialogDescription>
                  As tarefas de hoje são reatribuídas automaticamente a colegas disponíveis.
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
                As tarefas de hoje deste funcionário são reatribuídas logo aos
                colegas disponíveis. As que ninguém puder fazer ficam por
                atribuir e os gestores são avisados.
              </p>
              {faltaResultado && (
                <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200">
                  {faltaResultado}
                </div>
              )}
              {faltaResultado && faltaAviso && avisoEmCurso(faltaAviso)}
              {faltaResultado &&
                renderReatribuir(faltaPorAtribuir, "falta")}
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
                  className="bg-status-porat text-status-foreground hover:bg-status-porat/90"
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
                      Confirmar falta
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
                  As tarefas do período são reatribuídas automaticamente a colegas disponíveis.
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
                  <div className="space-y-1.5">
                    <label htmlFor="baixa-tipo" className="text-sm font-medium">
                      Tipo
                    </label>
                    <select
                      id="baixa-tipo"
                      value={baixaForm.tipo}
                      onChange={(e) => setBaixaForm((f) => ({ ...f, tipo: e.target.value }))}
                      className="flex h-11 md:h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="ferias">Férias</option>
                      <option value="doenca">Baixa (doença)</option>
                      <option value="falta">Falta</option>
                      <option value="outro">Outro</option>
                    </select>
                  </div>
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
                    As tarefas atribuídas a este funcionário no período são
                    reatribuídas logo aos colegas disponíveis. As que ninguém
                    puder fazer ficam por atribuir e os gestores são avisados.
                  </p>
                </>
              ) : (
                <>
                  <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 p-3 text-sm text-blue-800 dark:text-blue-200">
                    {baixaResultado}
                  </div>
                  {baixaAviso && avisoEmCurso(baixaAviso)}
                  {renderReatribuir(baixaPorAtribuir, "baixa")}
                </>
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
                  className="bg-status-atrib text-status-foreground hover:bg-status-atrib/90"
                  disabled={
                    !baixaForm.data_inicio ||
                    !baixaForm.data_fim ||
                    baixaSubmitting
                  }
                  onClick={async () => {
                    if (!baixaModal) return;
                    setBaixaSubmitting(true);
                    setBaixaPorAtribuir(0);
                    setBaixaAviso(null);
                    setAutoTentou(false);
                    setAutoErro(null);
                    try {
                      const res = await adminPost<RedistribuicaoDTO>(`/api/gestor/equipa/${baixaModal._id}/baixa`, {
                        data_inicio: baixaForm.data_inicio,
                        data_fim: baixaForm.data_fim,
                        tipo: baixaForm.tipo,
                      });
                      setBaixaPorAtribuir(tarefasPorAtribuir(res));
                      setBaixaAviso(res.aviso ?? null);
                      setBaixaResultado(
                        textoRedistribuicao("Baixa registada.", res, "Não havia tarefas no período.")
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
                      Confirmar ausência
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
