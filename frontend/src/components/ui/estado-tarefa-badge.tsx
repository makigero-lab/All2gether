import * as React from "react";
import { Ban, Check, Clock, Play, User, UserX, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { infoEstadoTarefa, type VarianteEstado } from "@/lib/estados";
import { cn } from "@/lib/utils";

const ICONES: Record<VarianteEstado, LucideIcon> = {
  porAtribuir: Clock,
  naoAtribuida: UserX,
  atribuida: User,
  emCurso: Play,
  concluida: Check,
  cancelada: Ban,
};

/**
 * Badge de estado da tarefa: cor + ícone + texto (a cor nunca é o único sinal).
 * Fonte de verdade em `@/lib/estados` e nos tokens `--status-*`.
 */
export function EstadoTarefaBadge({
  estado,
  className,
  comIcone = true,
}: {
  estado: string | null | undefined;
  className?: string;
  comIcone?: boolean;
}) {
  const info = infoEstadoTarefa(estado);
  const Icone = ICONES[info.variant];
  return (
    <Badge
      variant={info.variant}
      title={info.descricao || undefined}
      className={cn("gap-1 whitespace-nowrap", className)}
    >
      {comIcone && <Icone className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {info.label}
    </Badge>
  );
}
