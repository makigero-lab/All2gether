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
 * sem token). Este componente é uma **segunda camada** que:
 *   - valida via fetch a /api/auth/me (proxy que lê o cookie httpOnly no
 *     servidor e consulta o backend) se o utilizador está autenticado;
 *   - garante que o role corresponde ao role da área;
 *   - mostra um spinner enquanto valida (evita flash de conteúdo protegido).
 *
 * Se algo falhar, redireciona para /login.
 */
export function RouteGuard({ role, children }: RouteGuardProps) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (cancelado) return;
      if (!user || user.role !== role) {
        router.replace("/login");
        return;
      }
      setOk(true);
    })();
    return () => {
      cancelado = true;
    };
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
