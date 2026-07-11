"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { fazerLogout, lerUtilizador, limparCacheAuth, type Role } from "@/lib/auth";

interface RouteGuardProps {
  /** Role exigida para esta área ("admin" | "gestor" | "staff"). */
  role: Role;
  children: React.ReactNode;
}

/**
 * RouteGuard — camada de proteção client-side para áreas privadas.
 *
 * O `middleware.ts` já bloqueia o acesso no servidor (redireciona para /login
 * sem token, e redireciona para o painel certo se o role não bate com a rota).
 * Este componente é uma **segunda camada** que valida a sessão via
 * `lerUtilizador()` (fetch a /api/auth/me com cache temporal).
 *
 * Prompt 115 — Resolução DEFINITIVA do Loop 401:
 *   Antes, o guard chamava `lerUtilizador()` e, se devolvesse null, fazia
 *   `router.replace("/login")` (soft redirect). O problema: o `router.replace`
 *   é client-side — a página alvo podia voltar a montar e chamar o guard
 *   outra vez, gerando outro 401, num ciclo sem fim.
 *
 *   Agora, se `lerUtilizador()` devolver null (401):
 *     1. Limpa o cache de auth (`limparCacheAuth`).
 *     2. Faz **logout imediato** (`fazerLogout` → POST /api/auth/logout que
 *        limpa o cookie httpOnly + `window.location.href = "/login"`).
 *     3. O redirect é **HARD** (`window.location.href`, não `router.replace`)
 *        — o estado do cliente é totalmente reiniciado, não há re-mount do
 *        guard nem cache obsoleto. Isto quebra o loop definitivamente.
 *
 *   Sem retry: em caso de 401, o guard NÃO volta a tentar o fetch. Vai
 *   direto para /login.
 *
 *   Usa `lerUtilizador()` (em vez de fetch cru) para popular o cache temporal
 *   — assim as páginas que também chamam `lerUtilizador()` acertam no cache
 *   (1 fetch total, não 2).
 */
export function RouteGuard({ role, children }: RouteGuardProps) {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let cancelado = false;

    (async () => {
      const user = await lerUtilizador();
      if (cancelado) return;

      // 401 / sem sessão → logout imediato + redirect HARD para /login.
      // Sem retry. O fazerLogout limpa o cookie e faz window.location.href.
      if (!user) {
        limparCacheAuth();
        await fazerLogout();
        return;
      }

      // Role errado → redirect HARD para o painel certo desse role.
      if (user.role !== role) {
        const destino =
          user.role === "admin"
            ? "/admin"
            : user.role === "gestor"
            ? "/gestor"
            : "/staff";
        window.location.href = destino;
        return;
      }

      // Tudo OK → renderiza children.
      setOk(true);
    })();

    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  if (!ok) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
