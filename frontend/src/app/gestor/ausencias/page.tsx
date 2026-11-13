"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarOff,
  Loader2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Plane,
  Stethoscope,
  CalendarX,
  CircleDot,
  Check,
  X,
  Plus,
  Filter,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
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
  adminGet,
  adminDelete,
  adminPatch,
  adminPost,
  type AusenciaDTO,
  type UtilizadorDTO,
} from "@/lib/api";
import { parsearDataSegura, textoRedistribuicao, type RedistribuicaoDTO, plural } from "@/lib/utils";
import { mensagemErro } from "@/lib/rascunho-staff";

/**
 * /gestor/ausencias — Ecrã de Férias/Ausências (Prompt 95 / Fase 1.5).
 *
 * View única (sem Tabs) com:
 *   - Lista de Ausências (com filtros de Estado e Mês).
 *   - Painel inferior de Folgas Fixas da equipa.
 *
 * FIX (ui ausências) — Unificação das Tabs numa só view + filtros default +
 *   correção do estado exibido (ausências com data_fim anterior a hoje são
 *   mostradas como "Concluída"/"Passada" em vez de "Aprovada"/"Agendada").
 */

// Alargamento local do TipoAusencia (o backend usa mais valores que o tipo
// estrito do api.ts: ferias, doenca, folga, outro).
type TipoAusenciaAmp = "ferias" | "doenca" | "folga_rotativa" | "folga" | "falta" | "outro";

interface AusenciaAmp extends Omit<AusenciaDTO, "tipo"> {
  tipo: TipoAusenciaAmp;
  estado?: string;
  notas?: string;
  /** Justificação dada por quem pediu (a coluna Notas só mostrava `notas`). */
  justificacao?: string;
}

const TIPO_LABEL: Record<TipoAusenciaAmp, string> = {
  ferias: "Férias",
  doenca: "Doença",
  folga_rotativa: "Folga Rotativa",
  folga: "Folga",
  falta: "Falta",
  outro: "Outro",
};

const TIPO_ICON: Record<TipoAusenciaAmp, React.ComponentType<{ className?: string }>> = {
  ferias: Plane,
  doenca: Stethoscope,
  folga_rotativa: CalendarX,
  folga: CalendarX,
  falta: CalendarX,
  outro: CircleDot,
};

const ESTADO_LABEL: Record<string, string> = {
  pendente: "Pendente",
  pendente_emergencia: "Emergência",
  aprovada: "Aprovada",
  rejeitada: "Rejeitada",
  // Prompt 131b — soft cancel mantém histórico.
  cancelada: "Cancelada",
};

const ESTADO_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  pendente: "warning",
  pendente_emergencia: "destructive",
  aprovada: "success",
  rejeitada: "secondary",
  cancelada: "outline",
};

/**
 * FIX (lógica de status) — Resolve o estado EXIBIDO de uma ausência.
 * Se a data_fim for anterior ao dia de hoje, a ausência já terminou:
 *   - aprovada  → "Concluída"
 *   - pendente / pendente_emergencia → "Passada"
 * Caso contrário, usa o estado real do backend.
 */
function resolverEstadoExibido(a: AusenciaAmp): { label: string; variant: string } {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fim = parsearDataSegura(a.data_fim);
  const passada = fim ? fim.getTime() < hoje.getTime() : false;
  const est = a.estado ?? "";

  if (passada) {
    if (est === "aprovada") return { label: "Concluída", variant: "success" };
    if (est === "pendente" || est === "pendente_emergencia")
      return { label: "Passada", variant: "secondary" };
    if (est === "rejeitada") return { label: "Rejeitada", variant: "secondary" };
    if (est === "cancelada") return { label: "Cancelada", variant: "outline" };
  }
  return {
    label: ESTADO_LABEL[est] ?? est ?? "—",
    variant: ESTADO_VARIANT[est] ?? "secondary",
  };
}

