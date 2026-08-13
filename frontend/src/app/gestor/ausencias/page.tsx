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
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  adminPost,
  type AusenciaDTO,
  type UtilizadorDTO,
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

  // FIX (limpeza UI) — Estados `reaplicandoId` e `resultadoReaplicar` removidos.
  // A funcionalidade de reaplicar ausência foi removida da UI (era utilitário
  // de desenvolvimento). A reatribuição automática agora corre ao aprovar.

  // HF20 — Modal de criação de ausência (Date Range Picker).
  const [mostrarForm, setMostrarForm] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [equipa, setEquipa] = useState<UtilizadorDTO[]>([]);
  const [form, setForm] = useState({
    utilizador_id: "",
    data_inicio: "",
    data_fim: "",
    tipo: "ferias" as TipoAusenciaAmp,
    notas: "",
  });

  // FIX (gestão de folgas) — Estado para a secção "Dias de Folga".
  // Lista os staff ativos com os seus dias_folga fixos (0=Dom, 6=Sáb).
  const [folgasStaff, setFolgasStaff] = useState<UtilizadorDTO[]>([]);
  const [folgasLoading, setFolgasLoading] = useState(false);
  const [folgasErro, setFolgasErro] = useState<string | null>(null);

  /** FIX (gestão de folgas) — Carrega staff ativo com dias_folga. */
  async function carregarFolgas() {
    setFolgasLoading(true);
    setFolgasErro(null);
    try {
      const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
        "/api/gestor/equipa"
      );
      // Só staff ativo (não gestor/admin/parceiro, não inativo).
      setFolgasStaff(
        (data.utilizadores ?? []).filter(
          (u) => u.role === "staff" && u.ativo
        )
      );
    } catch (e) {
      setFolgasErro(e instanceof Error ? e.message : "Erro ao carregar folgas.");
    } finally {
      setFolgasLoading(false);
    }
  }

  /** Nomes dos dias da semana (0=Dom, 6=Sáb). */
  const DIA_SEMANA_NOMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

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
    // FIX (gestão de folgas) — Carrega também as folgas ao montar a página.
    carregarFolgas();
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

  /** HF20 — Abre o modal de criação e carrega a equipa. */
  async function abrirFormCriacao() {
    setMostrarForm(true);
    setFormErro(null);
    setForm({
      utilizador_id: "",
      data_inicio: "",
      data_fim: "",
      tipo: "ferias",
      notas: "",
    });
    // Carrega a equipa se ainda não foi carregada.
    if (equipa.length === 0) {
      try {
        const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
          "/api/gestor/equipa"
        );
        setEquipa(
          (data.utilizadores ?? []).filter(
            (u) => u.role === "staff" && u.ativo
          )
        );
      } catch {
        // Não bloqueia — o select fica vazio.
      }
    }
  }

  /** HF20 — Submete a nova ausência (intervalo de datas). */
  async function handleCriarAusencia() {
    if (!form.utilizador_id || !form.data_inicio || !form.data_fim) {
      setFormErro("Funcionário, Data de Início e Data de Fim são obrigatórios.");
      return;
    }
    if (form.data_fim < form.data_inicio) {
      setFormErro("Data de Fim não pode ser anterior à Data de Início.");
      return;
    }
    setSubmitting(true);
    setFormErro(null);
    try {
      await adminPost("/api/gestor/ausencias", {
        utilizador_id: form.utilizador_id,
        data_inicio: form.data_inicio,
        data_fim: form.data_fim,
        tipo: form.tipo,
        notas: form.notas || undefined,
      });
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar ausência.");
    } finally {
      setSubmitting(false);
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
        <div className="flex items-center gap-2">
          <Button onClick={abrirFormCriacao}>
            <Plus className="h-4 w-4" />
            Nova Ausência
          </Button>
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
      </div>

      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {erro}
          </CardContent>
        </Card>
      )}

      {/* FIX (gestão de folgas) — Separador entre "Ausências" e "Dias de Folga". */}
      <Tabs defaultValue="ausencias" className="w-full">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
          <TabsTrigger value="ausencias" className="gap-1.5">
            <CalendarOff className="h-4 w-4" />
            Ausências
          </TabsTrigger>
          <TabsTrigger value="folgas" className="gap-1.5">
            <CalendarX className="h-4 w-4" />
            Dias de Folga
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ausencias" className="space-y-4 mt-4">

      {/* FIX (limpeza UI) — Banner de "Reaplicar ausência" e Card de "Diagnóstico
          de ausências" removidos. Eram utilitários técnicos de desenvolvimento
          e testes que não devem estar presentes em produção. A funcionalidade
          de reaplicar ausência continua disponível via API
          (POST /api/gestor/ausencias/:id/reaplicar) se for necessário. */}

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
                            {/* FIX (limpeza UI) — Botão "Reaplicar ausência" removido.
                                Era utilitário técnico de desenvolvimento. A funcionalidade
                                de reatribuição automática agora corre ao aprovar a ausência
                                (sem necessidade de reaplicar manualmente). */}
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

        </TabsContent>

        {/* FIX (gestão de folgas) — Separador "Dias de Folga". */}
        <TabsContent value="folgas" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarX className="h-5 w-5 text-primary" />
                Folgas Fixas da Equipa
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Lista de funcionários ativos (staff) e os respetivos dias de
                folga fixos semanais. Para editar, vai à página{" "}
                <a href="/gestor/equipa" className="text-primary underline">
                  Equipa
                </a>
                .
              </p>

              {folgasLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />A carregar…
                </div>
              ) : folgasErro ? (
                <div className="flex items-center gap-2 py-8 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />{folgasErro}
                </div>
              ) : folgasStaff.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Não há staff ativo na equipa.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-4 py-3 font-medium">Nome</th>
                        <th className="px-4 py-3 font-medium">Dias de Folga</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {folgasStaff.map((staff) => {
                        const folgas = staff.dias_folga ?? [];
                        return (
                          <tr key={staff._id} className="hover:bg-muted/30">
                            <td className="px-4 py-3 font-medium">{staff.nome}</td>
                            <td className="px-4 py-3">
                              {folgas.length === 0 ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {folgas
                                    .slice()
                                    .sort((a, b) => a - b)
                                    .map((dia) => (
                                      <Badge key={dia} variant="outline" className="text-xs">
                                        {DIA_SEMANA_NOMES[dia] ?? `?${dia}`}
                                      </Badge>
                                    ))}
                                </div>
                              )}
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
        </TabsContent>
      </Tabs>

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

      {/* HF20 — Modal de criação de ausência (Date Range Picker) */}
      <Dialog
        open={mostrarForm}
        onOpenChange={(o) => !o && !submitting && setMostrarForm(false)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              Nova Ausência
            </DialogTitle>
            <DialogDescription>
              Regista um período de férias, doença ou outra ausência para um
              funcionário.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !submitting && setMostrarForm(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {/* Funcionário */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Funcionário</label>
            <select
              value={form.utilizador_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, utilizador_id: e.target.value }))
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Selecionar funcionário…</option>
              {equipa.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.nome}
                </option>
              ))}
            </select>
          </div>

          {/* Data de Início + Data de Fim (Date Range Picker) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Data de Início</label>
              <Input
                type="date"
                value={form.data_inicio}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_inicio: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Data de Fim</label>
              <Input
                type="date"
                value={form.data_fim}
                onChange={(e) =>
                  setForm((f) => ({ ...f, data_fim: e.target.value }))
                }
              />
            </div>
          </div>

          {/* Tipo */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Tipo</label>
            <select
              value={form.tipo}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  tipo: e.target.value as TipoAusenciaAmp,
                }))
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="ferias">Férias</option>
              <option value="doenca">Doença</option>
              <option value="outro">Outro</option>
            </select>
          </div>

          {/* Notas */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Notas (opcional)</label>
            <Input
              type="text"
              placeholder="Ex.: Férias pagas, baixa médica…"
              value={form.notas}
              onChange={(e) =>
                setForm((f) => ({ ...f, notas: e.target.value }))
              }
              maxLength={200}
            />
          </div>

          {formErro && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formErro}
            </p>
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
          <Button
            type="button"
            onClick={handleCriarAusencia}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A criar…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Criar Ausência
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
