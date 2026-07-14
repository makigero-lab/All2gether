"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarOff,
  Loader2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Plane,
  Stethoscope,
  CalendarX,
  CircleDot,
  Check,
  X,
} from "lucide-react";

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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  adminGet,
  adminDelete,
  adminPatch,
  type AusenciaDTO,
} from "@/lib/api";
import { parsearDataSegura } from "@/lib/utils";

/**
 * /gestor/ausencias — Ecrã de Férias/Ausências (Prompt 95 / Fase 1.5).
 *
 * Tabela definitiva com TODAS as ausências da empresa (sem filtros de
 * estado), com coluna de Ações:
 *   - Aprovar / Rejeitar (para pendentes e pendente_emergencia)
 *   - Eliminar (DELETE)
 *
 * Unifica a visão geral + aprovação num só ecrã (a tab "Aprovações de
 * Férias" da página de Equipa deixou de ser necessária).
 */

// Alargamento local do TipoAusencia (o backend usa mais valores que o tipo
// estrito do api.ts: ferias, doenca, folga, outro).
type TipoAusenciaAmp = "ferias" | "doenca" | "folga" | "outro";

interface AusenciaAmp extends Omit<AusenciaDTO, "tipo"> {
  tipo: TipoAusenciaAmp;
  estado?: string;
  notas?: string;
}

const TIPO_LABEL: Record<TipoAusenciaAmp, string> = {
  ferias: "Férias",
  doenca: "Doença",
  folga: "Folga",
  outro: "Outro",
};

const TIPO_ICON: Record<TipoAusenciaAmp, React.ComponentType<{ className?: string }>> = {
  ferias: Plane,
  doenca: Stethoscope,
  folga: CalendarX,
  outro: CircleDot,
};

const ESTADO_LABEL: Record<string, string> = {
  pendente: "Pendente",
  pendente_emergencia: "Emergência",
  aprovada: "Aprovada",
  rejeitada: "Rejeitada",
  // Prompt 131b — soft cancel mantém histórico.
  cancelada: "Cancelada",
};

const ESTADO_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  pendente: "warning",
  pendente_emergencia: "destructive",
  aprovada: "success",
  rejeitada: "secondary",
  cancelada: "outline",
};

