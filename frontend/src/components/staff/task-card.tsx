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
  User,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { cn, parsearDataSegura } from "@/lib/utils";
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
 * Extrai a hora de início (HH:mm) de um ISO de data.
 * Retorna "—" se a data for inválida ou não tiver componente de tempo.
 */
function horaInicio(dataISO?: string): string {
  if (!dataISO) return "—";
  try {
    const d = parsearDataSegura(dataISO);
    if (!d) return "—";
    // Se for meia-noite exata (00:00), considera "sem hora definida".
    if (d.getHours() === 0 && d.getMinutes() === 0) return "—";
    return format(d, "HH:mm", { locale: pt });
  } catch {
    return "—";
  }
}

/**
 * Cartão de Tarefa de Limpeza para a área do Staff (mobile-first).
 * Mostra: nome da propriedade, hora de início, estimativa de tempo e tipo.
 *
 * v1.56.0 (Prompt 78): o cartão inteiro é clicável e leva a /staff/tarefas/[id].
 * Mesmo as tarefas por atribuir são clicáveis (para ver detalhe/morada).
 */
export function TaskCard({ tarefa }: { tarefa: TarefaMock }) {
  const Icon = tipoIcon[tarefa.tipo];
  const porAtribuir = tarefa.estado === "por_atribuir";
  const hora = horaInicio(tarefa.data);
  // Prompt 136 — nome do hóspede (se existir na reserva).
  const nomeHospede = tarefa.detalhes_reserva?.nome_hospede;
  // Prompt 137 — tempo de viagem estimado (para badge no cartão).
  const tempoViagem = Number(tarefa.tempo_viagem_minutos) || 0;

  return (
    <Link href={`/staff/tarefas/${tarefa.id}`} prefetch className="block">
      <Card
        className={cn(
          "cursor-pointer overflow-hidden transition-all hover:shadow-md hover:border-primary/40 active:scale-[0.99]",
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
                  Início
                </span>
                <span className="font-medium tabular-nums">{hora}</span>
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
              <span className="whitespace-normal break-words">{tarefa.endereco}</span>
            </p>
          )}

          {/* Prompt 136 — Nome do hóspede (se existir na reserva Smoobu ou
              preenchido manualmente pelo gestor). Destacado para o staff saber
              a quem vai receber. */}
          {nomeHospede && (
            <p className="flex items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-xs">
              <User className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="font-medium text-foreground">{nomeHospede}</span>
            </p>
          )}

          {/* Prompt 137 — Badge de tempo de viagem estimado.
              Mostra se tempo_viagem_minutos > 0 (calculado pelo scheduler).
              Cor âmbar para o staff saber que precisa de deslocação antes. */}
          {tempoViagem > 0 && (
            <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-50 px-2 py-1.5 text-xs dark:bg-amber-950/20">
              <Clock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="font-medium text-amber-900 dark:text-amber-100">
                🚗 Tempo de Viagem: {tempoViagem} min
              </span>
            </p>
          )}

          <Button
            variant={porAtribuir ? "outline" : "default"}
            className="w-full"
            disabled={porAtribuir}
            // O Link envolve o Card, o botão é visual (não há onClick).
            // Mesmo por atribuir, mostra "Ver detalhes" para inspecionar a morada.
          >
            {porAtribuir ? (
              "Aguarda atribuição"
            ) : (
              <>
                Ver detalhes
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </Link>
  );
}
