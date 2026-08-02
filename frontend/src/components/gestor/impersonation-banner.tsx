"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { limparCacheAuth } from "@/lib/auth";

/**
 * Banner de Impersonação — Prompt 110 / 113.
 *
 * Aparece no topo do painel do Gestor quando o Super Admin está impersonado
 * (marcador `all2gether_impersonating` em sessionStorage, definido pelo
 * <AutoImpersonarEmpresa/> no layout do /gestor — rebrand satélite
 * single-tenant).
 *
 * Mostra um botão VERMELHO "Voltar a Admin" que:
 *   1. Chama POST /api/auth/exit-impersonation (restaura o cookie de admin
 *      guardado durante a impersonação).
 *   2. Limpa os marcadores de sessionStorage.
 *   3. Faz logout e vai para /login.
 *
 * Rebrand SSO (satélite single-tenant): o painel /admin deixou de existir
 * neste repositório. "Voltar a Admin" significa terminar a sessão
 * impersonada e sair (não há painel de admin para onde ir). Se o admin
 * quiser voltar a entrar no programa operacional, faz login/SSO novamente
 * (o <AutoImpersonarEmpresa/> re-assume a empresa principal automaticamente).
 *
 * Se a restauração falhar (ex.: cookie de admin expirou), faz logout e manda
 * para /login como fallback seguro.
 *
 * É um Client Component porque lê sessionStorage e usa estado React para
 * evitar problemas de hidratação (o banner só aparece após mount).
 */
export function ImpersonationBanner() {
  const [visivel, setVisivel] = useState(false);
  const [aRestaurar, setARestaurar] = useState(false);

  useEffect(() => {
    setVisivel(
      typeof window !== "undefined" &&
        sessionStorage.getItem("all2gether_impersonating") === "true"
    );
  }, []);

  async function handleVoltarAdmin() {
    if (aRestaurar) return;
    setARestaurar(true);
    try {
      // Tenta restaurar o token de admin (limpa o cookie de gestor e restaura
      // o de admin guardado). Independentemente do resultado, faz logout no
      // fim — no satélite single-tenant não há painel /admin.
      await fetch("/api/auth/exit-impersonation", {
        method: "POST",
        credentials: "include",
      }).catch(() => {});

      // Limpa os marcadores de sessionStorage (auto-impersonação + impersonação).
      sessionStorage.removeItem("all2gether_impersonating");
      sessionStorage.removeItem("all2gether_auto_impersonado");
      // Limpa o cache de auth — a sessão vai terminar.
      limparCacheAuth();

      // Logout (limpa ambos os cookies httpOnly) e redirect para /login.
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
      window.location.href = "/login";
    } catch {
      sessionStorage.removeItem("all2gether_impersonating");
      sessionStorage.removeItem("all2gether_auto_impersonado");
      limparCacheAuth();
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
      window.location.href = "/login";
    } finally {
      setARestaurar(false);
    }
  }

  if (!visivel) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        ⚠️ Estás em modo de impersonação. As ações que fizeres serão registadas em nome da empresa.
      </span>
      <button
        type="button"
        disabled={aRestaurar}
        onClick={handleVoltarAdmin}
        className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:opacity-60"
      >
        {aRestaurar ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5" />
        )}
        {aRestaurar ? "A sair…" : "Sair da empresa"}
      </button>
    </div>
  );
}
