"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Webhook as WebhookIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Clock,
  RotateCcw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { adminGet, adminPost } from "@/lib/api";
import { parsearDataSegura } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

type WebhookStatus = "recebido" | "processado" | "erro";

interface WebhookLogDTO {
  _id: string;
  payload: Record<string, unknown>;
  status: WebhookStatus;
  erro_msg: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhooksResponse {
  webhooks: WebhookLogDTO[];
  total: number;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const STATUS_CONFIG: Record<
  WebhookStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof CheckCircle2 }
> = {
  recebido: { label: "Recebido", variant: "outline", icon: Clock },
  processado: { label: "Processado", variant: "default", icon: CheckCircle2 },
  erro: { label: "Erro", variant: "destructive", icon: AlertCircle },
};

const FILTROS: { id: WebhookStatus | "todos"; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "recebido", label: "Recebidos" },
  { id: "processado", label: "Processados" },
  { id: "erro", label: "Com erro" },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatarData(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  return d.toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Extrai info útil do payload para mostrar na linha (action + reserva + propriedade). */
function extrairResumo(payload: WebhookLogDTO["payload"]): {
  action?: string;
  reservaId?: string | number;
  propId?: string | number;
  arrival?: string;
} {
  const data = (payload?.data as Record<string, unknown> | undefined) ?? undefined;
  const content = (payload?.content as Record<string, unknown> | undefined) ?? payload ?? {};
  const apartment =
    (data?.apartment as Record<string, unknown> | undefined) ??
    (content.apartment as Record<string, unknown> | undefined);
  return {
    action: (payload?.action as string) ?? (content.action as string) ?? "—",
    reservaId: (data?.id as string | number) ?? (content.id as string | number),
    propId: apartment?.id as string | number,
    arrival: (data?.arrival as string) ?? (content.arrival as string),
  };
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookLogDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<WebhookStatus | "todos">("todos");
  const [expandido, setExpandido] = useState<string | null>(null);
  const [reprocessando, setReprocessando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const query = filtro !== "todos" ? `?status=${filtro}` : "";
      const res = await adminGet<WebhooksResponse>(`/api/gestor/webhooks${query}`);
      setWebhooks(res.webhooks ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar webhooks.");
    } finally {
      setLoading(false);
    }
  }, [filtro]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const handleReprocessar = async (id: string) => {
    setReprocessando(id);
    try {
      await adminPost(`/api/gestor/webhooks/${id}/reprocessar`, {});
      // Recarrega para mostrar o novo estado.
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao reprocessar webhook.");
    } finally {
      setReprocessando(null);
    }
  };

  // Contagens rápidas para os cartões de filtro.
  const contagens = {
    todos: total,
    recebido: webhooks.filter((w) => w.status === "recebido").length,
    processado: webhooks.filter((w) => w.status === "processado").length,
    erro: webhooks.filter((w) => w.status === "erro").length,
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Webhooks do Smoobu</h1>
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
        <p className="text-sm text-muted-foreground">
          Histórico de webhooks recebidos do Smoobu. Confirma que estão a chegar e vê
          o estado de processamento (payload bruto + erros). Reproccessa os que falharam.
        </p>
      </div>

      {/* Cartões de filtro + contagem */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FILTROS.map((f) => {
          const count = contagens[f.id];
          const ativo = filtro === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFiltro(f.id)}
              className={`flex items-center justify-between rounded-lg border p-4 text-left transition-colors ${
                ativo
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:bg-accent"
              }`}
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{f.label}</span>
                <span className="text-2xl font-bold leading-tight">{count}</span>
              </div>
              {f.id === "erro" && count > 0 ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : f.id === "processado" ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              ) : f.id === "recebido" ? (
                <Clock className="h-5 w-5 text-muted-foreground" />
              ) : (
                <WebhookIcon className="h-5 w-5 text-muted-foreground" />
              )}
            </button>
          );
        })}
      </div>

      {/* Estado de erro */}
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

      {/* Lista de webhooks */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WebhookIcon className="h-5 w-5 text-primary" />
            Logs recentes
          </CardTitle>
          <CardDescription>
            {total} webhook(s) no total. Ordenados por data decrescente.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar webhooks…
            </div>
          ) : webhooks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <WebhookIcon className="h-10 w-10 opacity-40" />
              <p className="text-sm">Sem webhooks para este filtro.</p>
              <p className="text-xs">
                Quando o Smoobu enviar uma reserva, aparecerá aqui automaticamente.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {webhooks.map((w) => {
                const resumo = extrairResumo(w.payload);
                const config = STATUS_CONFIG[w.status];
                const StatusIcon = config.icon;
                const isOpen = expandido === w._id;
                return (
                  <div key={w._id} className="px-4 py-3">
                    {/* Linha resumo */}
                    <button
                      onClick={() => setExpandido(isOpen ? null : w._id)}
                      className="flex w-full items-center gap-3 text-left"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <StatusIcon
                        className={`h-4 w-4 shrink-0 ${
                          w.status === "erro"
                            ? "text-destructive"
                            : w.status === "processado"
                            ? "text-emerald-500"
                            : "text-muted-foreground"
                        }`}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={config.variant} className="shrink-0">
                            {config.label}
                          </Badge>
                          <span className="text-sm font-medium">
                            {resumo.action}
                          </span>
                          {resumo.reservaId != null && (
                            <span className="text-xs text-muted-foreground">
                              Reserva #{String(resumo.reservaId)}
                            </span>
                          )}
                          {resumo.propId != null && (
                            <span className="text-xs text-muted-foreground">
                              · Prop #{String(resumo.propId)}
                            </span>
                          )}
                          {resumo.arrival && (
                            <span className="text-xs text-muted-foreground">
                              · Check-in {resumo.arrival}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatarData(w.createdAt)}
                        </span>
                      </div>
                      {/* Botão reproccessar (para não expandir ao clicar) */}
                      {w.status === "erro" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          disabled={reprocessando === w._id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleReprocessar(w._id);
                          }}
                        >
                          {reprocessando === w._id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1.5 hidden sm:inline">Reprocessar</span>
                        </Button>
                      )}
                    </button>

                    {/* Detalhe expandido */}
                    {isOpen && (
                      <div className="mt-3 space-y-3 pl-11">
                        {w.erro_msg && (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                            <p className="text-xs font-semibold text-destructive">
                              Erro de processamento:
                            </p>
                            <p className="mt-1 font-mono text-xs text-destructive/90 break-all">
                              {w.erro_msg}
                            </p>
                          </div>
                        )}
                        <div>
                          <p className="mb-1 text-xs font-semibold text-muted-foreground">
                            Payload bruto:
                          </p>
                          <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
                            <code>{JSON.stringify(w.payload, null, 2)}</code>
                          </pre>
                        </div>
                        {w.status !== "processado" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={reprocessando === w._id}
                            onClick={() => handleReprocessar(w._id)}
                          >
                            {reprocessando === w._id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1.5">
                              {w.status === "erro" ? "Reprocessar" : "Reprocessar à mesma"}
                            </span>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
