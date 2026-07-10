"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { lerUtilizador, type Role } from "@/lib/auth";

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
 * Este componente é uma **segunda camada** que:
 *   - valida via fetch a /api/auth/me (proxy que lê o cookie httpOnly no
 *     servidor e consulta o backend) se o utilizador está autenticado;
 *   - garante que o role corresponde ao role da área;
 *   - mostra um spinner enquanto valida (evita flash de conteúdo protegido).
 *
 * Se algo falhar, redireciona UMA vez:
 *   - sem sessão (null) → /login
 *   - sessão válida mas role errado → painel correto desse role
 *
 * Prompt 113 — Loop 401: `lerUtilizador()` passou a ser pura (não redireciona
 * internamente). O redirect é responsabilidade exclusiva deste guard, feito
 * uma só vez com uma flag `redirecionado`. Isto elimina o burst de pedidos
 * 401 em cascata que ocorria quando vários componentes chamavam
 * `lerUtilizador()` em paralelo e cada um disparava o seu próprio redirect.
 */
export function RouteGuard({ role, children }: RouteGuardProps) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let redirecionado = false;
    (async () => {
      const user = await lerUtilizador();
      if (redirecionado) return;

      if (!user) {
        redirecionado = true;
        router.replace("/login");
        return;
      }

      // Role errado → manda para o painel certo desse role.
      if (user.role !== role) {
        redirecionado = true;
        const destino =
          user.role === "admin" ? "/admin" : user.role === "gestor" ? "/gestor" : "/staff";
        router.replace(destino);
        return;
      }

      setOk(true);
    })();
  }, [role, router]);

  if (!ok) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
