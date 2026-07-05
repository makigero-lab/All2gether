"use client";

import { ShieldCheck, LogOut, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fazerLogout, lerUtilizador } from "@/lib/auth";
import type { UtilizadorAuth } from "@/lib/auth";

/**
 * Painel de Super Administração (/admin).
 *
 * Reservado para o role "admin" (dono da conta).
 * As funcionalidades operacionais (dashboard, propriedades, equipa, etc.)
 * estão no painel do Gestor em /gestor.
 *
 * Este painel terá no futuro: gestão de empresas, planos, billing, etc.
 */
export default function SuperAdminPage() {
  const [user, setUser] = useState<UtilizadorAuth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    lerUtilizador()
      .then((u) => setUser(u))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-6">
      {/* Cabeçalho */}
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <ShieldCheck className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Painel de Super Administração
        </h1>
        <p className="text-sm text-muted-foreground">
          Bem-vindo, {user?.nome ?? "Admin"}.
        </p>
      </div>

      {/* Placeholder */}
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ShieldCheck className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Em breve</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Este painel terá funcionalidades de gestão de empresas, planos,
            billing e configurações avançadas. Para operações do dia-a-dia,
            usa o painel do Gestor.
          </p>
          <Link href="/gestor" className="mt-2">
            <Button variant="outline">
              Ir para o Painel do Gestor →
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Logout */}
      <Button
        variant="ghost"
        className="text-sm text-muted-foreground hover:text-destructive"
        onClick={() => fazerLogout()}
      >
        <LogOut className="mr-2 h-4 w-4" />
        Terminar Sessão
      </Button>
    </div>
  );
}
