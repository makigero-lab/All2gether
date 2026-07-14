"use client";

import { useCallback, useEffect, useState } from "react";
import {
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
import { adminGet, adminPatch } from "@/lib/api";
import { parsearDataSegura } from "@/lib/utils";

/**
 * Página /gestor/notificacoes — Prompt 126.
 *
 * Lista TODAS as notificações do gestor (lidas + não-lidas) numa tabela,
 * com badge de estado e botão "Marcar todas como lidas".
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

export default function GestorNotificacoesPage() {
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
      const res = await adminGet<NotificacoesResponse>(
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
      await adminPatch<{ message: string; marcadas: number }>(
        "/api/auth/me/notificacoes/marcar-lidas"
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
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">Notificações</h1>
          <p className="text-sm text-muted-foreground">
            Histórico completo de notificações (lidas e não-lidas).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {naoLidas > 0 && (
            <Button
              onClick={handleMarcarTodas}
              disabled={marcando}
              className="gap-2"
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
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tabela */}
      <Card>
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
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar notificações…
            </div>
          ) : notificacoes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Bell className="h-10 w-10 opacity-40" />
              <p className="text-sm">Sem notificações.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Mensagem</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {notificacoes.map((n) => (
                    <tr
                      key={n._id}
                      className={`hover:bg-muted/30 ${!n.lida ? "bg-primary/5" : ""}`}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
