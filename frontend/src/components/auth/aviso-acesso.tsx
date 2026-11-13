"use client";

import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";

const COOKIE = "a2g_aviso";

/**
 * Aviso amigável quando alguém abre uma área que não é a sua (ex.: o proprietário que tem a página
 * /gestor/integracoes nos favoritos). O middleware redireciona e deixa um cookie curto; aqui lê-se, mostra-se
 * uma vez e apaga-se. Não mostra nada se o cookie não existir.
 */
export function AvisoAcesso() {
  const [visivel, setVisivel] = useState(false);
  useEffect(() => {
    try {
      if (document.cookie.split("; ").some((c) => c === `${COOKIE}=outra-area`)) {
        setVisivel(true);
        document.cookie = `${COOKIE}=; path=/; max-age=0`;
      }
    } catch { /* sem cookies: sem aviso */ }
  }, []);
  if (!visivel) return null;
  return (
    <div role="status" className="flex items-start gap-2 border-b bg-sky-50 px-4 py-2 text-sm dark:bg-sky-950/30">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1">Essa página é da equipa de gestão. Aqui tens as tuas reservas e os teus calendários.</p>
      <button type="button" onClick={() => setVisivel(false)} aria-label="Fechar o aviso" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5"><X className="h-4 w-4" aria-hidden /></button>
    </div>
  );
}
