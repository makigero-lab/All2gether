"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarCheck,
  Loader2,
  AlertCircle,
  RefreshCw,
  Check,
  X,
  CheckCircle2,
  User,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { adminGet, adminPatch, type Role } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface AusenciaDTO {
  _id: string;
  utilizador_id: string;
  utilizador: {
    _id: string;
    nome: string;
    email: string;
    role: Role;
  } | null;
  data_inicio: string;
  data_fim: string;
  tipo: string;
  estado: string;
  justificacao?: string;
  notas?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const TIPO_LABEL: Record<string, string> = {
  ferias: "Férias",
  doenca: "Doença",
  outro: "Outro",
};

const TIPO_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  ferias: "default",
  doenca: "secondary",
  outro: "outline",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatarData(iso: string): string {
  try {
    return format(parseISO(iso), "d MMM yyyy", { locale: pt });
  } catch {
    return iso;
  }
}

function primeiroNome(nome: string | undefined): string {
  if (!nome) return "—";
  return nome.split(" ")[0];
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function AprovacoesPage() {
  const [pendentes, setPendentes] = useState<AusenciaDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    tipo: "sucesso" | "erro";
    msg: string;
  } | null>(null);
  const [processando, setProcessando] = useState<string | null>(null);

  /** Carrega as ausências pendentes da empresa. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await adminGet<{ ausencias: AusenciaDTO[] }>(
        "/api/admin/ausencias?estado=pendente,pendente_emergencia"
      );
      setPendentes(res.ausencias ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar pedidos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Aprova um pedido e mostra toast com o resultado da redistribuição. */
  async function handleAprovar(a: AusenciaDTO) {
    setProcessando(`aprovar-${a._id}`);
    setErro(null);
    try {
      const res = await adminPatch<{
        mensagem: string;
        redistribuicao: { total: number; reatribuidas: number; orfas: number } | null;
      }>(`/api/admin/ausencias/${a._id}/estado`, { estado: "aprovada" });

      const r = res.redistribuicao;
      const msg =
        r && r.total > 0
          ? `Férias aprovadas. As tarefas deste funcionário foram redistribuídas com sucesso! (${r.reatribuidas} reatribuída(s)${r.orfas > 0 ? `, ${r.orfas} órfã(s)` : ""})`
          : "Férias aprovadas. Sem tarefas para redistribuir no período.";
      setToast({ tipo: "sucesso", msg });

      // Remove da lista de pendentes (já foi decidido).
      setPendentes((prev) => prev.filter((p) => p._id !== a._id));
    } catch (e) {
      setToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro ao aprovar: ${e.message}` : "Erro ao aprovar pedido.",
      });
    } finally {
      setProcessando(null);
    }
  }

  /** Rejeita um pedido. */
  async function handleRejeitar(a: AusenciaDTO) {
    setProcessando(`rejeitar-${a._id}`);
    setErro(null);
    try {
      await adminPatch(`/api/admin/ausencias/${a._id}/estado`, {
        estado: "rejeitada",
      });
      setToast({ tipo: "sucesso", msg: "Pedido rejeitado." });
      setPendentes((prev) => prev.filter((p) => p._id !== a._id));
    } catch (e) {
      setToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro ao rejeitar: ${e.message}` : "Erro ao rejeitar pedido.",
      });
    } finally {
      setProcessando(null);
    }
  }

  // Auto-esconde o toast após 6s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Pedidos de Férias</h1>
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
          Aprova ou rejeita os pedidos de ausência da equipa. Aprovar redistribui
          automaticamente as tarefas do período.
        </p>
      </div>

      {/* Toast (inline, não usa biblioteca externa) */}
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

      {/* Erro de carregamento */}
      {erro && !loading && (
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

      {/* Conteúdo */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar pedidos…
        </div>
      ) : pendentes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <CalendarCheck className="h-12 w-12 opacity-40" />
            <p className="text-sm font-medium">Sem pedidos pendentes</p>
            <p className="text-xs">
              Quando um funcionário pedir férias ou ausência, aparece aqui para aprovação.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarCheck className="h-5 w-5 text-primary" />
              Pedidos pendentes
              <Badge variant="secondary" className="ml-1">
                {pendentes.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              Aprovar redistribui as tarefas do período; rejeitar mantém as tarefas.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {/* Tabela (desktop) */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Funcionário</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    <th className="px-4 py-3 font-medium">Datas</th>
                    <th className="px-4 py-3 font-medium">Notas</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendentes.map((a) => (
                    <tr key={a._id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">
                                {a.utilizador?.nome ?? "—"}
                              </span>
                              {a.estado === "pendente_emergencia" && (
                                <Badge variant="destructive" className="text-[10px]">
                                  🚨 Emergência
                                </Badge>
                              )}
                            </div>
                            {a.utilizador?.email && (
                              <div className="text-xs text-muted-foreground">
                                {a.utilizador.email}
                              </div>
                            )}
                            {a.justificacao && (
                              <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-500">
                                {a.justificacao}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={TIPO_VARIANT[a.tipo] ?? "outline"}>
                          {TIPO_LABEL[a.tipo] ?? a.tipo}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-muted-foreground">
                          {formatarData(a.data_inicio)}
                          {a.data_inicio !== a.data_fim && (
                            <> → {formatarData(a.data_fim)}</>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {a.notas ? (
                          <span className="line-clamp-2 max-w-xs">{a.notas}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            onClick={() => handleAprovar(a)}
                            disabled={processando !== null}
                          >
                            {processando === `aprovar-${a._id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            Aprovar
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleRejeitar(a)}
                            disabled={processando !== null}
                          >
                            {processando === `rejeitar-${a._id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <X className="h-3.5 w-3.5" />
                            )}
                            Rejeitar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards (mobile) */}
            <div className="space-y-3 p-4 md:hidden">
              {pendentes.map((a) => (
                <div
                  key={a._id}
                  className="rounded-lg border p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">
                        {a.utilizador?.nome ?? "—"}
                      </span>
                      {a.estado === "pendente_emergencia" && (
                        <Badge variant="destructive" className="text-[10px]">
                          🚨
                        </Badge>
                      )}
                    </div>
                    <Badge variant={TIPO_VARIANT[a.tipo] ?? "outline"}>
                      {TIPO_LABEL[a.tipo] ?? a.tipo}
                    </Badge>
                  </div>
                  {a.justificacao && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      {a.justificacao}
                    </p>
                  )}
                  <div className="text-sm text-muted-foreground">
                    {formatarData(a.data_inicio)}
                    {a.data_inicio !== a.data_fim && (
                      <> → {formatarData(a.data_fim)}</>
                    )}
                  </div>
                  {a.notas && (
                    <p className="text-xs text-muted-foreground">{a.notas}</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => handleAprovar(a)}
                      disabled={processando !== null}
                    >
                      {processando === `aprovar-${a._id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Aprovar
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1"
                      onClick={() => handleRejeitar(a)}
                      disabled={processando !== null}
                    >
                      {processando === `rejeitar-${a._id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                      Rejeitar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
