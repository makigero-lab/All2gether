"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fazerLogout, lerSessao, limparCacheAuth, type Role } from "@/lib/auth";
import { CHAVE_REDIRECIONAMENTO, decidirRoleErrado, lerMarca } from "@/lib/guarda-role";

interface RouteGuardProps {
  /** Role exigida para esta área ("admin" | "gestor" | "staff" | "parceiro"). */
  role: Role;
  children: React.ReactNode;
}

/** Esperas (ms) entre tentativas automáticas quando o servidor não responde (arranque a frio ~30-60 s). */
const ESPERAS_RETRY_MS = [2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000];

function armazemSessao(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * RouteGuard — camada de proteção client-side para áreas privadas.
 *
 * O `middleware.ts` já bloqueia o acesso no servidor. Este componente é uma
 * **segunda camada** que valida a sessão via `lerSessao()` (fetch a /api/auth/me
 * com cache temporal).
 *
 *  - 401 / sem sessão: logout imediato + redirect HARD para /login (sem retry).
 *  - Erro temporário (5xx, 429, rede, Render a acordar): NÃO faz logout. Mostra
 *    "Sem ligação ao servidor" e repete sozinho (e com botão). A sessão mantém-se.
 *  - Role diferente do esperado: confia no /me (BD). Redireciona para o painel
 *    certo; se o middleware (JWT antigo) devolver ao mesmo sítio, faz logout limpo
 *    com aviso em vez de ficar em ciclo.
 */
export function RouteGuard({ role, children }: RouteGuardProps) {
  const [estado, setEstado] = useState<"verificando" | "ok" | "sem_ligacao">("verificando");
  const [tentativa, setTentativa] = useState(0);
  // Quantas falhas seguidas (decide a espera) e se ainda repete sozinho.
  const falhas = useRef(0);
  const [aTentar, setATentar] = useState(true);

  useEffect(() => {
    let cancelado = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const { estado: sessao, user } = await lerSessao();
      if (cancelado) return;

      if (sessao === "erro") {
        setEstado("sem_ligacao");
        const espera = ESPERAS_RETRY_MS[falhas.current];
        falhas.current += 1;
        setATentar(espera !== undefined);
        if (espera !== undefined) timer = setTimeout(() => !cancelado && setTentativa((t) => t + 1), espera);
        return;
      }

      if (sessao === "sem_sessao" || !user) {
        limparCacheAuth();
        await fazerLogout({ sessaoExpirada: true });
        return;
      }

      // O Super Admin (role 'admin') tem acesso ao programa operacional /gestor.
      const roleAutorizado =
        user.role === role || (role === "gestor" && user.role === "admin");

      if (!roleAutorizado) {
        const destino =
          user.role === "admin" || user.role === "gestor"
            ? "/gestor"
            : user.role === "parceiro"
              ? "/parceiro"
              : user.role === "fornecedor"
                ? "/fornecedor"
                : "/staff";
        const armazem = armazemSessao();
        if (decidirRoleErrado(destino, lerMarca(armazem)) === "logout") {
          // Ciclo: o JWT está desatualizado em relação ao role atual. Sessão nova.
          try { armazem?.removeItem(CHAVE_REDIRECIONAMENTO); } catch { /* ignora */ }
          limparCacheAuth();
          await fazerLogout({ sessaoExpirada: true, acessosMudaram: true });
          return;
        }
        try { armazem?.setItem(CHAVE_REDIRECIONAMENTO, JSON.stringify({ para: destino, ts: Date.now() })); } catch { /* ignora */ }
        window.location.href = destino;
        return;
      }

      falhas.current = 0;
      try { armazemSessao()?.removeItem(CHAVE_REDIRECIONAMENTO); } catch { /* ignora */ }
      setEstado("ok");
    })();

    return () => {
      cancelado = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, tentativa]);

  if (estado === "sem_ligacao") {
    return (
      <div role="status" className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">Sem ligação ao servidor.</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          A tua sessão continua ativa e o que escreveste está guardado.{" "}
          {aTentar ? "A tentar outra vez…" : "Carrega em tentar outra vez."}
        </p>
        <Button
          variant="outline"
          className="min-h-[44px]"
          onClick={() => {
            limparCacheAuth();
            falhas.current = 0;
            setATentar(true);
            setEstado("verificando");
            setTentativa((t) => t + 1);
          }}
        >
          Tentar outra vez
        </Button>
      </div>
    );
  }

  if (estado !== "ok") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
