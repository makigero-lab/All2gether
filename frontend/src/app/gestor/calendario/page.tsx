"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  X,
  SprayCan,
  Plane,
  Sun,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  parseISO,
} from "date-fns";
import { ptBR } from "date-fns/locale";

import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dialog";
import {
  adminGet,
  type AusenciaDTO,
  type UtilizadorDTO,
} from "@/lib/api";

/**
 * Página de Calendário Geral de Operações — Painel de Administração.
 *
 * Mostra uma grelha visual estilo Google Calendar com:
 *   - Badges de Limpeza (azul/verde) — sigla da casa
 *   - Badges de Folga/Férias (amarelo/laranja) — nome do funcionário
 *   - Click num dia → modal com detalhe
 *
 * Consome /api/gestor/tarefas + /api/gestor/ausencias (via proxy same-origin).
 */

// --- Tipos locais ---

interface TarefaCalendario {
  _id: string;
  propriedade_id?: { nome: string } | null;
  utilizador_id?: { nome: string } | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
}

interface DiaData {
  tarefas: TarefaCalendario[];
  ausencias: AusenciaDTO[];
}

// --- Helpers ---

const DIAS_SEMANA = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

function siglaCasa(nome: string): string {
  const palavras = nome.trim().split(/\s+/);
  if (palavras.length === 1) return palavras[0].slice(0, 3).toUpperCase();
  return (palavras[0][0] + palavras[1][0] + (palavras[2]?.[0] ?? "")).toUpperCase();
}

function corBadgeTarefa(estado: string): string {
  if (estado === "concluida") return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (estado === "por_atribuir") return "bg-amber-100 text-amber-800 border-amber-300";
  return "bg-blue-100 text-blue-800 border-blue-300";
}

// --- Componente ---