function formatarData(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    return d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatarPeriodo(inicio: string, fim: string): string {
  const i = formatarData(inicio);
  const f = formatarData(fim);
  return i === f ? i : `${i} → ${f}`;
}

export default function AusenciasPage() {
  const [ausencias, setAusencias] = useState<AusenciaAmp[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Modal de confirmação de eliminação.
  const [aEliminar, setAEliminar] = useState<AusenciaAmp | null>(null);
  const [eliminando, setEliminando] = useState(false);

  // Prompt 131b — Modal de confirmação de cancelamento (soft cancel).
  const [aCancelar, setACancelar] = useState<AusenciaAmp | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      // Sem filtros → devolve TODAS as ausências da empresa.
      const data = await adminGet<{ ausencias: AusenciaAmp[] }>(
        "/api/gestor/ausencias"
      );
      setAusencias(data.ausencias ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar ausências.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleEliminar() {
    if (!aEliminar) return;
    setEliminando(true);
    try {
      // Otimismo: remove da UI imediatamente.
      setAusencias((prev) => prev.filter((a) => a._id !== aEliminar._id));
      await adminDelete(`/api/gestor/ausencias/${aEliminar._id}`);
      setAEliminar(null);
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(e instanceof Error ? e.message : "Erro ao eliminar ausência.");
    } finally {
      setEliminando(false);
    }
  }

  /** Aprovar / Rejeitar ausência pendente (PATCH .../estado). */
  async function handleMudarEstado(a: AusenciaAmp, novoEstado: "aprovada" | "rejeitada") {
    // Otimismo: atualiza a UI imediatamente.
    setAusencias((prev) =>
      prev.map((x) => (x._id === a._id ? { ...x, estado: novoEstado } : x))
    );
    try {
      await adminPatch(`/api/gestor/ausencias/${a._id}/estado`, { estado: novoEstado });
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(e instanceof Error ? e.message : `Erro ao ${novoEstado === "aprovada" ? "aprovar" : "rejeitar"} ausência.`);
    }
  }

  /**
   * Prompt 131b — Cancela (soft cancel) uma ausência pendente ou aprovada.
   * Usa PATCH /api/gestor/ausencias/:id/cancelar (mantém o registo para
   * histórico, ao contrário do DELETE que apaga o registo).
   */
  async function handleCancelar() {
    if (!aCancelar) return;
    setCancelando(true);
    try {
      // Otimismo: atualiza a UI imediatamente.
      setAusencias((prev) =>
        prev.map((x) =>
          x._id === aCancelar._id ? { ...x, estado: "cancelada" } : x
        )
      );
      await adminPatch(`/api/gestor/ausencias/${aCancelar._id}/cancelar`);
      setACancelar(null);
    } catch (e) {
      // Reverte em caso de erro.
      await carregar();
      setErro(e instanceof Error ? e.message : "Erro ao cancelar ausência.");
      setACancelar(null);
    } finally {
      setCancelando(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarOff className="h-6 w-6 text-primary" />
            Ausências / Férias
          </h1>
          <p className="text-sm text-muted-foreground">
            Todas as ausências da empresa (férias, doença, folgas, emergências).
          </p>
        </div>
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

      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {erro}
          </CardContent>
        </Card>
      )}

      {/* Tabela de ausências */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Ausências Registadas ({ausencias.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : ausencias.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <CalendarOff className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Sem ausências registadas.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Funcionário</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    <th className="px-4 py-3 font-medium">Período</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Notas</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ausencias.map((a) => {
                    const TipoIcon = TIPO_ICON[a.tipo] ?? CircleDot;
                    return (
                      <tr key={a._id} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">
                          {a.utilizador?.nome ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5">
                            <TipoIcon className="h-4 w-4 text-muted-foreground" />
                            {TIPO_LABEL[a.tipo] ?? a.tipo}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatarPeriodo(a.data_inicio, a.data_fim)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              ESTADO_VARIANT[a.estado ?? ""] ?? "secondary"
                            }
                          >
                            {ESTADO_LABEL[a.estado ?? ""] ?? a.estado ?? "—"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          {a.notas ? (
                            <span
                              className="line-clamp-2 text-muted-foreground"
                              title={a.notas}
                            >
                              {a.notas}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {/* Aprovar / Rejeitar (só para pendentes) */}
                            {(a.estado === "pendente" || a.estado === "pendente_emergencia") && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                                  onClick={() => handleMudarEstado(a, "aprovada")}
                                  aria-label="Aprovar"
                                  title="Aprovar"
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => handleMudarEstado(a, "rejeitada")}
                                  aria-label="Rejeitar"
                                  title="Rejeitar"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            {/* Prompt 131b — Cancelar (soft cancel).
                                Só para pendentes ou aprovadas (não rejeitadas/canceladas).
                                Usa X icon com cor âmbar para distinguir do Rejeitar (vermelho). */}
                            {(a.estado === "pendente" || a.estado === "aprovada") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                onClick={() => setACancelar(a)}
                                aria-label="Cancelar ausência"
                                title="Cancelar (mantém no histórico)"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                            {/* Eliminar (hard delete) */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setAEliminar(a)}
                              aria-label="Eliminar ausência"
                              title="Eliminar (apaga definitivamente)"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal de confirmação de eliminação */}
      <Dialog
        open={aEliminar !== null}
        onOpenChange={(o) => !o && setAEliminar(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Eliminar Ausência
            </DialogTitle>
            <DialogDescription>
              Tens a certeza que queres eliminar esta ausência? Esta ação é
              permanente.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setAEliminar(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aEliminar && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p>
                <strong>Funcionário:</strong>{" "}
                {aEliminar.utilizador?.nome ?? "—"}
              </p>
              <p>
                <strong>Tipo:</strong> {TIPO_LABEL[aEliminar.tipo] ?? aEliminar.tipo}
              </p>
              <p>
                <strong>Período:</strong>{" "}
                {formatarPeriodo(aEliminar.data_inicio, aEliminar.data_fim)}
              </p>
              {aEliminar.notas && (
                <p>
                  <strong>Notas:</strong> {aEliminar.notas}
                </p>
              )}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAEliminar(null)}
            disabled={eliminando}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleEliminar}
            disabled={eliminando}
          >
            {eliminando ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A eliminar…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                Eliminar
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 131b — Modal de confirmação de cancelamento (soft cancel).
          Mantém o registo no histórico (apenas marca estado='cancelada'). */}
      <Dialog
        open={aCancelar !== null}
        onOpenChange={(o) => !o && !cancelando && setACancelar(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <X className="h-5 w-5 text-amber-600" />
              Cancelar Ausência
            </DialogTitle>
            <DialogDescription>
              Vais cancelar esta ausência. O registo fica marcado como
              <strong> cancelada</strong> (mantém-se no histórico para
              auditoria). Se a ausência estava aprovada, as tarefas
              desatribuídas terão de ser reatribuídas manualmente.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !cancelando && setACancelar(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {aCancelar && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p>
                <strong>Funcionário:</strong>{" "}
                {aCancelar.utilizador?.nome ?? "—"}
              </p>
              <p>
                <strong>Tipo:</strong> {TIPO_LABEL[aCancelar.tipo] ?? aCancelar.tipo}
              </p>
              <p>
                <strong>Período:</strong>{" "}
                {formatarPeriodo(aCancelar.data_inicio, aCancelar.data_fim)}
              </p>
              <p>
                <strong>Estado atual:</strong>{" "}
                {ESTADO_LABEL[aCancelar.estado ?? ""] ?? aCancelar.estado ?? "—"}
              </p>
              {aCancelar.notas && (
                <p>
                  <strong>Notas:</strong> {aCancelar.notas}
                </p>
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
                Cancelar Ausência
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
