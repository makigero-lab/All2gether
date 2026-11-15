import * as React from "react";
import { Ban, Check, Clock, Hourglass, LockKeyhole, Play, User, UserX, type LucideIcon } from "lucide-react";

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

/** Quem está a ver: muda o texto do selo «fechada pelo sistema» (a equipa confirma; o proprietário só fica a saber). */
export type PerfilFecho = "gestor" | "staff" | "proprietario";

/** Texto do selo de uma limpeza fechada pelo sistema, por perfil. */
export function seloFechoAutomatico(perfil: PerfilFecho): { texto: string; descricao: string } {
  if (perfil === "proprietario") {
    return {
      texto: "Por confirmar",
      descricao: "A equipa ainda não confirmou esta limpeza na app, por isso o sistema fechou-a. Não há hora de conclusão nem fotos.",
    };
  }
  if (perfil === "staff") {
    return {
      texto: "Fechada pelo sistema · Confirmar",
      descricao: "O sistema fechou esta limpeza sem a tua confirmação. Abre-a, junta fotos e confirma.",
    };
  }
  return {
    texto: "Fechada pelo sistema",
    descricao: "O sistema fechou esta limpeza porque ninguém a fechou. Não há prova de que foi feita.",
  };
}

/**
 * Badge de estado da tarefa: cor + ícone + texto (a cor nunca é o único sinal).
 * Fonte de verdade em `@/lib/estados` e nos tokens `--status-*`.
 * Com `fechadaPeloSistema` (concluída pelo job das 20:00, sem confirmação) mostra um selo próprio:
 * âmbar para a equipa e o gestor, cinzento neutro e sem visto para o proprietário.
 */
export function EstadoTarefaBadge({
  estado,
  className,
  comIcone = true,
  fechadaPeloSistema = false,
  perfil = "gestor",
}: {
  estado: string | null | undefined;
  className?: string;
  comIcone?: boolean;
  fechadaPeloSistema?: boolean;
  perfil?: PerfilFecho;
}) {
  if (fechadaPeloSistema && estado === "concluida") {
    const { texto, descricao } = seloFechoAutomatico(perfil);
    const neutro = perfil === "proprietario";
    const Icone = neutro ? Hourglass : LockKeyhole;
    return (
      <Badge
        variant={neutro ? "outline" : "warning"}
        title={descricao}
        aria-label={`${texto}. ${descricao}`}
        className={cn("gap-1 whitespace-nowrap", neutro && "border-border bg-muted text-muted-foreground", className)}
      >
        {comIcone && <Icone className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {texto}
      </Badge>
    );
  }
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