export default function CalendarioPage() {
  const [mesAtual, setMesAtual] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [tarefas, setTarefas] = useState<TarefaCalendario[]>([]);
  const [ausencias, setAusencias] = useState<AusenciaDTO[]>([]);
  const [diaSelecionado, setDiaSelecionado] = useState<Date | null>(null);

  // Gera os dias do calendário (inclui dias do mês anterior/posterior para preencher a grelha).
  const dias = useMemo(() => {
    const inicio = startOfWeek(startOfMonth(mesAtual), { weekStartsOn: 1 });
    const fim = endOfWeek(endOfMonth(mesAtual), { weekStartsOn: 1 });
    return eachDayOfInterval({ start: inicio, end: fim });
  }, [mesAtual]);

  // Agrupa dados por dia (chave: YYYY-MM-DD).
  const dadosPorDia = useMemo(() => {
    const mapa = new Map<string, DiaData>();

    for (const t of tarefas) {
      const key = format(parseISO(t.data), "yyyy-MM-dd");
      if (!mapa.has(key)) mapa.set(key, { tarefas: [], ausencias: [] });
      mapa.get(key)!.tarefas.push(t);
    }

    for (const a of ausencias) {
      const inicio = parseISO(a.data_inicio);
      const fim = parseISO(a.data_fim);
      const intervalo = eachDayOfInterval({ start: inicio, end: fim });
      for (const d of intervalo) {
        const key = format(d, "yyyy-MM-dd");
        if (!mapa.has(key)) mapa.set(key, { tarefas: [], ausencias: [] });
        mapa.get(key)!.ausencias.push(a);
      }
    }

    return mapa;
  }, [tarefas, ausencias]);

  // Carrega dados do mês atual.
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const inicio = format(startOfMonth(mesAtual), "yyyy-MM-dd");
      const fim = format(endOfMonth(mesAtual), "yyyy-MM-dd");

      const [tarefasRes, ausenciasRes] = await Promise.all([
        adminGet<{ tarefas: TarefaCalendario[] }>(
          `/api/gestor/tarefas?inicio=${inicio}&fim=${fim}`
        ),
        adminGet<{ ausencias: AusenciaDTO[] }>(
          `/api/gestor/ausencias?futuras=false`
        ),
      ]);

      setTarefas(tarefasRes.tarefas ?? []);
      // Filtra ausências que se sobrepõem ao mês atual.
      const mesInicio = startOfMonth(mesAtual);
      const mesFim = endOfMonth(mesAtual);
      setAusencias(
        (ausenciasRes.ausencias ?? []).filter((a) => {
          const ai = parseISO(a.data_inicio);
          const af = parseISO(a.data_fim);
          return af >= mesInicio && ai <= mesFim;
        })
      );
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar calendário.");
    } finally {
      setLoading(false);
    }
  }, [mesAtual]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Dados do dia selecionado (para o modal).
  const diaSelecionadoData = diaSelecionado
    ? dadosPorDia.get(format(diaSelecionado, "yyyy-MM-dd"))
    : null;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho com navegação de mês */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">
            Calendário de Operações
          </h1>
          <p className="text-sm text-muted-foreground">
            Tarefas de limpeza e folgas da equipa.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMesAtual(addMonths(mesAtual, -1))}
            aria-label="Mês anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[140px] text-center text-sm font-semibold capitalize">
            {format(mesAtual, "MMMM yyyy", { locale: ptBR })}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMesAtual(addMonths(mesAtual, 1))}
            aria-label="Próximo mês"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMesAtual(new Date())}
          >
            Hoje
          </Button>
        </div>
      </div>

      {/* Erro */}
      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{erro}</span>
            <Button variant="outline" size="sm" onClick={carregar} className="ml-auto">
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Calendário (CSS Grid) */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar calendário…
            </div>
          ) : (
            <>
              {/* Header dias da semana */}
              <div className="grid grid-cols-7 gap-1 mb-1">
                {DIAS_SEMANA.map((d) => (
                  <div
                    key={d}
                    className="text-center text-xs font-semibold uppercase text-muted-foreground py-2"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Grelha de dias */}
              <div className="grid grid-cols-7 gap-1">
                {dias.map((dia) => {
                  const key = format(dia, "yyyy-MM-dd");
                  const dados = dadosPorDia.get(key);
                  const noMes = isSameMonth(dia, mesAtual);
                  const ehHoje = isSameDay(dia, new Date());
                  const temTarefas = (dados?.tarefas.length ?? 0) > 0;
                  const temAusencias = (dados?.ausencias.length ?? 0) > 0;

                  return (
                    <button
                      key={key}
                      onClick={() => setDiaSelecionado(dia)}
                      className={`
                        relative min-h-[80px] sm:min-h-[110px] rounded-md border p-1.5 text-left
                        transition-colors hover:bg-accent/50
                        ${noMes ? "bg-background" : "bg-muted/30 opacity-50"}
                        ${ehHoje ? "border-primary ring-1 ring-primary/30" : "border-border/60"}
                        ${(temTarefas || temAusencias) ? "cursor-pointer" : ""}
                      `}
                    >
                      {/* Número do dia */}
                      <span
                        className={`text-xs font-medium ${
                          ehHoje
                            ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {format(dia, "d")}
                      </span>

                      {/* Badges de tarefas (máx 3 visíveis) */}
                      <div className="mt-1 space-y-0.5">
                        {dados?.tarefas.slice(0, 3).map((t) => (
                          <div
                            key={t._id}
                            className={`truncate rounded border px-1 py-0.5 text-[10px] font-medium ${corBadgeTarefa(t.estado)}`}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              <SprayCan className="h-2.5 w-2.5" />
                              {siglaCasa(t.propriedade_id?.nome ?? "?")}
                            </span>
                          </div>
                        ))}
                        {dados && dados.tarefas.length > 3 && (
                          <div className="text-[10px] text-muted-foreground">
                            +{dados.tarefas.length - 3} mais
                          </div>
                        )}

                        {/* Badges de ausências (máx 2) */}
                        {dados?.ausencias.slice(0, 2).map((a) => (
                          <div
                            key={a._id}
                            className={`truncate rounded border px-1 py-0.5 text-[10px] font-medium ${
                              a.tipo === "ferias"
                                ? "bg-orange-100 text-orange-800 border-orange-300"
                                : "bg-yellow-100 text-yellow-800 border-yellow-300"
                            }`}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              {a.tipo === "ferias" ? (
                                <Plane className="h-2.5 w-2.5" />
                              ) : (
                                <Sun className="h-2.5 w-2.5" />
                              )}
                              {a.utilizador?.nome?.split(" ")[0] ?? "?"}
                            </span>
                          </div>
                        ))}
                        {dados && dados.ausencias.length > 2 && (
                          <div className="text-[10px] text-muted-foreground">
                            +{dados.ausencias.length - 2} folgas
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border bg-blue-100 border-blue-300" />
          Limpeza atribuída
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border bg-amber-100 border-amber-300" />
          Por atribuir
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border bg-emerald-100 border-emerald-300" />
          Concluída
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border bg-yellow-100 border-yellow-300" />
          Folga
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border bg-orange-100 border-orange-300" />
          Férias
        </span>
      </div>

      {/* Modal de detalhe do dia */}
      <Dialog
        open={diaSelecionado !== null}
        onOpenChange={(o) => !o && setDiaSelecionado(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle>
              {diaSelecionado
                ? format(diaSelecionado, "EEEE, d 'de' MMMM", { locale: ptBR })
                : ""}
            </DialogTitle>
            <DialogDescription>
              Detalhe das operações do dia.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setDiaSelecionado(null)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {!diaSelecionadoData ||
          (diaSelecionadoData.tarefas.length === 0 &&
            diaSelecionadoData.ausencias.length === 0) ? (
            <p className="text-sm text-muted-foreground">
              Sem operações agendadas para este dia.
            </p>
          ) : (
            <>
              {/* Tarefas do dia */}
              {diaSelecionadoData.tarefas.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold flex items-center gap-1.5">
                    <SprayCan className="h-4 w-4 text-blue-600" />
                    Limpezas ({diaSelecionadoData.tarefas.length})
                  </h4>
                  <ul className="space-y-1.5">
                    {diaSelecionadoData.tarefas.map((t) => (
                      <li
                        key={t._id}
                        className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <span className="font-medium">
                            {t.propriedade_id?.nome ?? "Propriedade desconhecida"}
                          </span>
                          <span className="ml-2 text-muted-foreground">
                            {t.utilizador_id?.nome ?? "Por atribuir"}
                          </span>
                        </div>
                        <Badge
                          variant={
                            t.estado === "concluida"
                              ? "success"
                              : t.estado === "por_atribuir"
                              ? "warning"
                              : "secondary"
                          }
                        >
                          {t.estado === "concluida"
                            ? "Concluída"
                            : t.estado === "por_atribuir"
                            ? "Por atribuir"
                            : "Atribuída"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Ausências do dia */}
              {diaSelecionadoData.ausencias.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold flex items-center gap-1.5">
                    <Sun className="h-4 w-4 text-yellow-600" />
                    Folgas/Férias ({diaSelecionadoData.ausencias.length})
                  </h4>
                  <ul className="space-y-1.5">
                    {diaSelecionadoData.ausencias.map((a) => (
                      <li
                        key={a._id}
                        className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          {a.utilizador?.nome ?? "?"}
                        </span>
                        <Badge
                          variant={a.tipo === "ferias" ? "default" : "secondary"}
                        >
                          {a.tipo === "ferias" ? "Férias" : "Folga"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
