"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { limparCacheAuth } from "@/lib/auth";

/**
 * Banner de Impersonação — Prompt 110 / 113.
 *
 * Aparece no topo do painel do Gestor quando o Super Admin está impersonado
 * (marcador `fisiocell_impersonating` em sessionStorage, definido pelo botão
 * "Entrar como Gestor" em /admin).
 *
 * Mostra um botão VERMELHO "Voltar a Admin" que:
 *   1. Chama POST /api/auth/exit-impersonation (restaura o cookie de admin
 *      guardado durante a impersonação).
 *   2. Limpa o marcador de sessionStorage.
 *   3. Redireciona para /admin (o middleware deixa passar porque o token
 *      voltou a ser de admin).
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
        sessionStorage.getItem("fisiocell_impersonating") === "true"
    );
  }, []);

  async function handleVoltarAdmin() {
    if (aRestaurar) return;
    setARestaurar(true);
    try {
      const res = await fetch("/api/auth/exit-impersonation", {
        method: "POST",
        credentials: "include",
      });
      // Independentemente do resultado, limpa o marcador.
      sessionStorage.removeItem("fisiocell_impersonating");
      // Limpa o cache de auth — o cookie mudou (gestor → admin).
      limparCacheAuth();

      if (res.ok) {
        // Token de admin restaurado → vai para /admin.
        window.location.href = "/admin";
      } else {
        // Fallback: logout + login.
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
        window.location.href = "/login";
      }
    } catch {
      sessionStorage.removeItem("fisiocell_impersonating");
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
        {aRestaurar ? "A restaurar…" : "Voltar a Admin"}
      </button>
    </div>
  );
}
