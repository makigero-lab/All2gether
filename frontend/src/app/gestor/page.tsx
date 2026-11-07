"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Users,
  ClipboardList,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Siren,
  TriangleAlert,
  ArrowRight,
  Play,
  Wrench,
  Shirt,
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
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { OfertaVagaBadge } from "@/components/gestor/oferta-vaga-badge";
import { TipoMarca } from "@/components/tipo-limpeza-badge";
import { PushNotificationSetup } from "@/components/gestor/push-notification-setup";
import { formatarDataSegura, textoRedistribuicao, type RedistribuicaoDTO, plural } from "@/lib/utils";

interface DashboardData {
  totalPropriedades: number;
  propriedadesAtivas: number;
  membrosEquipaAtivos: number;
  tarefasHoje: number;
  tarefasPorAtribuir: number;
  // Limpezas a que falta pelo menos uma pessoa (sem substituto).
  tarefasEquipaIncompleta?: number;
  tarefasConcluidasHoje: number;
  // Próximas 48 h (limpezas ativas), para a coluna do dashboard.
  proximas48h?: { _id: string; data: string; estado: string; tipo_limpeza: string; propriedade_nome: string; utilizador_id?: string | null; pessoas_em_falta?: number; oferta_estado?: string | null; oferta_expira_em?: string | null }[];
  // Limpezas em curso neste momento (início por botão ou automático).
  aDecorrerAgora?: {
    total: number;
    tarefas: {
      _id: string;
      propriedade_nome: string;
      pessoa: string | null;
      iniciada_em: string | null;
      inicio_origem: "botao" | "automatico" | null;
      tipo: string;
      tipo_limpeza?: string;
    }[];
  };
  // Avarias reportadas por resolver (ciclo fechado ao concluir a manutenção).
  avariasAbertas?: number;
  // Limpezas de hoje (casas com lavandaria) sem roupa limpa entregue.
  limpezasSemRoupa?: number;
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
    const t = setTimeout(() => setToast(null), toast.msg.includes("em curso") ? 20000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Aprova uma emergência e dispara a redistribuição. */
  async function handleConfirmarEmergencia(em: EmergenciaDTO) {
    setAprovandoEmergencia(em._id);
    try {
      const res = await adminPatch<{
        redistribuicao: RedistribuicaoDTO | null;
      }>(`/api/gestor/ausencias/${em._id}/estado`, { estado: "aprovada" });

      const r = res.redistribuicao;
      const msg = textoRedistribuicao("Falta confirmada.", r, "Sem tarefas para desatribuir hoje.");
      setToast({ tipo: "sucesso", msg: r?.aviso ? `${msg} ${r.aviso}` : msg });

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

  const kpis: { label: string; value: number | string; de?: number; alerta?: boolean }[] = data
    ? [
        { label: "Propriedades", value: data.propriedadesAtivas, de: data.totalPropriedades },
        { label: "Equipa ativa", value: data.membrosEquipaAtivos },
        { label: "Limpezas hoje", value: data.tarefasHoje },
        { label: "Por atribuir (48 h)", value: data.checkinsEmRisco?.total ?? data.tarefasPorAtribuir, alerta: (data.checkinsEmRisco?.total ?? data.tarefasPorAtribuir) > 0 },
        { label: "Concluídas hoje", value: data.tarefasConcluidasHoje },
        { label: "Sem roupa entregue", value: data.limpezasSemRoupa ?? 0 },
        ...((data.tarefasEquipaIncompleta ?? 0) > 0 ? [{ label: "Falta pessoa", value: data.tarefasEquipaIncompleta ?? 0, alerta: true }] : []),
        ...((data.avariasAbertas ?? 0) > 0 ? [{ label: "Avarias abertas", value: data.avariasAbertas ?? 0, alerta: true }] : []),
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
        <span className="text-sm text-muted-foreground">
          {formatarDataSegura(new Date().toISOString(), (d) => format(d, "EEEE, d 'de' MMMM", { locale: pt }), "")} · tempo real
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Link href="/gestor/tarefas" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nova limpeza
          </Link>
        </div>
      </div>

      {/* Banner para ativar notificações push */}
      <PushNotificationSetup />

      {/* Radar de risco: limpezas por atribuir nas próximas 48 h (uma linha, com «Resolver») */}
      {!loading && !erro && data?.checkinsEmRisco && data.checkinsEmRisco.total > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-status-porat/30 bg-status-porat-bg px-3 py-2 text-sm text-status-porat">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <strong>{plural(data.checkinsEmRisco.total, "limpeza")} por atribuir nas próximas 48 h:</strong>{" "}
            {data.checkinsEmRisco.tarefas.slice(0, 3).map((x) => `${x.propriedade_nome} (${formatarDataSegura(x.data, (d) => format(d, "EEE HH:mm", { locale: pt }), x.data)})`).join(", ")}
            {data.checkinsEmRisco.total > 3 ? ` e mais ${data.checkinsEmRisco.total - 3}` : ""}
          </p>
          <Link href="/gestor/calendario" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            Resolver
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
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
                      🚨 {em.utilizador?.nome ?? "Elemento da equipa"} reportou que vai faltar hoje!
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
          {/* Faixa compacta de KPI */}
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border bg-card sm:grid-cols-3 lg:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
            {kpis.map((s) => (
              <div key={s.label} className="border-b border-r px-4 py-3 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0 lg:border-b-0 lg:[&:nth-child(n)]:border-r lg:last:border-r-0">
                <p className={`text-2xl font-bold leading-none tabular-nums ${s.alerta ? "text-status-naoat" : ""}`}>
                  {s.value}
                  {s.de && <span className="ml-1 text-xs font-normal text-muted-foreground">/{s.de}</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>

          {/* 3 colunas: a decorrer, próximas 48 h, equipa hoje */}
          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <section aria-labelledby="dash-decorrer" className="min-w-0 overflow-hidden rounded-lg border bg-card">
              <h2 id="dash-decorrer" className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-bold">
                <Play className="h-4 w-4" aria-hidden="true" />
                A decorrer agora
                <span className="ml-auto text-xs font-medium text-muted-foreground">{data.aDecorrerAgora?.total ?? 0}</span>
              </h2>
              {!data.aDecorrerAgora || data.aDecorrerAgora.total === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Nenhuma limpeza em curso.</p>
              ) : (
                <ul className="divide-y">
                  {data.aDecorrerAgora.tarefas.map((x) => (
                    <li key={x._id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="line-clamp-2 break-words font-medium" title={x.propriedade_nome}>{x.propriedade_nome}</p>
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                          <TipoMarca tipo={x.tipo_limpeza} className="text-xs" />
                          {x.iniciada_em ? ` · desde as ${formatarDataSegura(x.iniciada_em, (d) => format(d, "HH:mm"), "—")}` : ""}
                          {x.inicio_origem === "automatico" ? " · início automático" : x.inicio_origem === "botao" ? " · pelo botão" : ""}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-text" title={x.pessoa ?? "Sem pessoa"}>
                        {(x.pessoa ?? "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="dash-48h" className="min-w-0 overflow-hidden rounded-lg border bg-card">
              <h2 id="dash-48h" className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-bold">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                Próximas 48 h
                <span className="ml-auto text-xs font-medium text-muted-foreground">
                  {data.proximas48h?.length ?? 0}
                  {(data.checkinsEmRisco?.total ?? 0) > 0 && <span className="font-semibold text-status-naoat"> · {data.checkinsEmRisco?.total} por atribuir</span>}
                </span>
              </h2>
              {!data.proximas48h || data.proximas48h.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Sem limpezas nas próximas 48 horas.</p>
              ) : (
                <ul className="divide-y">
                  {data.proximas48h.map((x) => (
                    <li key={x._id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="line-clamp-2 break-words font-medium" title={x.propriedade_nome}>{x.propriedade_nome}</p>
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                          <TipoMarca tipo={x.tipo_limpeza} className="text-xs" />
                          · {formatarDataSegura(x.data, (d) => format(d, "EEE HH:mm", { locale: pt }), x.data)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <EstadoTarefaBadge estado={x.estado} />
                        <OfertaVagaBadge tarefa={x} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="dash-equipa" className="min-w-0 overflow-hidden rounded-lg border bg-card">
              <h2 id="dash-equipa" className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-bold">
                <Users className="h-4 w-4" aria-hidden="true" />
                Equipa hoje
                <span className="ml-auto text-xs font-medium text-muted-foreground">{data.membrosEquipaAtivos} ativos</span>
              </h2>
              {data.tarefasPorStaff.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Sem tarefas atribuídas hoje.</p>
              ) : (
                <ul className="divide-y">
                  {data.tarefasPorStaff.map((s) => {
                    const pct = Math.min(100, Math.round((s.carga_minutos / 480) * 100));
                    return (
                      <li key={s.utilizador_id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[10.5px] font-bold text-brand-text" aria-hidden="true">
                          {s.nome.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{s.nome}</span>
                        <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-border" role="img" aria-label={`Carga de ${pct}% das 8 h`}>
                          <span className={`block h-full rounded-full ${s.carga_minutos > 420 ? "bg-status-naoat" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                        </span>
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {Math.floor(s.carga_minutos / 60)}h{String(s.carga_minutos % 60).padStart(2, "0")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
