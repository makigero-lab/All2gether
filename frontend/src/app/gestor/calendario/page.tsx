"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  Loader2,
  AlertCircle,
  RefreshCw,
  MapPin,
  Clock,
  User,
  X,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import ptLocale from "@fullcalendar/core/locales/pt";
import type { DatesSetArg, EventClickArg, EventInput } from "@fullcalendar/core";

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

interface PeriodoState {
  inicio: string;
  fim: string;
}

const ESTADO_OPTS = [
  { value: "", label: "Todos os estados" },
  { value: "por_atribuir", label: "Por atribuir" },
  { value: "atribuida", label: "Atribuída" },
  { value: "em_curso", label: "Em curso" },
  { value: "concluida", label: "Concluída" },
  { value: "cancelada", label: "Cancelada" },
];

const TIPO_LABEL: Record<string, string> = {
  limpeza: "Limpeza",
  manutencao: "Manutenção",
  folga_fixa: "Folga Semanal",
  check_in: "Check-in",
  check_out: "Check-out",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Cor de fundo/borda do evento do FullCalendar por estado da tarefa. */
function corPorEstado(estado: string): string {
  switch (estado) {
    case "por_atribuir":
      return "#ef4444"; // vermelho
    case "atribuida":
    case "em_curso":
      return "#f59e0b"; // âmbar
    case "concluida":
      return "#10b981"; // verde
    case "cancelada":
      return "#9ca3af"; // cinza
    default:
      return "#6b7280";
  }
}

function primeiroNome(nome: string | undefined): string {
  if (!nome) return "";
  return nome.split(" ")[0];
}

/** Devolve a hora "HH:mm" se a data ISO tiver componente de tempo; senão "—". */
function horaTarefa(dataISO: string): string {
  if (!dataISO || !dataISO.includes("T")) return "—";
  try {
    return format(parseISO(dataISO), "HH:mm");
  } catch {
    return "—";
  }
}

/** Calcula a hora de fim estimada (início + tempo_limpeza_minutos). */
function horaFimTarefa(dataISO: string, minutos: number): string {
  if (!dataISO || !dataISO.includes("T")) return "—";
  try {
    const inicio = parseISO(dataISO);
    const fim = new Date(inicio.getTime() + (minutos || 0) * 60000);
    return format(fim, "HH:mm");
  } catch {
    return "—";
  }
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function CalendarioOperacionalPage() {
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

  // SSR-safe mount: FullCalendar só pode ser renderizado no cliente.
  const [mounted, setMounted] = useState(false);

  // Período atual do calendário (definido via datesSet do FullCalendar).
  const [periodo, setPeriodo] = useState<PeriodoState | null>(null);

  // Modal de detalhe.
  const [tarefaSelecionada, setTarefaSelecionada] = useState<TarefaCalendario | null>(null);
  const [reatribuindoPara, setReatribuindoPara] = useState<string>("");
  const [reatribuindo, setReatribuindo] = useState(false);

  /* --- Marca montação no cliente (inibe o SSR do FullCalendar) --- */
  useEffect(() => {
    setMounted(true);
  }, []);

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

  /* --- Carregar tarefas do período + filtros (lógica original — NÃO MUDAR) --- */
  const carregarTarefas = useCallback(async () => {
    if (!periodo) return;
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim });
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
  }, [periodo, filtros]);

  // Recarrega quando o período (definido pelo FullCalendar) ou os filtros mudam.
  useEffect(() => {
    if (periodo) carregarTarefas();
  }, [carregarTarefas, periodo]);

  /* --- Mapear tarefas → eventos do FullCalendar --- */
  const eventos = useMemo<EventInput[]>(() => {
    return tarefas.map((t) => {
      // Folga fixa semanal — bloco cinzento claro, todo o dia.
      if (t.tipo === "folga_fixa") {
        return {
          id: t._id,
          title: `Folga - ${t.utilizador_id?.nome ?? "Staff"}`,
          start: t.data,
          allDay: true,
          backgroundColor: "#e2e8f0",
          borderColor: "#cbd5e1",
          textColor: "#475569",
          extendedProps: t,
        } as EventInput;
      }

      const inicio = new Date(t.data);
      const fim = new Date(inicio.getTime() + (t.tempo_limpeza_minutos || 45) * 60000);
      const cor = corPorEstado(t.estado);
      return {
        id: t._id,
        title: `${t.propriedade_id?.nome ?? "—"} - ${
          t.utilizador_id?.nome ?? "Sem atribuição"
        }`,
        start: inicio.toISOString(),
        end: fim.toISOString(),
        backgroundColor: cor,
        borderColor: cor,
        extendedProps: t,
      } as EventInput;
    });
  }, [tarefas]);

  /* --- Callbacks do FullCalendar --- */
  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setPeriodo({
      inicio: format(arg.start, "yyyy-MM-dd"),
      fim: format(arg.end, "yyyy-MM-dd"),
    });
  }, []);

  const handleEventClick = useCallback((arg: EventClickArg) => {
    const tarefa = arg.event.extendedProps as TarefaCalendario;
    setTarefaSelecionada(tarefa);
    setReatribuindoPara(tarefa.utilizador_id?._id ?? "");
  }, []);

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
            disabled={loading || !periodo}
            aria-label="Atualizar"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Vista mensal, semanal e diária de todas as tarefas de limpeza. Filtra por
          propriedade, staff ou estado. Clica numa tarefa para ver o detalhe e reatribuir.
        </p>
      </div>

      {/* Zona de Filtros */}
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 lg:flex-row lg:items-end lg:justify-between">
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
              onClick={() => setFiltros({ propriedadeId: "", utilizadorId: "", estado: "" })}
            >
              <X className="h-3.5 w-3.5" />
              Limpar
            </Button>
          )}
        </div>

        {/* Indicador de loading discreto */}
        {loading && (
          <Badge variant="secondary" className="self-start px-3 py-1.5 text-xs lg:self-end">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            A sincronizar…
          </Badge>
        )}
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

      {/* FullCalendar */}
      <div className="rounded-lg border bg-card p-2 sm:p-4">
        {mounted ? (
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale={ptLocale}
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "dayGridMonth,timeGridWeek,timeGridDay",
            }}
            slotMinTime="08:00:00"
            slotMaxTime="20:00:00"
            height={700}
            nowIndicator
            editable={false}
            eventStartEditable={false}
            eventDurationEditable={false}
            events={eventos}
            eventClick={handleEventClick}
            datesSet={handleDatesSet}
            dayMaxEvents
            eventDisplay="block"
            eventTimeFormat={{
              hour: "2-digit",
              minute: "2-digit",
              meridiem: false,
            }}
            slotLabelFormat={{
              hour: "2-digit",
              minute: "2-digit",
              meridiem: false,
            }}
          />
        ) : (
          <div className="flex h-[700px] items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A preparar calendário…
          </div>
        )}
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Legenda:</span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#ef4444", borderColor: "#ef4444" }}
          />
          Por atribuir
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#f59e0b", borderColor: "#f59e0b" }}
          />
          Atribuída / Em curso
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#10b981", borderColor: "#10b981" }}
          />
          Concluída
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#9ca3af", borderColor: "#9ca3af" }}
          />
          Cancelada
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#e2e8f0", borderColor: "#cbd5e1" }}
          />
          Folga fixa
        </span>
      </div>

      {/* Modal de detalhe + reatribuição */}
      <Dialog
        open={tarefaSelecionada !== null}
        onOpenChange={(o) => !o && setTarefaSelecionada(null)}
      >
        <DialogHeader>
          <DialogTitle>Detalhe da Tarefa</DialogTitle>
          <DialogDescription>Informação da tarefa e reatribuição rápida.</DialogDescription>
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
                <span>
                  {horaTarefa(tarefaSelecionada.data)} -{" "}
                  {horaFimTarefa(
                    tarefaSelecionada.data,
                    tarefaSelecionada.tempo_limpeza_minutos
                  )}{" "}
                  · {tarefaSelecionada.tempo_limpeza_minutos} min
                </span>
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
                <p className="mb-1 text-xs font-medium text-muted-foreground">Observações:</p>
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
