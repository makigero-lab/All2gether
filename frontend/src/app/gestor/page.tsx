"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Users,
  ClipboardList,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Siren,
  TriangleAlert,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { adminGet, adminPatch } from "@/lib/api";
import { PushNotificationSetup } from "@/components/gestor/push-notification-setup";
import { formatarDataSegura } from "@/lib/utils";

interface DashboardData {
  totalPropriedades: number;
  propriedadesAtivas: number;
  membrosEquipaAtivos: number;
  tarefasHoje: number;
  tarefasPorAtribuir: number;
  tarefasConcluidasHoje: number;
  tarefasPorStaff: { utilizador_id: string; nome: string; tarefas: number; carga_minutos: number }[];
  // v1.54.0 (Prompt 76) — Radar de Risco: check-ins sem limpeza nas próximas 48h.
  checkinsEmRisco?: {
    total: number;
    tarefas: {
      _id: string;
      data: string;
      estado: string;
      tempo_limpeza_minutos: number;
      propriedade_nome: string;
    }[];
  };
}

interface EmergenciaDTO {
  _id: string;
  utilizador_id: string;
  utilizador: { _id: string; nome: string; email: string } | null;
  justificacao?: string;
  createdAt: string;
}

/**
 * Dashboard do Admin (/admin) — dados reais.
 * Consome GET /api/gestor/dashboard (via proxy same-origin).
 */
