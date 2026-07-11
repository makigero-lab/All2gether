"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  Loader2,
  AlertCircle,
  SprayCan,
  Plane,
  Sun,
  Clock,
  ChevronRight,
  Wrench,
  LogIn,
  LogOut,
} from "lucide-react";
import { format, isSameDay, addDays } from "date-fns";
import { pt } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { cn, parsearDataSegura } from "@/lib/utils";

/**
 * Página de Calendário Pessoal do Staff (/staff/calendario).
 *
 * v1.56.0 (Prompt 78):
 *   - Vista "Hoje" em bloco visual compacto (tarefas + hora de início).
 *   - Lista dos próximos 30 dias, cada tarefa clicável → /staff/tarefas/[id].
 *   - Hora de início ao lado de cada tarefa (lida do campo data ISO).
 *
 * Consome GET /api/auth/me/calendario (via proxy same-origin com cookie httpOnly).
 */

interface TarefaMinha {
  _id: string;
  propriedade_id?: { nome: string } | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
}

interface AusenciaMinha {
  _id: string;
  data_inicio: string;
  data_fim: string;
  tipo: "ferias" | "folga";
  notas?: string;
}

interface DiaAgenda {
  data: Date;
  tarefas: TarefaMinha[];
  ausencia: AusenciaMinha | null;
}

/** Ícone por tipo de tarefa. */
const tipoIcon: Record<string, React.ComponentType<{ className?: string }>> = {
  limpeza: SprayCan,
  manutencao: Wrench,
  check_in: LogIn,
  check_out: LogOut,
  outro: SprayCan,
};

/** Extrai HH:mm de um ISO; "—" se meia-noite (sem hora definida). */
function horaInicio(dataISO?: string): string {
  if (!dataISO) return "—";
  try {
    const d = parsearDataSegura(dataISO);
    if (!d) return "—";
    if (d.getHours() === 0 && d.getMinutes() === 0) return "—";
    return format(d, "HH:mm", { locale: pt });
  } catch {
    return "—";
  }
}

