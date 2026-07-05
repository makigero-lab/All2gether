"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarRange,
  Loader2,
  AlertCircle,
  RefreshCw,
  MapPin,
  Clock,
  User,
  X,
} from "lucide-react";
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  addMonths,
} from "date-fns";
import { pt } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminGet, adminPatch, type PropriedadeDTO, type UtilizadorDTO } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface TarefaCalendario {
  _id: string;
  propriedade_id: { _id: string; nome: string; morada?: string } | null;
  utilizador_id: { _id: string; nome: string } | null;
  data: string;
  tempo_limpeza_minutos: number;
  tipo: string;
  estado: string;
  observacoes?: string;
}

interface FiltrosState {
  propriedadeId: string;
  utilizadorId: string;
  estado: string;
}

const ESTADO_OPTS = [
  { value: "", label: "Todos os estados" },
  { value: "por_atribuir", label: "Por atribuir" },
  { value: "atribuida", label: "Atribuída" },
  { value: "em_curso", label: "Em curso" },
  { value: "concluida", label: "Concluída" },
  { value: "cancelada", label: "Cancelada" },
];

const DIAS_SEMANA = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

/* ------------------------------------------------------------------ */
/* Helpers de estilo por estado                                        */
/* ------------------------------------------------------------------ */

function estiloPorEstado(estado: string): string {
  switch (estado) {
    case "por_atribuir":
      return "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15";
    case "atribuida":
    case "em_curso":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/15";
    case "concluida":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/15";
    case "cancelada":
      return "bg-muted/40 text-muted-foreground border-muted line-through opacity-60";
    default:
      return "bg-muted/40 text-muted-foreground border-muted";
  }
}

function nomeCurto(nome: string | undefined, max = 14): string {
  if (!nome) return "—";
  return nome.length > max ? nome.slice(0, max) + "…" : nome;
}

