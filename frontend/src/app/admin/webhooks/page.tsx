"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Webhook,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { lerUtilizador } from "@/lib/auth";
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

export default function AdminWebhooksPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [logs, setLogs] = useState<WebhookLogDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroStatus, setFiltroStatus] = useState<string>("");
  const [limpando, setLimpando] = useState(false);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const params = filtroStatus ? `?status=${filtroStatus}` : "";
      const res = await fetch(`/api/admin/webhook-logs${params}`, { credentials: "include" });
      const data = await res.json();
      if (res.ok) {
        setLogs(data.logs ?? []);
      }
    } catch {
      // silencioso
    } finally {
      setLoading(false);
    }
  }, [filtroStatus]);

  useEffect(() => {
    let redirecionado = false;
    lerUtilizador()
      .then((u) => {
        if (u === null || u.role !== "admin") {
          redirecionado = true;
          router.replace("/login");
          return;
        }
        setAuthChecked(true);
        return carregar();
      })
      .catch(() => {
        if (!redirecionado) router.replace("/login");
      });
  }, [carregar, router]);

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

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Webhook className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Caixa Negra — Webhooks</h1>
            <p className="text-sm text-muted-foreground">Monitor de webhooks do Smoobu (todas as empresas)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-destructive hover:text-destructive"
            onClick={handleLimpar}
            disabled={limpando || loading}
          >
            {limpando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Limpar Logs Antigos
          </Button>
          <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <Card className={toast.tipo === "sucesso" ? "border-emerald-500/50" : "border-destructive/50"}>
          <CardContent className={`flex items-center gap-3 p-4 text-sm ${toast.tipo === "sucesso" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {toast.tipo === "sucesso" ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertCircle className="h-5 w-5 shrink-0" />}
            <span className="flex-1">{toast.msg}</span>
            <Button variant="ghost" size="sm" onClick={() => setToast(null)}>Fechar</Button>
          </CardContent>
        </Card>
      )}

      {/* Filtros */}
      <div className="flex items-center gap-2">
        <Button variant={filtroStatus === "" ? "default" : "outline"} size="sm" onClick={() => setFiltroStatus("")}>
          Todos
        </Button>
        <Button variant={filtroStatus === "processado" ? "default" : "outline"} size="sm" onClick={() => setFiltroStatus("processado")}>
          Sucesso
        </Button>
        <Button variant={filtroStatus === "erro" ? "destructive" : "outline"} size="sm" onClick={() => setFiltroStatus("erro")}>
          Falhas
        </Button>
        <Button variant={filtroStatus === "recebido" ? "default" : "outline"} size="sm" onClick={() => setFiltroStatus("recebido")}>
          Pendentes
        </Button>
      </div>

      {/* Tabela */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar logs…
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Webhook className="h-8 w-8 opacity-40" />
              <p className="text-sm">Sem logs de webhooks.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Data/Hora</th>
                    <th className="px-4 py-3 font-medium">Evento</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Erro</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {logs.map((log) => (
                    <tr key={log._id} className="hover:bg-muted/30">
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          {formatarData(log.createdAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {extrairEvento(log.payload)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_VARIANT[log.status] ?? "secondary"}>
                          {STATUS_LABEL[log.status] ?? log.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 max-w-md">
                        {log.erro_msg ? (
                          <span className="text-destructive text-xs">{log.erro_msg}</span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        {logs.length} registo(s) • Os logs com mais de 30 dias podem ser limpos com o botão acima.
      </p>
    </div>
  );
}
