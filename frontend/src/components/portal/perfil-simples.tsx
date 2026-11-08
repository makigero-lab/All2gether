"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Mail, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MeusDadosCard } from "@/components/rgpd/meus-dados-card";
import { fazerLogout, lerUtilizador, type UtilizadorAuth } from "@/lib/auth";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  gestor: "Gestor",
  staff: "Equipa",
  parceiro: "Proprietário",
  fornecedor: "Lavandaria",
};

/** Perfil mínimo (equipa e gestor): dados da conta, «Descarregar os meus dados» e terminar sessão. */
export function PerfilSimples({ voltarPara }: { voltarPara: string }) {
  const [user, setUser] = useState<UtilizadorAuth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const u = await lerUtilizador();
      if (!cancelado) {
        setUser(u);
        setLoading(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="flex flex-col items-center gap-2 py-16">
        <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">Não foi possível carregar o perfil.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-24 sm:p-6 lg:p-8">
      <Link href={voltarPara} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Voltar
      </Link>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <User className="h-6 w-6 text-brand-text" />
        O Meu Perfil
      </h1>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Dados da conta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <User className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-words">{user.nome}</span>
          </div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-all">{user.email}</span>
          </div>
          <Badge variant="secondary">{ROLE_LABEL[user.role] ?? user.role}</Badge>
        </CardContent>
      </Card>
      <MeusDadosCard />
      <div className="w-full max-w-lg">
        <Button variant="outline" className="h-11 w-full gap-2 text-destructive hover:bg-destructive/5" onClick={() => fazerLogout()}>
          Terminar sessão
        </Button>
      </div>
    </div>
  );
}