export default function StaffCalendarioPage() {
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [dias, setDias] = useState<DiaAgenda[]>([]);

  useEffect(() => {
    let cancelado = false;

    (async () => {
      setLoading(true);
      setErro(null);
      try {
        const res = await fetch("/api/auth/me/calendario", {
          cache: "no-store",
          credentials: "include",
        });

        if (!res.ok) {
          throw new Error("Não foi possível carregar a agenda.");
        }

        const data = (await res.json()) as {
          tarefas: TarefaMinha[];
          ausencias: AusenciaMinha[];
        };

        if (cancelado) return;

        // Gera os próximos 30 dias.
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const proximos30: DiaAgenda[] = [];

        for (let i = 0; i < 30; i++) {
          const dia = addDays(hoje, i);
          const tarefasDoDia = data.tarefas
            .filter((t) => {
              const d = parsearDataSegura(t.data);
              return d ? isSameDay(d, dia) : false;
            })
            // Ordena por hora de início (mais cedo primeiro).
            .sort((a, b) => {
              const da = parsearDataSegura(a.data);
              const db = parsearDataSegura(b.data);
              return (da?.getTime() ?? 0) - (db?.getTime() ?? 0);
            });

          const ausenciaDoDia = data.ausencias.find((a) => {
            const inicio = parsearDataSegura(a.data_inicio);
            const fim = parsearDataSegura(a.data_fim);
            if (!inicio || !fim) return false;
            return dia >= inicio && dia <= fim;
          }) ?? null;

          proximos30.push({
            data: dia,
            tarefas: tarefasDoDia,
            ausencia: ausenciaDoDia,
          });
        }

        setDias(proximos30);
      } catch (e) {
        if (!cancelado) {
          setErro(e instanceof Error ? e.message : "Erro ao carregar agenda.");
        }
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();

    return () => {
      cancelado = true;
    };
  }, []);

  // Dia de hoje (primeiro do array) para a vista em bloco.
  const diaHoje = dias[0];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-muted/20">
      {/* Cabeçalho */}
      <header className="sticky top-0 z-10 border-b bg-background/95 px-5 pb-4 pt-6 backdrop-blur">
        <Link
          href="/staff"
          prefetch
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Link>
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">
            A minha Agenda
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Próximos 30 dias
        </p>
      </header>

      {/* Conteúdo */}
      <main className="flex-1 space-y-5 p-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar agenda…
          </div>
        ) : erro ? (
          <Card className="border-destructive/50">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{erro}</span>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ----------------------------------------------------------
                Vista "Hoje" em bloco visual compacto (Prompt 78, ponto 2)
                ---------------------------------------------------------- */}
            {diaHoje && (
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">
                    Hoje · {format(diaHoje.data, "d MMM", { locale: pt })}
                  </h2>
                  <span className="h-px flex-1 bg-primary/30" />
                </div>

                {diaHoje.ausencia ? (
                  <Card
                    className={cn(
                      "border-0",
                      diaHoje.ausencia.tipo === "ferias"
                        ? "bg-orange-50 dark:bg-orange-950/20"
                        : "bg-yellow-50 dark:bg-yellow-950/20"
                    )}
                  >
                    <CardContent className="flex items-center gap-3 p-4">
                      {diaHoje.ausencia.tipo === "ferias" ? (
                        <Plane className="h-5 w-5 text-orange-600" />
                      ) : (
                        <Sun className="h-5 w-5 text-yellow-600" />
                      )}
                      <div>
                        <p className="text-sm font-medium">
                          {diaHoje.ausencia.tipo === "ferias" ? "Férias" : "Folga"}
                        </p>
                        {diaHoje.ausencia.notas && (
                          <p className="text-xs text-muted-foreground">
                            {diaHoje.ausencia.notas}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ) : diaHoje.tarefas.length === 0 ? (
                  <Card className="border-dashed border-border/40 bg-transparent">
                    <CardContent className="flex items-center gap-3 p-4">
                      <Sun className="h-5 w-5 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        Dia livre — sem tarefas atribuídas.
                      </span>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-2">
                    {diaHoje.tarefas.map((t) => {
                      const Icon = tipoIcon[t.tipo] ?? SprayCan;
                      const hora = horaInicio(t.data);
                      return (
                        <Link key={t._id} href={`/staff/tarefas/${t._id}`} prefetch>
                          <Card className="cursor-pointer border-primary/30 transition-all hover:border-primary hover:shadow-md active:scale-[0.99]">
                            <CardContent className="flex items-center gap-3 p-3">
                              {/* Bloco de hora (destaque visual) */}
                              <div className="flex w-14 shrink-0 flex-col items-center justify-center rounded-md bg-primary/10 py-1.5">
                                <span className="text-sm font-bold tabular-nums text-primary">
                                  {hora}
                                </span>
                                <span className="text-[10px] uppercase text-primary/70">
                                  início
                                </span>
                              </div>

                              <div
                                className={cn(
                                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                                  t.estado === "concluida"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : t.estado === "por_atribuir"
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-primary/10 text-primary"
                                )}
                              >
                                <Icon className="h-4 w-4" />
                              </div>

                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {t.propriedade_id?.nome ?? "Propriedade"}
                                </p>
                                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Clock className="h-3 w-3" />
                                  {t.tempo_limpeza_minutos} min
                                </p>
                              </div>

                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </CardContent>
                          </Card>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* ----------------------------------------------------------
                Lista dos próximos dias (clicável)
                ---------------------------------------------------------- */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Próximos dias
                </h2>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="space-y-3">
                {dias.slice(1).map((dia, idx) => {
                  const diaFmt = format(dia.data, "EEE, d MMM", { locale: pt });
                  const temTarefas = dia.tarefas.length > 0;
                  const temAusencia = dia.ausencia !== null;
                  const ehFolga = !temTarefas && !temAusencia;

                  return (
                    <div key={idx}>
                      {/* Label do dia */}
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-xs font-semibold capitalize text-muted-foreground">
                          {diaFmt}
                        </span>
                      </div>

                      {/* Cartão de ausência (folga/férias) */}
                      {temAusencia && (
                        <Card
                          className={cn(
                            "border-0",
                            dia.ausencia!.tipo === "ferias"
                              ? "bg-orange-50 dark:bg-orange-950/20"
                              : "bg-yellow-50 dark:bg-yellow-950/20"
                          )}
                        >
                          <CardContent className="flex items-center gap-3 p-3">
                            {dia.ausencia!.tipo === "ferias" ? (
                              <Plane className="h-4 w-4 text-orange-600" />
                            ) : (
                              <Sun className="h-4 w-4 text-yellow-600" />
                            )}
                            <span className="text-sm font-medium">
                              {dia.ausencia!.tipo === "ferias" ? "Férias" : "Folga"}
                            </span>
                            {dia.ausencia!.notas && (
                              <span className="text-xs text-muted-foreground">
                                · {dia.ausencia!.notas}
                              </span>
                            )}
                          </CardContent>
                        </Card>
                      )}

                      {/* Cartões de tarefas (clicáveis) */}
                      {temTarefas && (
                        <div className="space-y-2">
                          {dia.tarefas.map((t) => {
                            const Icon = tipoIcon[t.tipo] ?? SprayCan;
                            const hora = horaInicio(t.data);
                            return (
                              <Link key={t._id} href={`/staff/tarefas/${t._id}`} prefetch>
                                <Card className="cursor-pointer border-border/60 transition-all hover:border-primary/40 hover:shadow-sm active:scale-[0.99]">
                                  <CardContent className="flex items-center gap-3 p-3">
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                      <Icon className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm font-medium">
                                        {t.propriedade_id?.nome ?? "Propriedade"}
                                      </p>
                                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                        {hora !== "—" && (
                                          <span className="flex items-center gap-1 tabular-nums">
                                            <Clock className="h-3 w-3" />
                                            {hora}
                                          </span>
                                        )}
                                        <span>
                                          {t.tempo_limpeza_minutos} min
                                        </span>
                                      </p>
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
                                  </CardContent>
                                </Card>
                              </Link>
                            );
                          })}
                        </div>
                      )}

                      {/* Dia sem nada (folga livre) */}
                      {ehFolga && (
                        <Card className="border-dashed border-border/40 bg-transparent">
                          <CardContent className="p-3">
                            <span className="text-xs text-muted-foreground">
                              Dia livre
                            </span>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>

      {/* Rodapé */}
      <footer className="border-t px-5 py-4 text-center text-xs text-muted-foreground">
        Autocell · Área do Staff
      </footer>
    </div>
  );
}
