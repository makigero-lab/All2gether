"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { parsearDataSegura } from "@/lib/utils";

/**
 * Página /staff/notificacoes — Task 131.
 *
 * Lista TODAS as notificações do staff (lidas + não-lidas), com badge de
 * estado e botão "Marcar todas como lidas". Mobile-first (staff usa telemóvel):
 *   - em ecrãs pequenos (sm:hidden) mostra cartões;
 *   - em ecrãs maiores (hidden sm:block) mostra tabela, igual ao /gestor.
 */

interface NotificacaoDTO {
  _id: string;
  mensagem: string;
  tipo: string;
  url: string;
  lida: boolean;
  data: string;
}

interface NotificacoesResponse {
  notificacoes: NotificacaoDTO[];
  total: number;
  nao_lidas: number;
}

/** Faz fetch autenticado (cookie httpOnly) com tratamento de erro padrão. */
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
    });
  } catch {
    return iso;
  }
}

const TIPO_LABEL: Record<string, string> = {
  tarefa: "Tarefa",
  atraso: "Atraso",
  avaria: "Avaria",
  atribuicao: "Atribuição",
  sistema: "Sistema",
  info: "Info",
};

export default function StaffNotificacoesPage() {
  const [notificacoes, setNotificacoes] = useState<NotificacaoDTO[]>([]);
  const [naoLidas, setNaoLidas] = useState(0);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [marcando, setMarcando] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      // Sem ?lidas=false → todas (lidas + não-lidas).
      const res = await staffFetch<NotificacoesResponse>(
        "/api/auth/me/notificacoes"
      );
      setNotificacoes(res.notificacoes ?? []);
      setNaoLidas(res.nao_lidas ?? 0);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar notificações.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleMarcarTodas() {
    setMarcando(true);
    setErro(null);
    try {
      await staffFetch<{ message: string; marcadas: number }>(
        "/api/auth/me/notificacoes/marcar-lidas",
        { method: "PATCH" }
      );
      // Atualiza localmente (todas ficam lidas) sem refetch.
      setNotificacoes((prev) => prev.map((n) => ({ ...n, lida: true })));
      setNaoLidas(0);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao marcar notificações.");
    } finally {
      setMarcando(false);
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
          <Bell className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">Notificações</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Histórico completo de notificações (lidas e não-lidas).
        </p>
      </header>

      {/* Conteúdo */}
      <main className="flex-1 space-y-4 p-5">
        {/* Ações */}
        <div className="flex flex-wrap items-center gap-2">
          {naoLidas > 0 && (
            <Button
              onClick={handleMarcarTodas}
              disabled={marcando}
              className="flex-1 justify-center gap-2"
            >
              {marcando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCheck className="h-4 w-4" />
              )}
              Marcar todas como lidas
            </Button>
          )}
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

        {/* Erro */}
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

        {/* Lista */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar notificações…
          </div>
        ) : notificacoes.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <Bell className="h-10 w-10 opacity-40" />
              <p className="text-sm">Sem notificações.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Mobile: cartões (staff usa telemóvel) */}
            <div className="space-y-3 sm:hidden">
              <p className="text-xs text-muted-foreground">
                {notificacoes.length} notificação(ões)
                {naoLidas > 0 && ` · ${naoLidas} não lida(s)`}
              </p>
              {notificacoes.map((n) => (
                <Card
                  key={n._id}
                  className={!n.lida ? "border-primary/40 bg-primary/5" : ""}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">
                          {TIPO_LABEL[n.tipo] ?? n.tipo}
                        </Badge>
                        {n.lida ? (
                          <Badge variant="secondary" className="text-xs">
                            Lida
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">
                            Não lida
                          </Badge>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground/70 tabular-nums whitespace-nowrap">
                        {formatarData(n.data)}
                      </span>
                    </div>
                    <p className={`mt-2 text-sm ${!n.lida ? "font-medium" : ""}`}>
                      {n.mensagem}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Desktop: tabela (igual ao /gestor/notificacoes) */}
            <Card className="hidden sm:block">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5 text-primary" />
                  Notificações
                </CardTitle>
                <CardDescription>
                  {notificacoes.length} notificação(ões) no total
                  {naoLidas > 0 && ` · ${naoLidas} não lida(s)`}.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-4 py-3 font-medium">Mensagem</th>
                        <th className="px-4 py-3 font-medium">Tipo</th>
                        <th className="px-4 py-3 font-medium">Estado</th>
                        <th className="px-4 py-3 font-medium whitespace-nowrap">
                          Data
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {notificacoes.map((n) => (
                        <tr
                          key={n._id}
                          className={`hover:bg-muted/30 ${
                            !n.lida ? "bg-primary/5" : ""
                          }`}
                        >
                          <td className="px-4 py-3">
                            <span className={!n.lida ? "font-medium" : ""}>
                              {n.mensagem}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-xs">
                              {TIPO_LABEL[n.tipo] ?? n.tipo}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {n.lida ? (
                              <Badge variant="secondary" className="text-xs">
                                Lida
                              </Badge>
                            ) : (
                              <Badge variant="destructive" className="text-xs">
                                Não lida
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap tabular-nums">
                            {formatarData(n.data)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