function primeiroNome(nome: string | undefined): string {
  if (!nome) return "";
  return nome.split(" ")[0];
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function CalendarioOperacionalPage() {
  const [mesAtual, setMesAtual] = useState(new Date());
  const [filtros, setFiltros] = useState<FiltrosState>({
    propriedadeId: "",
    utilizadorId: "",
    estado: "",
  });

  const [tarefas, setTarefas] = useState<TarefaCalendario[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [equipa, setEquipa] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Modal de detalhe.
  const [tarefaSelecionada, setTarefaSelecionada] = useState<TarefaCalendario | null>(null);
  const [reatribuindoPara, setReatribuindoPara] = useState<string>("");
  const [reatribuindo, setReatribuindo] = useState(false);

  /* --- Carregar propriedades + equipa (uma vez) --- */
  const carregarFiltros = useCallback(async () => {
    try {
      const [propRes, equipaRes] = await Promise.all([
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/gestor/propriedades"),
        adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
      ]);
      setPropriedades((propRes.propriedades ?? []).filter((p) => p.ativo));
      setEquipa(
        (equipaRes.utilizadores ?? []).filter(
          (u) => u.role === "staff" || u.role === "gestor"
        )
      );
    } catch (e) {
      // Não bloqueia o calendário se os filtros falharem.
      console.error("Erro ao carregar filtros:", e);
    }
  }, []);

  useEffect(() => {
    carregarFiltros();
  }, [carregarFiltros]);

  /* --- Carregar tarefas do mês + filtros --- */
  const carregarTarefas = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const inicio = format(startOfMonth(mesAtual), "yyyy-MM-dd");
      const fim = format(endOfMonth(mesAtual), "yyyy-MM-dd");
      const params = new URLSearchParams({ inicio, fim });
      if (filtros.propriedadeId) params.set("propriedadeId", filtros.propriedadeId);
      if (filtros.utilizadorId) params.set("utilizadorId", filtros.utilizadorId);
      if (filtros.estado) params.set("estado", filtros.estado);

      const res = await adminGet<{ tarefas: TarefaCalendario[] }>(
        `/api/gestor/calendario/dados?${params.toString()}`
      );
      setTarefas(res.tarefas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar calendário.");
    } finally {
      setLoading(false);
    }
  }, [mesAtual, filtros]);

  // Recarrega quando o mês ou os filtros mudam.
  useEffect(() => {
    carregarTarefas();
  }, [carregarTarefas]);

  /* --- Grelha de dias --- */
  const dias = useMemo(() => {
    const inicio = startOfWeek(startOfMonth(mesAtual), { weekStartsOn: 1 });
    const fim = endOfWeek(endOfMonth(mesAtual), { weekStartsOn: 1 });
    return eachDayOfInterval({ start: inicio, end: fim });
  }, [mesAtual]);

  /* --- Agrupar tarefas por dia --- */
  const tarefasPorDia = useMemo(() => {
    const mapa = new Map<string, TarefaCalendario[]>();
    for (const t of tarefas) {
      const key = format(parseISO(t.data), "yyyy-MM-dd");
      if (!mapa.has(key)) mapa.set(key, []);
      mapa.get(key)!.push(t);
    }
    return mapa;
  }, [tarefas]);

  /* --- Reatribuição rápida --- */
  async function handleReatribuir() {
    if (!tarefaSelecionada || !reatribuindoPara) return;
    setReatribuindo(true);
    try {
      await adminPatch(`/api/gestor/tarefas/${tarefaSelecionada._id}/atribuir`, {
        utilizador_id: reatribuindoPara,
      });
      // Atualiza localmente a tarefa no estado.
      const novoStaff = equipa.find((u) => u._id === reatribuindoPara);
      setTarefas((prev) =>
        prev.map((t) =>
          t._id === tarefaSelecionada._id
            ? {
                ...t,
                utilizador_id: novoStaff
                  ? { _id: novoStaff._id, nome: novoStaff.nome }
                  : null,
                estado: "atribuida",
              }
            : t
        )
      );
      setTarefaSelecionada(null);
      setReatribuindoPara("");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao reatribuir tarefa.");
    } finally {
      setReatribuindo(false);
    }
  }

  const mesAnoLabel = format(mesAtual, "MMMM yyyy", { locale: pt });

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Calendário Operacional</h1>
          <Button
            variant="outline"
            size="icon"
            onClick={carregarTarefas}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Vista mensal de todas as tarefas de limpeza. Filtra por propriedade, staff ou estado.
        </p>
      </div>

      {/* Zona de Filtros */}
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 lg:flex-row lg:items-end lg:justify-between">
        {/* Filtros */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex lg:gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Propriedade</label>
            <select
              value={filtros.propriedadeId}
              onChange={(e) => setFiltros((f) => ({ ...f, propriedadeId: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              <option value="">Todas</option>
              {propriedades.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Staff</label>
            <select
              value={filtros.utilizadorId}
              onChange={(e) => setFiltros((f) => ({ ...f, utilizadorId: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              <option value="">Todos</option>
              <option value="null">Por atribuir</option>
              {equipa.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Estado</label>
            <select
              value={filtros.estado}
              onChange={(e) => setFiltros((f) => ({ ...f, estado: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              {ESTADO_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {(filtros.propriedadeId || filtros.utilizadorId || filtros.estado) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 self-end"
              onClick={() =>
                setFiltros({ propriedadeId: "", utilizadorId: "", estado: "" })
              }
            >
              <X className="h-3.5 w-3.5" />
              Limpar
            </Button>
          )}
        </div>

        {/* Navegação de meses */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMesAtual((m) => addMonths(m, -1))}
            aria-label="Mês anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMesAtual(new Date())}>
            Hoje
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMesAtual((m) => addMonths(m, 1))}
            aria-label="Mês seguinte"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Badge variant="default" className="ml-2 px-3 py-1.5 text-sm capitalize">
            <CalendarRange className="mr-1.5 h-3.5 w-3.5" />
            {mesAnoLabel}
          </Badge>
        </div>
      </div>

      {/* Erro */}
      {erro && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{erro}</span>
          <Button variant="outline" size="sm" onClick={carregarTarefas} className="ml-auto">
            Tentar novamente
          </Button>
        </div>
      )}

      {/* Loading inicial */}
      {loading && tarefas.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar calendário…
        </div>
      ) : (
        <>
          {/* Cabeçalho dos dias da semana */}
          <div className="grid grid-cols-7 gap-2">
            {DIAS_SEMANA.map((d) => (
              <div
                key={d}
                className="py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Grelha do calendário */}
          <div className="grid grid-cols-7 gap-2">
            {dias.map((dia) => {
              const key = format(dia, "yyyy-MM-dd");
              const tarefasDoDia = tarefasPorDia.get(key) ?? [];
              const noMes = isSameMonth(dia, mesAtual);
              const hoje = isToday(dia);

              return (
                <div
                  key={key}
                  className={cn(
                    "min-h-[110px] rounded-lg border p-1.5 transition-colors",
                    noMes ? "bg-card" : "bg-muted/30",
                    hoje && "border-primary ring-1 ring-primary/30"
                  )}
                >
                  <div
                    className={cn(
                      "mb-1 text-right text-xs font-medium",
                      noMes ? "text-muted-foreground" : "text-muted-foreground/50",
                      hoje && "text-primary"
                    )}
                  >
                    {format(dia, "d")}
                  </div>
                  <div className="flex max-h-[120px] flex-col gap-1 overflow-y-auto">
                    {tarefasDoDia.map((t) => {
                      // Folga fixa semanal — bloco cinzento suave.
                      if (t.tipo === "folga_fixa") {
                        return (
                          <div
                            key={t._id}
                            className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-1 text-left text-[11px] leading-tight text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400"
                            title={`Folga semanal — ${t.utilizador_id?.nome ?? "Staff"}`}
                          >
                            <div className="truncate font-medium">
                              Folga — {primeiroNome(t.utilizador_id?.nome)}
                            </div>
                          </div>
                        );
                      }
                      return (
                      <button
                        key={t._id}
                        onClick={() => {
                          setTarefaSelecionada(t);
                          setReatribuindoPara(
                            t.utilizador_id?._id ?? ""
                          );
                        }}
                        className={cn(
                          "rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight transition-all",
                          "hover:shadow-md hover:-translate-y-0.5 hover:z-10",
                          estiloPorEstado(t.estado)
                        )}
                        title={`${t.propriedade_id?.nome ?? "—"}${
                          t.utilizador_id ? " · " + t.utilizador_id.nome : ""
                        }`}
                      >
                        <div className="truncate font-medium">
                          {nomeCurto(t.propriedade_id?.nome)}
                        </div>
                        {t.utilizador_id && (
                          <div className="truncate opacity-80">
                            {primeiroNome(t.utilizador_id.nome)}
                          </div>
                        )}
                      </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legenda */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="font-medium">Legenda:</span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border bg-destructive/10 border-destructive/20" />
              Por atribuir
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border bg-amber-500/10 border-amber-500/20" />
              Atribuída
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border bg-emerald-500/10 border-emerald-500/20" />
              Concluída
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border bg-muted/40 border-muted" />
              Cancelada
            </span>
          </div>
        </>
      )}

      {/* Modal de detalhe + reatribuição */}
      <Dialog
        open={tarefaSelecionada !== null}
        onOpenChange={(o) => !o && setTarefaSelecionada(null)}
      >
        <DialogHeader>
          <DialogTitle>Detalhe da Tarefa</DialogTitle>
          <DialogDescription>
            Informação da tarefa e reatribuição rápida.
          </DialogDescription>
          <DialogClose onClick={() => setTarefaSelecionada(null)} />
        </DialogHeader>
        {tarefaSelecionada && (
          <DialogContent className="space-y-4">
            {/* Estado + propriedade */}
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  tarefaSelecionada.estado === "concluida"
                    ? "default"
                    : tarefaSelecionada.estado === "cancelada"
                    ? "secondary"
                    : tarefaSelecionada.estado === "por_atribuir"
                    ? "destructive"
                    : "outline"
                }
              >
                {ESTADO_OPTS.find((o) => o.value === tarefaSelecionada.estado)?.label ??
                  tarefaSelecionada.estado}
              </Badge>
              <span className="font-medium">
                {tarefaSelecionada.propriedade_id?.nome ?? "—"}
              </span>
            </div>

            {/* Data + tempo */}
            <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
                <span>
                  {format(parseISO(tarefaSelecionada.data), "EEEE, d 'de' MMMM yyyy", {
                    locale: pt,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span>Tempo estimado: {tarefaSelecionada.tempo_limpeza_minutos} min</span>
              </div>
              {tarefaSelecionada.propriedade_id?.morada && (
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {tarefaSelecionada.propriedade_id.morada}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span>
                  Staff atual:{" "}
                  {tarefaSelecionada.utilizador_id?.nome ?? (
                    <span className="text-destructive">Por atribuir</span>
                  )}
                </span>
              </div>
            </div>

            {/* Reatribuição rápida */}
            <div className="space-y-1.5">
              <label htmlFor="reatribuir" className="text-sm font-medium">
                Reatribuir a (rápido)
              </label>
              <select
                id="reatribuir"
                value={reatribuindoPara}
                onChange={(e) => setReatribuindoPara(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Selecionar staff —</option>
                {equipa.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.nome}
                  </option>
                ))}
              </select>
            </div>

            {tarefaSelecionada.observacoes && (
              <div className="rounded-md bg-muted/30 p-3 text-sm">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Observações:
                </p>
                <p>{tarefaSelecionada.observacoes}</p>
              </div>
            )}
          </DialogContent>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setTarefaSelecionada(null)}
            disabled={reatribuindo}
          >
            Fechar
          </Button>
          <Button
            type="button"
            onClick={handleReatribuir}
            disabled={!reatribuindoPara || reatribuindo}
          >
            {reatribuindo ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A reatribuir…
              </>
            ) : (
              "Reatribuir"
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