export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Emergências pendentes (faltas reportadas pelo staff para hoje).
  const [emergencias, setEmergencias] = useState<EmergenciaDTO[]>([]);
  const [aprovandoEmergencia, setAprovandoEmergencia] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const [dashRes, emergRes] = await Promise.all([
        adminGet<DashboardData>("/api/gestor/dashboard"),
        adminGet<{ ausencias: EmergenciaDTO[] }>(
          "/api/gestor/ausencias?estado=pendente_emergencia"
        ),
      ]);
      setData(dashRes);
      setEmergencias(emergRes.ausencias ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Auto-esconde o toast após 6s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Aprova uma emergência e dispara a redistribuição. */
  async function handleConfirmarEmergencia(em: EmergenciaDTO) {
    setAprovandoEmergencia(em._id);
    try {
      const res = await adminPatch<{
        redistribuicao: { total: number; reatribuidas: number; orfas: number } | null;
      }>(`/api/gestor/ausencias/${em._id}/estado`, { estado: "aprovada" });

      const r = res.redistribuicao;
      const msg =
        r && r.total > 0
          ? `Falta confirmada. ${r.reatribuidas} tarefa(s) redistribuída(s)${r.orfas > 0 ? `, ${r.orfas} órfã(s)` : ""}.`
          : "Falta confirmada. Sem tarefas para redistribuir hoje.";
      setToast({ tipo: "sucesso", msg });

      // Remove a emergência da lista (já foi confirmada).
      setEmergencias((prev) => prev.filter((e) => e._id !== em._id));
      // Recarrega o dashboard para refletir as tarefas redistribuídas.
      await carregar();
    } catch (e) {
      setToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro: ${e.message}` : "Erro ao confirmar falta.",
      });
    } finally {
      setAprovandoEmergencia(null);
    }
  }

  const stats = data
    ? [
        { label: "Propriedades", value: `${data.propriedadesAtivas}/${data.totalPropriedades}`, icon: Building2 },
        { label: "Staff ativo", value: data.membrosEquipaAtivos, icon: Users },
        { label: "Tarefas hoje", value: data.tarefasHoje, icon: ClipboardList },
        { label: "Por atribuir", value: data.tarefasPorAtribuir, icon: AlertCircle },
        { label: "Concluídas", value: data.tarefasConcluidasHoje, icon: CheckCircle2 },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Visão operacional das limpezas de hoje (dados em tempo real).
        </p>
      </div>

      {/* Banner para ativar notificações push */}
      <PushNotificationSetup />

      {/* Radar de Risco (Prompt 76) — check-ins sem limpeza nas próximas 48h */}
      {!loading && !erro && data?.checkinsEmRisco && data.checkinsEmRisco.total > 0 && (
        <div className="rounded-lg border-2 border-orange-500/60 bg-orange-50 p-4 shadow-lg dark:bg-orange-950/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white">
                <TriangleAlert className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-orange-900 dark:text-orange-100">
                  ⚠️ Tens {data.checkinsEmRisco.total} limpeza(s) crítica(s) pendente(s) para as próximas 48h!
                </p>
                <p className="mt-0.5 text-xs text-orange-800/80 dark:text-orange-200/80">
                  Estas tarefas estão <strong>por atribuir</strong> e podem comprometer check-ins.
                </p>
                {/* Lista das tarefas em risco (máx. 3, depois "e mais N") */}
                <ul className="mt-2 space-y-1">
                  {data.checkinsEmRisco.tarefas.slice(0, 3).map((t) => (
                    <li key={t._id} className="flex items-center gap-2 text-xs text-orange-900 dark:text-orange-100">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-600" />
                      <span className="font-medium">{t.propriedade_nome}</span>
                      <span className="text-orange-700/70 dark:text-orange-300/70">·</span>
                      <span>
                        {(() => {
                          return formatarDataSegura(
                            t.data,
                            (d) => format(d, "EEE d MMM 'às' HH:mm", { locale: pt }),
                            t.data
                          );
                        })()}
                      </span>
                    </li>
                  ))}
                  {data.checkinsEmRisco.total > 3 && (
                    <li className="text-xs italic text-orange-700/70 dark:text-orange-300/70">
                      e mais {data.checkinsEmRisco.total - 3}…
                    </li>
                  )}
                </ul>
              </div>
            </div>
            <Link
              href="/gestor/calendario"
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md bg-orange-600 px-3 text-xs font-medium text-white transition-colors hover:bg-orange-700"
            >
              Resolver agora
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      )}

      {/* Notificações Críticas — banner de emergência */}
      {emergencias.length > 0 && (
        <div className="space-y-3">
          {emergencias.map((em) => (
            <div
              key={em._id}
              className="animate-pulse rounded-lg border-2 border-destructive bg-destructive/10 p-4 shadow-lg"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
                    <Siren className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-destructive">
                      🚨 {em.utilizador?.nome ?? "Funcionário"} reportou que vai faltar hoje!
                    </p>
                    {em.justificacao && (
                      <p className="mt-0.5 text-sm text-destructive/80">
                        Justificação: {em.justificacao}
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={() => handleConfirmarEmergencia(em)}
                  disabled={aprovandoEmergencia !== null}
                >
                  {aprovandoEmergencia === em._id ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      A confirmar…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Confirmar e Redistribuir
                    </>
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <Card
          className={
            toast.tipo === "sucesso"
              ? "border-emerald-500/50"
              : "border-destructive/50"
          }
        >
          <CardContent
            className={`flex items-center gap-3 p-4 text-sm ${
              toast.tipo === "sucesso"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive"
            }`}
          >
            {toast.tipo === "sucesso" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" />
            )}
            <span className="flex-1">{toast.msg}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => setToast(null)}
            >
              ×
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar dashboard…
        </div>
      ) : erro ? (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{erro}</span>
            <Button variant="outline" size="sm" onClick={carregar} className="ml-auto">
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Cartões de estatística */}
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {stats.map((s) => {
              const Icon = s.icon;
              return (
                <Card key={s.label}>
                  <CardContent className="flex items-center gap-4 p-5">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-2xl font-bold leading-none">
                        {s.value}
                      </span>
                      <span className="mt-1 text-sm text-muted-foreground">
                        {s.label}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Carga por staff */}
          <Card>
            <CardHeader>
              <CardTitle>Estado da equipa</CardTitle>
              <CardDescription>Carga de trabalho de hoje.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.tarefasPorStaff.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sem tarefas atribuídas hoje.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.tarefasPorStaff.map((s) => (
                    <li key={s.utilizador_id} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{s.nome}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.tarefas} tarefas
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={s.carga_minutos > 420 ? "destructive" : "secondary"}>
                          {Math.floor(s.carga_minutos / 60)}h{String(s.carga_minutos % 60).padStart(2, "0")}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
