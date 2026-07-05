import Link from "next/link";
import {
  Clock,
  Timer,
  MapPin,
  SprayCan,
  LogIn,
  LogOut,
  Wrench,
  ChevronRight,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TarefaMock, EstadoTarefa, TipoTarefa } from "@/lib/api";

const tipoIcon: Record<TarefaMock["tipo"], React.ComponentType<{ className?: string }>> = {
  limpeza: SprayCan,
  check_in: LogIn,
  check_out: LogOut,
  manutencao: Wrench,
  outro: SprayCan,
};

const tipoLabel: Record<TarefaMock["tipo"], string> = {
  limpeza: "Limpeza",
  check_in: "Check-in",
  check_out: "Check-out",
  manutencao: "Manutenção",
  outro: "Outro",
};

function formatarMinutos(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Cartão de Tarefa de Limpeza para a área do Staff (mobile-first).
 * Mostra: nome da propriedade, hora limite, estimativa de tempo e tipo.
 */
export function TaskCard({ tarefa }: { tarefa: TarefaMock }) {
  const Icon = tipoIcon[tarefa.tipo];
  const porAtribuir = tarefa.estado === "por_atribuir";

  return (
    <Card
      className={cn(
        "overflow-hidden transition-shadow hover:shadow-md",
        porAtribuir && "border-amber-300/70"
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
              porAtribuir
                ? "bg-amber-100 text-amber-700"
                : "bg-primary/10 text-primary"
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              {tarefa.propriedade_nome}
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tipoLabel[tarefa.tipo]}
            </p>
          </div>
        </div>
        <Badge variant={porAtribuir ? "warning" : "success"} className="shrink-0">
          {porAtribuir ? "Por atribuir" : "Atribuída"}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="text-[11px] uppercase text-muted-foreground">
                Hora limite
              </span>
              <span className="font-medium">{tarefa.hora_limite}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Timer className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="text-[11px] uppercase text-muted-foreground">
                Estimativa
              </span>
              <span className="font-medium">
                {formatarMinutos(tarefa.tempo_estimado_minutos)}
              </span>
            </div>
          </div>
        </div>

        {tarefa.endereco && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="line-clamp-2">{tarefa.endereco}</span>
          </p>
        )}

        {porAtribuir ? (
          <Button variant="outline" className="w-full" disabled>
            Aguarda atribuição
          </Button>
        ) : (
          <Link href={`/staff/tarefas/${tarefa.id}`} prefetch className="block">
            <Button className="w-full">
              Iniciar tarefa
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
