"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check } from "lucide-react";

import { cn, parsearDataSegura } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Sino de Notificações In-App — Prompt 114 / 118.
 *
 * Mostra um ícone de sino com badge vermelho (count de não-lidas). Ao
 * clicar, abre um dropdown com a lista de notificações.
 *
 * Prompt 118 — Melhorias:
 *   - Dropdown com max-h-[70vh] + overflow-y-auto, w-[300px] sm:w-[400px],
 *     ancorado à direita (right-0 origin-top-right) — não transborda mobile.
 *   - Notificações clicáveis: ao clicar, faz PATCH para marcar como lida e
 *     redireciona para a tarefa em questão (se houver tarefa_id).
 *   - Ao abrir, marca todas como lidas (depois de mostrar a lista).
 *
 * Polling: a cada 30s, refaz a contagem de não-lidas.
 */
export function NotificationBell() {
  const router = useRouter();
  const [naoLidas, setNaoLidas] = useState(0);
  const [aberto, setAberto] = useState(false);
  const [notificacoes, setNotificacoes] = useState<Array<{
    _id: string;
    mensagem: string;
    tipo: string;
    url: string;
    lida: boolean;
    data: string;
    tarefa_id?: string | null;
  }>>([]);
  const [carregando, setCarregando] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Busca contagem de não-lidas.
  const carregarContagem = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me/notificacoes/contagem", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setNaoLidas(data.nao_lidas ?? 0);
    } catch {
      // silencioso
    }
  }, []);

  // Busca lista completa (ao abrir).
  const carregarLista = useCallback(async () => {
    setCarregando(true);
    try {
      const res = await fetch("/api/auth/me/notificacoes?lidas=false", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setNotificacoes(data.notificacoes ?? []);
    } catch {
      // silencioso
    } finally {
      setCarregando(false);
    }
  }, []);

  // Polling inicial + a cada 30s.
  useEffect(() => {
    carregarContagem();
    const interval = setInterval(carregarContagem, 30_000);
    return () => clearInterval(interval);
  }, [carregarContagem]);

  // Fecha o dropdown ao clicar fora.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setAberto(false);
      }
    }
    if (aberto) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [aberto]);

  // Ao abrir: carrega lista + marca todas como lidas (depois de mostrar).
  async function handleToggle() {
    const novoAberto = !aberto;
    setAberto(novoAberto);
    if (novoAberto) {
      await carregarLista();
      // Marca como lidas (se houver não-lidas).
      if (naoLidas > 0) {
        try {
          await fetch("/api/auth/me/notificacoes/marcar-lidas", {
            method: "PATCH",
            credentials: "include",
          });
          setNaoLidas(0);
          // Atualiza o estado local para refletir "lida".
          setNotificacoes((prev) => prev.map((n) => ({ ...n, lida: true })));
        } catch {
          // silencioso
        }
      }
    }
  }

  /**
   * Prompt 118 — Ao clicar numa notificação:
   *   1. Faz PATCH para marcar como lida (se ainda não estiver).
   *   2. Redireciona para a tarefa (se houver tarefa_id) ou para o url.
   */
  async function handleClickNotificacao(n: typeof notificacoes[number]) {
    // Marca como lida (individual) se ainda não estiver.
    if (!n.lida) {
      try {
        await fetch(`/api/auth/me/notificacoes/${n._id}/lida`, {
          method: "PATCH",
          credentials: "include",
        });
        setNotificacoes((prev) =>
          prev.map((x) => (x._id === n._id ? { ...x, lida: true } : x))
        );
      } catch {
        // silencioso
      }
    }
    setAberto(false);
    // Redireciona para a tarefa (staff) ou para o url.
    if (n.tarefa_id) {
      router.push(`/staff/tarefas/${n.tarefa_id}`);
    } else if (n.url) {
      router.push(n.url);
    }
  }

  function formatarData(iso: string): string {
    const d = parsearDataSegura(iso);
    if (!d) return "";
    try {
      const agora = new Date();
      const diffMs = agora.getTime() - d.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return "agora";
      if (diffMin < 60) return `${diffMin} min`;
      const diffHoras = Math.floor(diffMin / 60);
      if (diffHoras < 24) return `${diffHoras}h`;
      return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
    } catch {
      return "";
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleToggle}
        aria-label={`Notificações${naoLidas > 0 ? ` (${naoLidas} não lidas)` : ""}`}
        className="relative"
      >
        <Bell className="h-5 w-5" />
        {naoLidas > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {naoLidas > 9 ? "9+" : naoLidas}
          </span>
        )}
      </Button>

      {aberto && (
        <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-sm flex-col origin-top-right overflow-hidden rounded-lg border bg-card shadow-lg">
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-semibold">Notificações</span>
            {naoLidas > 0 && (
              <span className="text-xs text-muted-foreground">
                {naoLidas} não lida(s)
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {carregando ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                A carregar…
              </div>
            ) : notificacoes.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                <Bell className="mx-auto mb-2 h-8 w-8 opacity-30" />
                Sem notificações.
              </div>
            ) : (
              <ul className="divide-y">
                {notificacoes.map((n) => (
                  <li
                    key={n._id}
                    onClick={() => handleClickNotificacao(n)}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/50",
                      !n.lida && "bg-primary/5"
                    )}
                  >
                    <div className="mt-0.5 flex-1">
                      <p className="text-foreground">{n.mensagem}</p>
                      <span className="text-xs text-muted-foreground">
                        {formatarData(n.data)}
                      </span>
                    </div>
                    {!n.lida && (
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-600" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {notificacoes.length > 0 && (
            <div className="shrink-0 border-t px-4 py-2 text-center">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="h-3 w-3" />
                Marcaste tudo como lido
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
