import * as React from "react";
import { HandHeart } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CamposOferta {
  estado?: string | null;
  utilizador_id?: unknown;
  pessoas_em_falta?: number | null;
  oferta_estado?: string | null;
  oferta_expira_em?: string | null;
}

/** A vaga está oferecida à equipa neste momento? (aberta, dentro do prazo e ainda a faltar gente) */
export function ofertaViva(t: CamposOferta): boolean {
  if (t.oferta_estado !== "aberta" || !t.oferta_expira_em) return false;
  if (new Date(t.oferta_expira_em).getTime() <= Date.now()) return false;
  const semPessoa = (t.estado === "por_atribuir" || t.estado === "nao_atribuida") && !t.utilizador_id;
  return semPessoa || (t.estado === "atribuida" && (t.pessoas_em_falta ?? 0) > 0);
}

/** «Vaga oferecida à equipa até 18:00»: o gestor vê que a vaga está a ser oferecida e pode atribuir à mão. */
export function OfertaVagaBadge({ tarefa, className }: { tarefa: CamposOferta; className?: string }) {
  if (!ofertaViva(tarefa)) return null;
  const ate = new Date(tarefa.oferta_expira_em as string).toLocaleTimeString("pt-PT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Lisbon",
  });
  return (
    <Badge
      variant="outline"
      title="Ninguém tinha disponibilidade: a vaga foi oferecida a toda a equipa que não está ausente. Podes atribuir à mão a qualquer momento."
      className={cn("h-auto max-w-full gap-1 whitespace-normal border-primary/50 text-left leading-tight", className)}
    >
      <HandHeart className="h-3 w-3 shrink-0" aria-hidden="true" />
      Vaga oferecida à equipa até {ate}
    </Badge>
  );
}