function formatarData(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    return d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatarPeriodo(inicio: string, fim: string): string {
  const i = formatarData(inicio);
  const f = formatarData(fim);
  return i === f ? i : `${i} → ${f}`;
}

export default function AusenciasPage() {
  const [ausencias, setAusencias] = useState<AusenciaAmp[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  // Resultado de aprovar/rejeitar (texto da redistribuição + aviso de limpezas em curso).
  const [resultado, setResultado] = useState<{ texto: string; aviso: string | null } | null>(null);

  // FIX (filtros) — Filtros de Estado e Mês (aplicados client-side).
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");
  const [filtroMes, setFiltroMes] = useState<string>(""); // YYYY-MM ou vazio

  // Modal de confirmação de eliminação.
  const [aEliminar, setAEliminar] = useState<AusenciaAmp | null>(null);
  const [eliminando, setEliminando] = useState(false);

  // Prompt 131b — Modal de confirmação de cancelamento (soft cancel).
  const [aCancelar, setACancelar] = useState<AusenciaAmp | null>(null);
  const [cancelando, setCancelando] = useState(false);

  // HF20 — Modal de criação de ausência (Date Range Picker).
  const [mostrarForm, setMostrarForm] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [equipa, setEquipa] = useState<UtilizadorDTO[]>([]);
  const [form, setForm] = useState({
    utilizador_id: "",
    data_inicio: "",
    data_fim: "",
    tipo: "ferias" as TipoAusenciaAmp,
    notas: "",
  });

  // FIX (gestão de folgas) — Estado para a secção "Folgas Fixas".
  // Lista os staff ativos com os seus dias_folga fixos (0=Dom, 6=Sáb).
  const [folgasStaff, setFolgasStaff] = useState<UtilizadorDTO[]>([]);
  const [folgasLoading, setFolgasLoading] = useState(false);
  const [folgasErro, setFolgasErro] = useState<string | null>(null);

  /** Nomes dos dias da semana (0=Dom, 6=Sáb). */
  const DIA_SEMANA_NOMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      // Sem filtros → devolve TODAS as ausências da empresa.
      const data = await adminGet<{ ausencias: AusenciaAmp[] }>(
        "/api/gestor/ausencias"
      );
      setAusencias(data.ausencias ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar ausências.");
    } finally {
      setLoading(false);
    }
  }, []);

  /** FIX (gestão de folgas) — Carrega staff ativo com dias_folga. */
  async function carregarFolgas() {
    setFolgasLoading(true);
    setFolgasErro(null);
    try {
      const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
        "/api/gestor/equipa"
      );
      // Só staff ativo (não gestor/admin/parceiro, não inativo).
      setFolgasStaff(
        (data.utilizadores ?? []).filter(
          (u) => u.role === "staff" && u.ativo
        )
      );
    } catch (e) {
      setFolgasErro(e instanceof Error ? e.message : "Erro ao carregar folgas.");
    } finally {
      setFolgasLoading(false);
    }
  }

  // Vindo do calendário (/gestor/ausencias?pedido=<id>): destaca esse pedido e leva-o para o ecrã.
  const [destacar, setDestacar] = useState<string | null>(null);
  useEffect(() => {
    setDestacar(new URLSearchParams(window.location.search).get("pedido"));
  }, []);
  useEffect(() => {
    if (!destacar || loading) return;
    const alvo = [...document.querySelectorAll<HTMLElement>(`[data-ausencia="${CSS.escape(destacar)}"]`)].find((el) => el.offsetParent !== null);
    alvo?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [destacar, loading, ausencias]);

  useEffect(() => {
    carregar();
    // FIX (gestão de folgas) — Carrega também as folgas ao montar a página.
    carregarFolgas();
  }, [carregar]);

  // FIX (filtros) — Aplica filtros de Estado e Mês (client-side).
  const ausenciasFiltradas = useMemo(() => {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    return ausencias.filter((a) => {
      // Filtro de mês (compara YYYY-MM da data_inicio).
      if (filtroMes) {
        const inicio = parsearDataSegura(a.data_inicio);
        if (!inicio) return false;
        const mesStr =
          `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, "0")}`;
        if (mesStr !== filtroMes) return false;
      }

      // Filtro de estado (com resolução de "Passada"/"Concluída").
      if (filtroEstado !== "todos") {
        const fim = parsearDataSegura(a.data_fim);
        const passada = fim ? fim.getTime() < hoje.getTime() : false;
        const est = a.estado ?? "";

        if (filtroEstado === "passada") {
          // Passada = já terminou e era aprovada/pendente.
          if (!passada) return false;
          if (est !== "aprovada" && est !== "pendente" && est !== "pendente_emergencia")
            return false;
          return true;
        }
        if (filtroEstado === "aprovada") {
          // Aprovada (não passada) = aprovada e ainda em curso.
          if (est !== "aprovada") return false;
          if (passada) return false;
          return true;
        }
        if (filtroEstado === "pendente") {
          if (est !== "pendente" && est !== "pendente_emergencia") return false;
          if (passada) return false;
          return true;
        }
        if (est !== filtroEstado) return false;
      }
      return true;
    });
  }, [ausencias, filtroEstado, filtroMes]);

  async function handleEliminar() {
    if (!aEliminar) return;
    setEliminando(true);
    try {
      // Otimismo: remove da UI imediatamente.
      setAusencias((prev) => prev.filter((a) => a._id !== aEliminar._id));
      await adminDelete(`/api/gestor/ausencias/${aEliminar._id}`);
      setAEliminar(null);
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(e instanceof Error ? e.message : "Erro ao eliminar ausência.");
    } finally {
      setEliminando(false);
    }
  }

  // O resultado fica visível 20 s (30 s se houver aviso de limpeza em curso) ou até ser fechado.
  useEffect(() => {
    if (!resultado) return;
    const t = setTimeout(() => setResultado(null), resultado.aviso ? 30000 : 20000);
    return () => clearTimeout(t);
  }, [resultado]);

  /** Aprovar / Rejeitar ausência pendente (PATCH .../estado). */
  async function handleMudarEstado(a: AusenciaAmp, novoEstado: "aprovada" | "rejeitada") {
    // Otimismo: atualiza a UI imediatamente.
    setAusencias((prev) =>
      prev.map((x) => (x._id === a._id ? { ...x, estado: novoEstado } : x))
    );
    setErro(null);
    setResultado(null);
    try {
      const res = await adminPatch<{ redistribuicao?: RedistribuicaoDTO | null }>(
        `/api/gestor/ausencias/${a._id}/estado`,
        { estado: novoEstado }
      );
      if (novoEstado === "aprovada") {
        const rd = res?.redistribuicao ?? null;
        setResultado({
          texto: textoRedistribuicao("Ausência aprovada.", rd, "Sem tarefas para desatribuir no período."),
          aviso: rd?.aviso ?? null,
        });
      } else {
        setResultado({ texto: "Pedido rejeitado.", aviso: null });
      }
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(mensagemErro(e, `Erro ao ${novoEstado === "aprovada" ? "aprovar" : "rejeitar"} ausência.`));
    }
  }

  /**
   * Prompt 131b — Cancela (soft cancel) uma ausência pendente ou aprovada.
   * Usa PATCH /api/gestor/ausencias/:id/cancelar (mantém o registo para
   * histórico, ao contrário do DELETE que apaga o registo).
   */
  async function handleCancelar() {
    if (!aCancelar) return;
    setCancelando(true);
    try {
      // Otimismo: atualiza a UI imediatamente.
      setAusencias((prev) =>
        prev.map((x) =>
          x._id === aCancelar._id ? { ...x, estado: "cancelada" } : x
        )
      );
      await adminPatch(`/api/gestor/ausencias/${aCancelar._id}/cancelar`);
      setACancelar(null);
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(e instanceof Error ? e.message : "Erro ao cancelar ausência.");
      setACancelar(null);
    } finally {
      setCancelando(false);
    }
  }

  /** HF20 — Abre o modal de criação e carrega a equipa. */
  async function abrirFormCriacao() {
    setMostrarForm(true);
    setFormErro(null);
    setForm({
      utilizador_id: "",
      data_inicio: "",
      data_fim: "",
      tipo: "ferias",
      notas: "",
    });
    // Carrega a equipa se ainda não foi carregada.
    if (equipa.length === 0) {
      try {
        const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
          "/api/gestor/equipa"
        );
        setEquipa(
          (data.utilizadores ?? []).filter(
            (u) => u.role === "staff" && u.ativo
          )
        );
      } catch {
        // Não bloqueia — o select fica vazio.
      }
    }
  }

  /** HF20 — Submete a nova ausência (intervalo de datas). */
  async function handleCriarAusencia() {
    if (!form.utilizador_id || !form.data_inicio || !form.data_fim) {
      setFormErro("Elemento da equipa, Data de Início e Data de Fim são obrigatórios.");
      return;
    }
    if (form.data_fim < form.data_inicio) {
      setFormErro("Data de Fim não pode ser anterior à Data de Início.");
      return;
    }
    setSubmitting(true);
    setFormErro(null);
    try {
      await adminPost("/api/gestor/ausencias", {
        utilizador_id: form.utilizador_id,
        data_inicio: form.data_inicio,
        data_fim: form.data_fim,
        tipo: form.tipo,
        notas: form.notas || undefined,
      });
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar ausência.");
    } finally {
      setSubmitting(false);
    }
  }

  /** Ações da ausência (iguais na tabela e nos cartões; `tam` ajusta o alvo de toque). */
  function acoesAusencia(a: AusenciaAmp, jaPassada: boolean, tam: string) {
    return (
      <>
{/* Aprovar / Rejeitar (só para pendentes não passadas) */}
                            {(a.estado === "pendente" || a.estado === "pendente_emergencia") && !jaPassada && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={`${tam} text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50`}
                                  onClick={() => handleMudarEstado(a, "aprovada")}
                                  aria-label="Aprovar"
                                  title="Aprovar"
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={`${tam} text-destructive hover:text-destructive hover:bg-destructive/10`}
                                  onClick={() => handleMudarEstado(a, "rejeitada")}
                                  aria-label="Rejeitar"
                                  title="Rejeitar"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            {/* Prompt 131b — Cancelar (soft cancel).
                                Só para pendentes ou aprovadas (não rejeitadas/canceladas).
                                Usa X icon com cor âmbar para distinguir do Rejeitar (vermelho). */}
                            {(a.estado === "pendente" || a.estado === "aprovada") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className={`${tam} text-amber-600 hover:text-amber-700 hover:bg-amber-50`}
                                onClick={() => setACancelar(a)}
                                aria-label="Cancelar ausência"
                                title="Cancelar (mantém no histórico)"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                            {/* Eliminar (hard delete) */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className={`${tam} text-destructive hover:text-destructive`}
                              onClick={() => setAEliminar(a)}
                              aria-label="Eliminar ausência"
                              title="Eliminar (apaga definitivamente)"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarOff className="h-6 w-6 text-brand-text" />
            Ausências / Férias
          </h1>
          <p className="text-sm text-muted-foreground">
            Todas as ausências da empresa (férias, doença, folgas, emergências).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={abrirFormCriacao}>
            <Plus className="h-4 w-4" />
            Nova ausência
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {resultado && (
        <div className="flex flex-col gap-2" role="status">
          <div className="flex items-start gap-2 rounded-md border border-emerald-600/40 bg-emerald-50 p-3 text-sm font-medium text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
            <span className="flex-1">{resultado.texto}</span>
            <button
              type="button"
              onClick={() => setResultado(null)}
              className="shrink-0 underline underline-offset-2"
            >
              Fechar
            </button>
          </div>
          {resultado.aviso && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{resultado.aviso}</span>
            </div>
          )}
        </div>
      )}

      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {erro}
          </CardContent>
        </Card>
      )}

      {destacar && !loading && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm">
          <span>
            {(() => {
              const alvo = ausencias.find((a) => a._id === destacar);
              if (!alvo) return "Esse pedido já não existe (foi apagado).";
              if (alvo.estado === "pendente" || alvo.estado === "pendente_emergencia") {
                return "Pedido aberto a partir do calendário (destacado na lista). Aprova ou rejeita na coluna Ações.";
              }
              const decisao: Record<string, string> = { aprovada: "aprovado", rejeitada: "rejeitado", cancelada: "cancelado" };
              const palavra = decisao[alvo.estado ?? ""];
              if (!palavra) return "Pedido aberto a partir do calendário (destacado na lista).";
              // O registo não guarda quem decidiu; a data é a da última alteração do pedido.
              const quando = alvo.updatedAt ? new Date(alvo.updatedAt) : null;
              const quandoTxt = quando && !isNaN(quando.getTime()) ? ` em ${quando.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
              return `Este pedido já foi ${palavra}${quandoTxt}. Já não há nada para decidir aqui.`;
            })()}
          </span>
          <Button variant="outline" size="sm" onClick={() => setDestacar(null)}>Fechar aviso</Button>
        </div>
      )}

      {/* FIX (filtros) — Barra de filtros Estado + Mês (view única, sem Tabs). */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter className="h-4 w-4" />
            <span className="font-medium">Filtros:</span>
          </div>
          <select
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
            className="h-11 rounded-md border border-input bg-background px-3 text-sm md:h-9 ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filtrar por estado"
          >
            <option value="todos">Estado: Todos</option>
            <option value="pendente">Pendentes (por aprovar)</option>
            <option value="aprovada">Aprovadas (em curso)</option>
            <option value="passada">Passadas / Concluídas</option>
            <option value="rejeitada">Rejeitadas</option>
            <option value="cancelada">Canceladas</option>
          </select>
          <Input
            type="month"
            value={filtroMes}
            onChange={(e) => setFiltroMes(e.target.value)}
            className="h-11 w-[180px] md:h-9"
            aria-label="Filtrar por mês"
          />
          {(filtroEstado !== "todos" || filtroMes) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFiltroEstado("todos");
                setFiltroMes("");
              }}
            >
              Limpar filtros
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {ausenciasFiltradas.length} de {plural(ausencias.length, "ausência")}
          </span>
        </CardContent>
      </Card>

      {/* Tabela de ausências */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarOff className="h-4 w-4 text-brand-text" />
            Ausências Registadas ({ausenciasFiltradas.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : ausenciasFiltradas.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <CalendarOff className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {ausencias.length === 0
                  ? "Sem ausências registadas."
                  : "Nenhuma ausência corresponde aos filtros selecionados."}
              </p>
            </div>
          ) : (
            <>
            {/* Telemóvel: cartões (sem scroll horizontal) */}
            <ul className="divide-y md:hidden" aria-label="Ausências">
              {ausenciasFiltradas.map((a) => {
                const TipoIcon = TIPO_ICON[a.tipo] ?? CircleDot;
                const estadoExibido = resolverEstadoExibido(a);
                const hoje = new Date();
                hoje.setHours(0, 0, 0, 0);
                const fim = parsearDataSegura(a.data_fim);
                const jaPassada = fim ? fim.getTime() < hoje.getTime() : false;
                return (
                  <li key={a._id} data-ausencia={a._id} className={`space-y-2 py-3${destacar === a._id ? " rounded-md bg-primary/10 px-2 ring-2 ring-primary" : ""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words font-medium">{a.utilizador?.nome ?? "—"}</p>
                      <div className="shrink-0">
                        <Badge
                          variant={
                            (estadoExibido.variant as "default" | "secondary" | "success" | "warning" | "destructive" | "outline") ?? "secondary"
                          }
                        >
                          {estadoExibido.label}
                        </Badge>
                        {jaPassada && a.estado === "aprovada" && (
                          <span className="ml-1 text-xs text-muted-foreground">(terminou)</span>
                        )}
                      </div>
                    </div>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <TipoIcon className="h-4 w-4 shrink-0" />
                      {TIPO_LABEL[a.tipo] ?? a.tipo} · {formatarPeriodo(a.data_inicio, a.data_fim)}
                    </p>
                    {(a.notas || a.justificacao) && (
                      <p className="break-words text-sm text-muted-foreground">
                        {a.notas || `Justificação: ${a.justificacao}`}
                      </p>
                    )}
                    <div className="flex items-center justify-end gap-1">{acoesAusencia(a, jaPassada, "h-11 w-11")}</div>
                  </li>
                );
              })}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="rt w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Equipa</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    <th className="px-4 py-3 font-medium">Período</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Notas</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ausenciasFiltradas.map((a) => {
                    const TipoIcon = TIPO_ICON[a.tipo] ?? CircleDot;
                    // FIX (lógica de status) — Resolve estado exibido (Passada/Concluída).
                    const estadoExibido = resolverEstadoExibido(a);
                    const hoje = new Date();
                    hoje.setHours(0, 0, 0, 0);
                    const fim = parsearDataSegura(a.data_fim);
                    const jaPassada = fim ? fim.getTime() < hoje.getTime() : false;
                    return (
                      <tr key={a._id} data-ausencia={a._id} className={`hover:bg-muted/30${destacar === a._id ? " bg-primary/10 outline outline-2 -outline-offset-2 outline-primary" : ""}`}>
                        <td className="px-4 py-3 font-medium">
                          {a.utilizador?.nome ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5">
                            <TipoIcon className="h-4 w-4 text-muted-foreground" />
                            {TIPO_LABEL[a.tipo] ?? a.tipo}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatarPeriodo(a.data_inicio, a.data_fim)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              (estadoExibido.variant as "default" | "secondary" | "success" | "warning" | "destructive" | "outline") ?? "secondary"
                            }
                          >
                            {estadoExibido.label}
                          </Badge>
                          {jaPassada && a.estado === "aprovada" && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              (terminou)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          {a.notas || a.justificacao ? (
                            <span
                              className="line-clamp-2 text-muted-foreground"
                              title={a.notas || `Justificação: ${a.justificacao}`}
                            >
                              {a.notas || `Justificação: ${a.justificacao}`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">{acoesAusencia(a, jaPassada, "h-8 w-8")}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* FIX (gestão de folgas) — Painel inferior de Folgas Fixas (view única). */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarX className="h-5 w-5 text-brand-text" />
            Folgas Fixas da Equipa
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground mb-4">
            Funcionários ativos (staff) e os respetivos dias de folga fixos
            semanais. Para editar, vai à página{" "}
            <a href="/gestor/equipa" className="text-brand-text underline">
              Equipa
            </a>
            .
          </p>

          {folgasLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />A carregar…
            </div>
          ) : folgasErro ? (
            <div className="flex items-center gap-2 py-8 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />{folgasErro}
            </div>
          ) : folgasStaff.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Não há staff ativo na equipa.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="rt w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">Dias de Folga</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {folgasStaff.map((staff) => {
                    const folgas = staff.dias_folga ?? [];
                    return (
                      <tr key={staff._id} className="hover:bg-muted/30">
                        {/* FIX (links folgas fixas) — Nome do funcionário é
                            clicável, abre o modal de edição do staff. */}
                        <td className="px-4 py-3 font-medium">
                          <Link
                            href={`/gestor/equipa?editar=${staff._id}`}
                            className="text-brand-text underline-offset-2 hover:underline"
                            title={`Editar ${staff.nome}`}
                          >
                            {staff.nome}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          {folgas.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {folgas
                                .slice()
                                .sort((a, b) => a - b)
                                .map((dia) => (
                                  <Badge key={dia} variant="outline" className="text-xs">
                                    {DIA_SEMANA_NOMES[dia] ?? `?${dia}`}
                                  </Badge>
                                ))}
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
        </CardContent>
      </Card>

      {/* Modal de confirmação de eliminação */}
      <Dialog
        open={aEliminar !== null}
        onOpenChange={(o) => !o && setAEliminar(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Eliminar ausência
            </DialogTitle>
            <DialogDescription>
              Tens a certeza que queres eliminar esta ausência? Esta ação é
              permanente.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setAEliminar(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aEliminar && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p>
                <strong>Equipa:</strong>{" "}
                {aEliminar.utilizador?.nome ?? "—"}
              </p>
              <p>
                <strong>Tipo:</strong> {TIPO_LABEL[aEliminar.tipo] ?? aEliminar.tipo}
              </p>
              <p>
                <strong>Período:</strong>{" "}
                {formatarPeriodo(aEliminar.data_inicio, aEliminar.data_fim)}
              </p>
              {aEliminar.notas && (
                <p>
                  <strong>Notas:</strong> {aEliminar.notas}
                </p>
              )}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAEliminar(null)}
            disabled={eliminando}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleEliminar}
            disabled={eliminando}
          >
            {eliminando ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A eliminar…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                Eliminar
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 131b — Modal de confirmação de cancelamento (soft cancel).
          Mantém o registo no histórico (apenas marca estado='cancelada'). */}
      <Dialog
        open={aCancelar !== null}
        onOpenChange={(o) => !o && !cancelando && setACancelar(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <X className="h-5 w-5 text-amber-600" />
              Cancelar ausência
            </DialogTitle>
            <DialogDescription>
              Vais cancelar esta ausência. O registo fica marcado como
              <strong> cancelada</strong> (mantém-se no histórico para
              auditoria). Se a ausência estava aprovada, as vagas que ficaram
              por preencher (de hoje em diante) são preenchidas automaticamente.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !cancelando && setACancelar(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aCancelar && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p>
                <strong>Equipa:</strong>{" "}
                {aCancelar.utilizador?.nome ?? "—"}
              </p>
              <p>
                <strong>Tipo:</strong> {TIPO_LABEL[aCancelar.tipo] ?? aCancelar.tipo}
              </p>
              <p>
                <strong>Período:</strong>{" "}
                {formatarPeriodo(aCancelar.data_inicio, aCancelar.data_fim)}
              </p>
              <p>
                <strong>Estado atual:</strong>{" "}
                {(() => {
                  const e = resolverEstadoExibido(aCancelar);
                  return e.label;
                })()}
              </p>
              {aCancelar.notas && (
                <p>
                  <strong>Notas:</strong> {aCancelar.notas}
                </p>
              )}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setACancelar(null)}
            disabled={cancelando}
          >
            Voltar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleCancelar}
            disabled={cancelando}
          >
            {cancelando ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A cancelar…
              </>
            ) : (
              <>
                <X className="mr-2 h-4 w-4" />
                Cancelar ausência
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* HF20 — Modal de criação de ausência (Date Range Picker) */}
      <Dialog
        open={mostrarForm}
        onOpenChange={(o) => !o && !submitting && setMostrarForm(false)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-brand-text" />
              Nova ausência
            </DialogTitle>
            <DialogDescription>
              Regista um período de férias, doença ou outra ausência para um
              funcionário.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !submitting && setMostrarForm(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {/* Funcionário */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Equipa</label>
            <select
              value={form.utilizador_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, utilizador_id: e.target.value }))
              }
              className="flex h-11 md:h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Selecionar funcionário…</option>
              {equipa.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.nome}
                </option>
              ))}
            </select>
          </div>

          {/* Data de Início + Data de Fim (Date Range Picker) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Data de Início</label>
              <Input
                type="date"
                value={form.data_inicio}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_inicio: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Data de Fim</label>
              <Input
                type="date"
                value={form.data_fim}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_fim: e.target.value }))
                }
              />
            </div>
          </div>

          {/* Tipo */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Tipo</label>
            <select
              value={form.tipo}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  tipo: e.target.value as TipoAusenciaAmp,
                }))
              }
              className="flex h-11 md:h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="ferias">Férias</option>
              <option value="doenca">Doença</option>
              <option value="folga_rotativa">Folga Rotativa</option>
              <option value="falta">Falta</option>
              <option value="outro">Outro</option>
            </select>
          </div>

          {/* Notas */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Notas (opcional)</label>
            <Input
              type="text"
              placeholder="Ex.: Férias pagas, baixa médica…"
              value={form.notas}
              onChange={(e) =>
                setForm((f) => ({ ...f, notas: e.target.value }))
              }
              maxLength={200}
            />
          </div>

          {formErro && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formErro}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarForm(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleCriarAusencia}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A criar…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Criar ausência
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
