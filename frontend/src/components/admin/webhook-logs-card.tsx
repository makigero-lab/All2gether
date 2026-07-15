"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Webhook,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parsearDataSegura } from "@/lib/utils";

interface WebhookLogDTO {
  _id: string;
  status: "recebido" | "processado" | "erro";
  erro_msg: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  recebido: "Recebido",
  processado: "Sucesso",
  erro: "Falha",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "destructive"> = {
  recebido: "secondary",
  processado: "success",
  erro: "destructive",
};

function formatarData(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    return d.toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function extrairEvento(payload: Record<string, unknown>): string {
  const action = (payload?.action as string) || (payload?.type as string) || "—";
  const id = (payload?.data as Record<string, unknown>)?.id ?? (payload?.content as Record<string, unknown>)?.id;
  const aptName = (payload?.data as Record<string, unknown>)?.apartment
    ? ((payload.data as Record<string, unknown>).apartment as Record<string, unknown>).name
    : null;

  switch (action) {
    case "newReservation":
    case "new_reservation":
    case "reservation_created":
      return `Reserva Criada${id ? ` #${id}` : ""}${aptName ? ` (${aptName})` : ""}`;
    case "updateReservation":
    case "update_reservation":
      return `Reserva Atualizada${id ? ` #${id}` : ""}`;
    case "cancellation":
    case "cancel":
    case "reservation_cancelled":
      return `Cancelamento${id ? ` #${id}` : ""}`;
    default:
      return action;
  }
}

/**
 * Prompt 140 — Card de Webhooks (Caixa Negra) para a gaveta da empresa.
 *
 * Mostra os logs de webhooks do Smoobu filtrados por empresa. Permite:
 *   - Ver data/hora, evento, estado e erro de cada webhook.
 *   - Expandir uma linha para ver o payload completo (JSON).
 *   - Filtrar por estado (Todos / Sucesso / Falhas / Pendentes).
 *   - Limpar logs antigos (> 30 dias).
 *
 * Diferente da página global /admin/webhooks, esta só mostra os webhooks
 * da empresa selecionada (via query ?empresa_id=).
 */
export function WebhookLogsCard({ empresaId }: { empresaId: string }) {
  const [logs, setLogs] = useState<WebhookLogDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroStatus, setFiltroStatus] = useState<string>("");
  const [limpando, setLimpando] = useState(false);
  const [expandidoId, setExpandidoId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ empresa_id: empresaId });
      if (filtroStatus) params.set("status", filtroStatus);
      const res = await fetch(`/api/admin/webhook-logs?${params.toString()}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        setLogs(data.logs ?? []);
      }
    } catch {
      // silencioso
    } finally {
      setLoading(false);
    }
  }, [empresaId, filtroStatus]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  async function handleLimpar() {
    setLimpando(true);
    try {
      const res = await fetch("/api/admin/webhook-logs/limpar", {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      showToast("sucesso", `${data.message} (${data.apagados} registos apagados).`);
      await carregar();
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao limpar logs.");
    } finally {
      setLimpando(false);
    }
  }

  return (
    <Card className="md:col-span-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="h-5 w-5 text-primary" />
            Caixa Negra — Webhooks do Smoobu
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-destructive hover:text-destructive"
              onClick={handleLimpar}
              disabled={limpando || loading}
            >
              {limpando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Limpar Antigos
            </Button>
            <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Toast */}
        {toast && (
          <div
            className={`flex items-center gap-3 rounded-md border p-3 text-sm ${
              toast.tipo === "sucesso"
                ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/50 text-destructive"
            }`}
          >
            {toast.tipo === "sucesso" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" />
            )}
            <span className="flex-1">{toast.msg}</span>
            <Button variant="ghost" size="sm" onClick={() => setToast(null)}>
              Fechar
            </Button>
          </div>
        )}

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={filtroStatus === "" ? "default" : "outline"} size="sm" onClick={() => setFiltroStatus("")}>
            Todos
          </Button>
          <Button
            variant={filtroStatus === "processado" ? "default" : "outline"}
            size="sm"
            onClick={() => setFiltroStatus("processado")}
          >
            Sucesso
          </Button>
          <Button
            variant={filtroStatus === "erro" ? "destructive" : "outline"}
            size="sm"
            onClick={() => setFiltroStatus("erro")}
          >
            Falhas
          </Button>
          <Button
            variant={filtroStatus === "recebido" ? "default" : "outline"}
            size="sm"
            onClick={() => setFiltroStatus("recebido")}
          >
            Pendentes
          </Button>
        </div>

        {/* Tabela */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar logs…
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
            <Webhook className="h-8 w-8 opacity-40" />
            <p className="text-sm">Sem logs de webhooks para esta empresa.</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/40">
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 font-medium">Data/Hora</th>
                  <th className="px-3 py-2 font-medium">Evento</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium">Erro</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map((log) => {
                  const expandido = expandidoId === log._id;
                  return (
                    <>
                      <tr
                        key={log._id}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpandidoId(expandido ? null : log._id)}
                      >
                        <td className="px-3 py-2 text-muted-foreground">
                          {expandido ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <Clock className="h-3 w-3" />
                            {formatarData(log.createdAt)}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium text-xs">
                          {extrairEvento(log.payload)}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={STATUS_VARIANT[log.status] ?? "secondary"} className="text-[10px]">
                            {STATUS_LABEL[log.status] ?? log.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 max-w-xs">
                          {log.erro_msg ? (
                            <span className="text-destructive text-xs line-clamp-1" title={log.erro_msg}>
                              {log.erro_msg}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                      {expandido && (
                        <tr key={`${log._id}-payload`} className="bg-muted/20">
                          <td colSpan={5} className="px-3 py-3">
                            <div className="rounded-md bg-background p-3">
                              <p className="mb-2 text-xs font-medium text-muted-foreground">
                                Payload completo recebido do Smoobu:
                              </p>
                              <pre className="max-h-64 overflow-auto rounded bg-muted/40 p-3 text-xs leading-relaxed">
                                {JSON.stringify(log.payload, null, 2)}
                              </pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {logs.length} registo(s) • Os logs com mais de 30 dias podem ser limpos com o botão acima.
        </p>
      </CardContent>
    </Card>
  );
}
