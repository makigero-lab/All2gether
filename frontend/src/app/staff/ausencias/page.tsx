"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarOff,
  Plus,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Send,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminPatch } from "@/lib/api";
import { formatarDataSegura } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

// Prompt 131b — adicionado "cancelada" (soft cancel mantém histórico).
type EstadoAusencia = "pendente" | "aprovada" | "rejeitada" | "cancelada";
type TipoAusencia = "ferias" | "doenca" | "outro";

interface AusenciaDTO {
  _id: string;
  data_inicio: string;
  data_fim: string;
  tipo: TipoAusencia;
  estado: EstadoAusencia;
  notas?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const TIPO_LABEL: Record<TipoAusencia, string> = {
  ferias: "Férias",
  doenca: "Doença",
  outro: "Outro",
};

const ESTADO_CONFIG: Record<
  EstadoAusencia,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pendente: { label: "Pendente", variant: "secondary" },
  aprovada: { label: "Aprovada", variant: "default" },
  rejeitada: { label: "Rejeitada", variant: "destructive" },
  cancelada: { label: "Cancelada", variant: "outline" },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatarData(iso: string): string {
  return formatarDataSegura(
    iso,
    (d) => format(d, "d MMM yyyy", { locale: pt }),
    iso
  );
}

/**
 * v1.56.0 (Prompt 78) — Formata "YYYY-MM-DD" (vindo de <input type="date">)
 * para "d MMM yyyy" legível no modal de confirmação.
 * O parseISO do date-fns interpreta "YYYY-MM-DD" como meia-noite UTC, e o
 * format converte para a timezone local — pode deslocar -1 dia em some TZ.
 * Por isso usamos new Date(year, month-1, day) que é local.
 */
function formatarDataISO(yyyymmdd: string): string {
  if (!yyyymmdd) return "—";
  const parts = yyyymmdd.split("-");
  if (parts.length !== 3) return yyyymmdd;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return yyyymmdd;
  try {
    return format(new Date(y, m - 1, d), "d MMM yyyy", { locale: pt });
  } catch {
    return yyyymmdd;
  }
}

/** Faz fetch autenticado ao proxy /api/staff/* (cookie httpOnly). */
async function staffFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.erro || `Erro ${res.status}`);
  }
  return data as T;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function StaffAusenciasPage() {
  const [ausencias, setAusencias] = useState<AusenciaDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);

  // Modal de novo pedido.
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form, setForm] = useState({
    tipo: "ferias" as TipoAusencia,
    data_inicio: "",
    data_fim: "",
    notas: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);

  // v1.56.0 (Prompt 78) — Modal de confirmação antes de submeter.
  const [mostrarConfirmacao, setMostrarConfirmacao] = useState(false);

  // Cancelar pedido (Prompt 131b — soft cancel via PATCH /api/gestor/ausencias/:id/cancelar).
  const [aCancelar, setACancelar] = useState<AusenciaDTO | null>(null);
  const [cancelando, setCancelando] = useState(false);

  /** Carrega o histórico de ausências do staff. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await staffFetch<{ ausencias: AusenciaDTO[] }>(
        "/api/staff/ausencias"
      );
      setAusencias(res.ausencias ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar pedidos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /**
   * v1.56.0 (Prompt 78) — Valida o formulário e abre o modal de confirmação
   * (NÃO submete imediatamente). A submissão real acontece em handleConfirmarEnvio.
   */
  function handleValidarEConfirmar(e: React.FormEvent) {
    e.preventDefault();
    setFormErro(null);

    if (!form.data_inicio || !form.data_fim) {
      setFormErro("Datas de início e fim são obrigatórias.");
      return;
    }
    if (form.data_fim < form.data_inicio) {
      setFormErro("Data de fim não pode ser anterior à de início.");
      return;
    }

    // Validação OK — abre o modal de confirmação.
    setMostrarConfirmacao(true);
  }

  /** Submete o pedido após confirmação do utilizador. */
  async function handleConfirmarEnvio() {
    setFormErro(null);
    setSubmitting(true);
    try {
      await staffFetch("/api/staff/ausencias", {
        method: "POST",
        body: JSON.stringify({
          data_inicio: form.data_inicio,
          data_fim: form.data_fim,
          tipo: form.tipo,
          notas: form.notas.trim() || undefined,
        }),
      });
      setSucesso("Pedido enviado para aprovação.");
      setForm({ tipo: "ferias", data_inicio: "", data_fim: "", notas: "" });
      setMostrarConfirmacao(false);
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar pedido.");
      setMostrarConfirmacao(false);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Prompt 131b — Cancela (soft cancel) um pedido pendente ou aprovado.
   * Usa PATCH /api/gestor/ausencias/:id/cancelar (mantém o registo para
   * histórico, ao contrário do DELETE que apagava o registo).
   * O endpoint aceita staff (só as suas ausências) e gestor/admin.
   */
  async function handleCancelar() {
    if (!aCancelar) return;
    setCancelando(true);
    try {
      await adminPatch(`/api/gestor/ausencias/${aCancelar._id}/cancelar`);
      setSucesso("Pedido cancelado.");
      setACancelar(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao cancelar pedido.");
      setACancelar(null);
    } finally {
      setCancelando(false);
    }
  }

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
          <CalendarOff className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">
            Pedidos de Ausência
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Pede férias ou reporta ausência. O admin aprova.
        </p>
      </header>

      {/* Conteúdo */}
      <main className="flex-1 space-y-4 p-5">
        {/* Mensagens de feedback */}
        {sucesso && (
          <Card className="border-emerald-500/50">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <span className="flex-1">{sucesso}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => setSucesso(null)}
              >
                ×
              </Button>
            </CardContent>
          </Card>
        )}

        {erro && (
          <Card className="border-destructive/50">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{erro}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={carregar}
                className="ml-auto"
              >
                Tentar
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Botão Novo Pedido */}
        <Button
          onClick={() => {
            setMostrarForm(true);
            setFormErro(null);
          }}
          className="w-full justify-center gap-2"
        >
          <Plus className="h-4 w-4" />
          Novo Pedido de Ausência
        </Button>

        {/* Lista de pedidos */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar pedidos…
          </div>
        ) : ausencias.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <CalendarOff className="h-10 w-10 opacity-40" />
              <p className="text-sm">Ainda não fizeste nenhum pedido.</p>
              <p className="text-xs">
                Clica em “Novo Pedido” para pedir férias ou reportar ausência.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {ausencias.map((a) => {
              const config = ESTADO_CONFIG[a.estado];
              return (
                <Card key={a._id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {TIPO_LABEL[a.tipo]}
                          </span>
                          <Badge variant={config.variant}>{config.label}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatarData(a.data_inicio)}
                          {a.data_inicio !== a.data_fim && (
                            <> → {formatarData(a.data_fim)}</>
                          )}
                        </p>
                        {a.notas && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {a.notas}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          Pedido em {formatarData(a.createdAt)}
                        </p>
                      </div>
                      {/* Prompt 131b — Botão Cancelar (soft cancel) visível
                          para pendentes E aprovadas (não rejeitadas/canceladas). */}
                      {(a.estado === "pendente" || a.estado === "aprovada") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                          onClick={() => setACancelar(a)}
                          aria-label="Cancelar pedido"
                          title="Cancelar pedido"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>

      {/* Modal Novo Pedido */}
      <Dialog open={mostrarForm} onOpenChange={setMostrarForm}>
        <DialogHeader>
          <DialogTitle>Novo Pedido de Ausência</DialogTitle>
          <DialogDescription>
            O teu pedido fica pendente até o admin aprovar.
          </DialogDescription>
          <DialogClose onClick={() => setMostrarForm(false)} />
        </DialogHeader>
        <form onSubmit={handleValidarEConfirmar}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="tipo" className="text-sm font-medium">
                Tipo
              </label>
              <select
                id="tipo"
                value={form.tipo}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tipo: e.target.value as TipoAusencia }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="ferias">Férias</option>
                <option value="doenca">Doença</option>
                <option value="outro">Outro</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="data_inicio" className="text-sm font-medium">
                Data de Início
              </label>
              <input
                id="data_inicio"
                type="date"
                value={form.data_inicio}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_inicio: e.target.value }))
                }
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="data_fim" className="text-sm font-medium">
                Data de Fim
              </label>
              <input
                id="data_fim"
                type="date"
                value={form.data_fim}
                min={form.data_inicio || undefined}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_fim: e.target.value }))
                }
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="notas" className="text-sm font-medium">
                Notas (opcional)
              </label>
              <textarea
                id="notas"
                value={form.notas}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notas: e.target.value }))
                }
                rows={2}
                placeholder="Ex.: Férias planeadas, atestado médico…"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {formErro && (
              <p className="text-sm text-destructive">{formErro}</p>
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
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A enviar…
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Rever Pedido
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* ---------------------------------------------------------------
          Modal de Confirmação (Prompt 78, ponto 3)
          Mostra Tipo + Data Início + Data Fim antes de submeter.
          --------------------------------------------------------------- */}
      <Dialog open={mostrarConfirmacao} onOpenChange={setMostrarConfirmacao}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            Confirmar Pedido de Ausência
          </DialogTitle>
          <DialogDescription>
            Confirma os dados abaixo antes de enviar para aprovação.
          </DialogDescription>
          <DialogClose onClick={() => !submitting && setMostrarConfirmacao(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Tipo</span>
              <span className="text-sm font-semibold">
                {TIPO_LABEL[form.tipo]}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Data de Início</span>
              <span className="text-sm font-semibold tabular-nums">
                {formatarDataISO(form.data_inicio)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Data de Fim</span>
              <span className="text-sm font-semibold tabular-nums">
                {formatarDataISO(form.data_fim)}
              </span>
            </div>
            {form.notas.trim() && (
              <div className="border-t pt-2">
                <span className="text-xs text-muted-foreground">Notas:</span>
                <p className="mt-0.5 text-sm">{form.notas.trim()}</p>
              </div>
            )}
          </div>
          {formErro && (
            <p className="text-sm text-destructive">{formErro}</p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarConfirmacao(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleConfirmarEnvio}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A enviar…
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Confirmar Envio
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---------------------------------------------------------------
          Prompt 131b — Modal de Confirmação de Cancelamento (soft cancel)
          Pede confirmação antes de marcar a ausência como 'cancelada'.
          --------------------------------------------------------------- */}
      <Dialog open={aCancelar !== null} onOpenChange={(o) => !o && !cancelando && setACancelar(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <X className="h-5 w-5 text-destructive" />
            Cancelar Pedido de Ausência
          </DialogTitle>
          <DialogDescription>
            Tens a certeza que queres cancelar este pedido? O registo fica
            marcado como <strong>cancelado</strong> (mantém-se no histórico).
          </DialogDescription>
          <DialogClose onClick={() => !cancelando && setACancelar(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aCancelar && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Tipo</span>
                <span className="text-sm font-semibold">
                  {TIPO_LABEL[aCancelar.tipo]}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Estado atual</span>
                <Badge variant={ESTADO_CONFIG[aCancelar.estado].variant}>
                  {ESTADO_CONFIG[aCancelar.estado].label}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Data de Início</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatarData(aCancelar.data_inicio)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Data de Fim</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatarData(aCancelar.data_fim)}
                </span>
              </div>
              {aCancelar.notas && (
                <div className="border-t pt-2">
                  <span className="text-xs text-muted-foreground">Notas:</span>
                  <p className="mt-0.5 text-sm">{aCancelar.notas}</p>
                </div>
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
                Cancelar Pedido
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
