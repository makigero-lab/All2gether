"use client";

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
  Users,
  Navigation,
  Shirt,
  Play,
  TriangleAlert,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { cn, parsearDataSegura, googleMapsUrl } from "@/lib/utils";
import { textoEquipa } from "@/lib/equipa";
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TarefaMock, EstadoTarefa, TipoTarefa } from "@/lib/api";
import { TipoLimpezaBadge } from "@/components/tipo-limpeza-badge";
import { BotaoComecei, BotaoNaoConsegui, horaCurta } from "@/components/staff/comecar-limpeza";

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
 *
 * Sem links aninhados (HTML inválido): o <Link> da tarefa está no título e a
 * sua área de toque é expandida a todo o cartão com um pseudo-elemento
 * (`after:absolute after:inset-0`, o cartão é `relative`). A ligação do Google
 * Maps fica por cima (`relative z-10`), por isso não abre a tarefa. O "botão"
 * "Ver detalhes" é só visual (div): o clique cai no overlay do link.
 */
export function TaskCard({ tarefa, onAtualizar }: { tarefa: TarefaMock; onAtualizar?: () => void }) {
  const Icon = tipoIcon[tarefa.tipo];
  const porAtribuir = tarefa.estado === "por_atribuir";
  const hora = horaInicio(tarefa.data);
  // Prompt 136 — nome do hóspede (se existir na reserva).
  const nomeHospede = tarefa.detalhes_reserva?.nome_hospede;
  // Prompt 137 — tempo de viagem estimado (para badge no cartão).
  const tempoViagem = Number(tarefa.tempo_viagem_minutos) || 0;
  const equipa = textoEquipa(tarefa.equipa_nomes);
  // «Comecei»: só em tarefas atribuídas, de hoje (ou de dias passados por fechar).
  const dataTarefa = parsearDataSegura(tarefa.data ?? "");
  const ate = new Date();
  ate.setHours(23, 59, 59, 999);
  const podeComecar = tarefa.estado === "atribuida" && !!dataTarefa && dataTarefa.getTime() <= ate.getTime() && !!onAtualizar;
  const emCurso = tarefa.estado === "em_curso";
  const desde = horaCurta(tarefa.iniciada_em);

  return (
    <div className="block">
      <Card
        className={cn(
          "relative cursor-pointer overflow-hidden transition-all hover:shadow-md hover:border-primary/40 active:scale-[0.99]",
          porAtribuir && "border-status-porat/40"
        )}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                porAtribuir
                  ? "bg-status-porat-bg text-status-porat"
                  : "bg-primary/10 text-gold-text"
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">
                <Link
                  href={`/staff/tarefas/${tarefa.id}`}
                  prefetch
                  className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
                >
                  {tarefa.propriedade_nome}
                  <span className="sr-only"> — {tipoLabel[tarefa.tipo]}, abrir tarefa</span>
                </Link>
              </CardTitle>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {/* Só a etiqueta do tipo («Limpeza intermédia»), sem «Limpeza» a repetir. */}
                {tarefa.tipo === "limpeza" && tarefa.tipo_limpeza && tarefa.tipo_limpeza !== "normal"
                  ? <TipoLimpezaBadge tipo={tarefa.tipo_limpeza} />
                  : tipoLabel[tarefa.tipo]}
              </div>
            </div>
          </div>
          <EstadoTarefaBadge estado={tarefa.estado} className="shrink-0" />
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="text-xs uppercase text-muted-foreground">
                  Início
                </span>
                <span className="font-medium tabular-nums">{hora}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="text-xs uppercase text-muted-foreground">
                  Estimativa
                </span>
                <span className="font-medium">
                  {formatarMinutos(tarefa.tempo_estimado_minutos)}
                </span>
              </div>
            </div>
          </div>

          {/* FIX (google maps integration) — Endereço + botão "Abrir no Google
              Maps" para navegação direta. O staff pode clicar para abrir a app
              do Google Maps (mobile/web) na localização da propriedade. */}
          {tarefa.endereco && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-normal break-words flex-1">{tarefa.endereco}</span>
              {(() => {
                const url = googleMapsUrl(tarefa.endereco);
                if (!url) return null;
                return (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative z-10 -my-3.5 -mr-3 inline-flex h-11 w-11 shrink-0 items-center justify-center self-center rounded text-gold-text hover:underline"
                    title="Abrir no Google Maps"
                    aria-label="Abrir no Google Maps"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                  </a>
                );
              })()}
            </p>
          )}

          {/* Prompt 136 — Nome do hóspede (se existir na reserva Smoobu ou
              preenchido manualmente pelo gestor). Destacado para o staff saber
              a quem vai receber. */}
          {nomeHospede && (
            <p className="flex items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-xs">
              <User className="h-3.5 w-3.5 shrink-0 text-gold-text" />
              <span className="font-medium text-foreground">{nomeHospede}</span>
            </p>
          )}

          {/* Equipa da limpeza (2+ pessoas): com quem trabalhas. */}
          {equipa && (
            <p className="flex items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-xs">
              <Users className="h-3.5 w-3.5 shrink-0 text-gold-text" />
              <span className="font-medium text-foreground">Equipa: {equipa}</span>
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

          {/* Lavandaria: só com fornecedor associado à casa. */}
          {tarefa.tem_lavandaria && tarefa.tipo === "limpeza" && (
            <p
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium",
                tarefa.roupa_entregue
                  ? "bg-status-conc-bg text-status-conc"
                  : "border border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/20 dark:text-amber-100"
              )}
            >
              <Shirt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Roupa limpa: {tarefa.roupa_entregue ? "entregue" : "em falta"}
            </p>
          )}

          {emCurso && desde && (
            <p className="flex items-center gap-1.5 rounded-md bg-status-curso-bg px-2 py-1.5 text-xs font-medium text-status-curso">
              <Play className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Em curso desde as {desde}
              {tarefa.inicio_origem === "automatico" ? " (início automático)" : ""}
            </p>
          )}

          {tarefa.nao_consegui_comecar && !emCurso && (
            <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Avisaste o gestor que não conseguiste começar.
            </p>
          )}

          {/* Botões por cima do link do cartão (z-10): não abrem a tarefa. */}
          {podeComecar && (
            <div className="relative z-10 space-y-1">
              <BotaoComecei tarefaId={tarefa.id} onFeito={onAtualizar!} />
              <BotaoNaoConsegui tarefaId={tarefa.id} onFeito={onAtualizar!} />
            </div>
          )}

          {/* Visual apenas: o clique é tratado pelo link do título (overlay). */}
          <div
            aria-hidden="true"
            className={cn(
              buttonVariants({ size: "touch", variant: porAtribuir ? "outline" : "default" }),
              "w-full",
              porAtribuir && "opacity-50"
            )}
          >
            {porAtribuir ? (
              "Aguarda atribuição"
            ) : (
              <>
                Ver detalhes
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
