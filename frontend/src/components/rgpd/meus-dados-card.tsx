"use client";

import { useState } from "react";
import { Download, Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { descarregarFicheiro } from "@/lib/descarregar";

/**
 * Cartão «Os meus dados» (RGPD): o utilizador descarrega tudo o que a plataforma guarda sobre ele (JSON).
 * Presente no perfil de todos os papéis (equipa, gestor, proprietário, lavandaria).
 */
export function MeusDadosCard() {
  const [a, setA] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  async function descarregar() {
    setA(true);
    setMsg(null);
    try {
      await descarregarFicheiro("/api/auth/me/exportar-dados", "os-meus-dados.json");
      setMsg({ tipo: "ok", texto: "Ficheiro descarregado." });
    } catch (e) {
      setMsg({ tipo: "erro", texto: e instanceof Error ? e.message : "Não foi possível descarregar os dados." });
    } finally {
      setA(false);
    }
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-brand-text" />
          Os meus dados
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Descarrega um ficheiro com os dados pessoais que a plataforma guarda sobre ti: conta, tarefas, ausências,
          avisos e registos. Não inclui palavras-passe nem dados de outras pessoas.
        </p>
        <Button type="button" variant="outline" className="h-11 w-full gap-2 sm:w-auto" onClick={descarregar} disabled={a}>
          {a ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Descarregar os meus dados
        </Button>
        {msg && (
          <p role="status" className={`text-sm ${msg.tipo === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {msg.texto}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
