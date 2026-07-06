"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * /gestor/ausencias — Redirect para a aba "Aprovações de Férias" da página
 * de Equipa (v1.68.0 — Prompt 91).
 *
 * As ausências/férias são geridas na aba "Aprovações de Férias" de
 * /gestor/equipa. Esta página existe para que o menu lateral possa apontar
 * para /gestor/ausencias (URL intuitiva) e o utilizador é redirecionado
 * automaticamente para o sítio certo com a tab correta pré-selecionada.
 */
export default function AusenciasRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/gestor/equipa?tab=aprovacoes");
  }, [router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
