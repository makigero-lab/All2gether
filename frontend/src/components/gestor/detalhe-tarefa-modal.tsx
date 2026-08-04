"use client";

import {
  Clock,
  Timer,
  MapPin,
  SprayCan,
  LogIn,
  LogOut,
  Wrench,
  User,
  Users,
  AlertTriangle,
  StickyNote,
  Camera,
  CheckCircle2,
} from "lucide-react";

// Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
import { parsearDataSegura } from "@/lib/utils";

import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DetalhesReservaCard } from "@/components/detalhes-reserva-card";

/** Tarefa no formato devolvido pelo GET /api/gestor/tarefas (com populate). */
export interface AvariaDTO {
  descricao: string;
  fotos?: string[];
  resolvido?: boolean;
  data_registo?: string | Date;
}

export interface TarefaDetalheGestor {
  _id: string;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
  observacoes?: string;
  observacoes_staff?: string;
  // HF13/HF14 — avarias enriquecidas: { descricao, fotos, resolvido, data_registo }.
  // Retrocompatível: entries legacy (strings) são normalizadas pelo helper.
  avarias?: AvariaDTO[] | string[];
  detalhes_reserva?: {
    checkin?: string | null;
    checkout?: string | null;
    pax?: number | null;
    nome_hospede?: string | null;
  } | null;
  // Prompt 137 — Tempo de viagem (para mostrar badge no detalhe).
  tempo_viagem_minutos?: number | null;
  propriedade_id?: { nome: string; morada?: string; capacidade_hospedes?: number | null } | null;
  utilizador_id?: { nome: string } | null;
}

/**
 * HF14 — Normaliza uma avaria (string legacy OU objeto rico) para objeto.
 * Retrocompatibilidade: tarefas antigas tinham `avarias: ["descrição"]`;
 * tarefas novas têm `avarias: [{ descricao, fotos, resolvido, data_registo }]`.
 */
function normalizarAvaria(a: AvariaDTO | string): AvariaDTO {
  if (typeof a === "string") {
    return { descricao: a, resolvido: false };
  }
  return a;
}

/**
 * HF14 — Formata a data de registo da avaria para pt-PT (dd/MM/yyyy HH:mm).
 */
function formatarDataAvaria(data: string | Date | undefined): string {
  if (!data) return "";
  try {
    const d = typeof data === "string" ? new Date(data) : data;
    return d.toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(data);
  }
}

const tipoIcon: Record<string, React.ComponentType<{ className?: string }>> = {
  limpeza: SprayCan,
  check_in: LogIn,
  check_out: LogOut,
  manutencao: Wrench,
  outro: SprayCan,
};

const tipoLabel: Record<string, string> = {
  limpeza: "Limpeza",
  check_in: "Check-in",
  check_out: "Check-out",
  manutencao: "Manutenção",
  outro: "Outro",
};

const ESTADO_LABEL: Record<string, string> = {
  por_atribuir: "Por atribuir",
  atribuida: "Atribuída",
  em_curso: "Em curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  // Prompt 138 (136 V2) — SLA excedido.
  nao_atribuida: "Não atribuída (SLA)",
};

const ESTADO_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "outline" | "destructive"
> = {
  por_atribuir: "warning",
  atribuida: "default",
  em_curso: "secondary",
  concluida: "success",
  cancelada: "outline",
  // Prompt 138 (136 V2) — vermelho para destacar que requer intervenção.
  nao_atribuida: "destructive",
};

function formatarDataHora(iso: string): string {
  // Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    const data = d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    if (d.getHours() === 0 && d.getMinutes() === 0) return data;
    const hora = d.toLocaleTimeString("pt-PT", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${data} - ${hora}`;
  } catch {
    return iso;
  }
}

function formatarMinutos(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Modal de detalhe de tarefa — Painel do Gestor (Prompt 95 / Fase 1.5).
 *
 * Mostra informação completa de uma tarefa: propriedade, staff atribuído,
 * data/hora, tipo, estado, detalhes da reserva Smoobu (card de destaque),
 * observações, avarias e observações do staff.
 */
export function DetalheTarefaModal({
  tarefa,
  open,
  onOpenChange,
}: {
  tarefa: TarefaDetalheGestor | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const Icon = tarefa ? (tipoIcon[tarefa.tipo] ?? SprayCan) : SprayCan;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <div>
          <DialogTitle className="flex items-center gap-2">
            {tarefa && <Icon className="h-5 w-5 text-primary" />}
            Detalhe da Tarefa
          </DialogTitle>
          <DialogDescription>
            Informação completa da tarefa e da reserva associada.
          </DialogDescription>
        </div>
        <DialogClose onClick={() => onOpenChange(false)} />
      </DialogHeader>
      <DialogContent className="space-y-4">
        {tarefa && (
          <>
            {/* Cabeçalho: propriedade + tipo + estado */}
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">
                {tarefa.propriedade_id?.nome ?? "Propriedade"}
              </h3>
              <Badge variant="outline">{tipoLabel[tarefa.tipo] ?? tarefa.tipo}</Badge>
              <Badge variant={ESTADO_VARIANT[tarefa.estado] ?? "secondary"}>
                {ESTADO_LABEL[tarefa.estado] ?? tarefa.estado}
              </Badge>
            </div>

            {/* Metadados rápidos */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" />
                {formatarDataHora(tarefa.data)}
              </span>
              <span className="flex items-center gap-1">
                <Timer className="h-4 w-4" />
                {formatarMinutos(tarefa.tempo_limpeza_minutos)}
              </span>
              {tarefa.propriedade_id?.morada && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {tarefa.propriedade_id.morada}
                </span>
              )}
              {tarefa.utilizador_id?.nome && (
                <span className="flex items-center gap-1">
                  <User className="h-4 w-4" />
                  {tarefa.utilizador_id.nome}
                </span>
              )}
            </div>

            {/* Prompt 137 — Badge de tempo de viagem estimado.
                Mostra se tempo_viagem_minutos > 0 (calculado pelo scheduler
                Haversine, capped a 60min). Destaque âmbar para o gestor perceber
                que há deslocação antes da tarefa. */}
            {tarefa.tempo_viagem_minutos != null && tarefa.tempo_viagem_minutos > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/20">
                <Clock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-amber-900 dark:text-amber-100">
                  🚗 <strong>Tempo de Viagem estimado:</strong>{" "}
                  {tarefa.tempo_viagem_minutos} min
                </span>
              </div>
            )}

            {/* Prompt 114 — Lotação/Capacidade Máxima destacada */}
            {tarefa.propriedade_id?.capacidade_hospedes != null &&
              tarefa.propriedade_id.capacidade_hospedes > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/20">
                  <Users className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="text-amber-900 dark:text-amber-100">
                    <strong>Lotação máxima:</strong>{" "}
                    {tarefa.propriedade_id.capacidade_hospedes} hóspede(s)
                  </span>
                </div>
              )}

            {/* Prompt 95 — Card de detalhes da reserva Smoobu */}
            <DetalhesReservaCard detalhes={tarefa.detalhes_reserva} />

            {/* Observações do gestor */}
            {tarefa.observacoes && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <StickyNote className="h-4 w-4 text-primary" />
                    Observações
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm whitespace-pre-wrap">{tarefa.observacoes}</p>
                </CardContent>
              </Card>
            )}

            {/* Observações do staff */}
            {tarefa.observacoes_staff && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <StickyNote className="h-4 w-4 text-emerald-600" />
                    Observações do Staff
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm whitespace-pre-wrap">
                    {tarefa.observacoes_staff}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Avarias reportadas (HF14 — renderização rica com fotos + estado) */}
            {tarefa.avarias && tarefa.avarias.length > 0 && (
              <Card className="border-destructive/30">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    Avarias Reportadas ({tarefa.avarias.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-3">
                    {tarefa.avarias.map((a, i) => {
                      const av = normalizarAvaria(a);
                      return (
                        <li
                          key={i}
                          className="rounded-md bg-destructive/5 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium">
                              {av.descricao}
                            </p>
                            {av.resolvido && (
                              <Badge
                                variant="secondary"
                                className="shrink-0 gap-1 text-xs"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                Resolvido
                              </Badge>
                            )}
                          </div>
                          {av.data_registo && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatarDataAvaria(av.data_registo)}
                            </p>
                          )}
                          {av.fotos && av.fotos.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {av.fotos.map((foto, fi) => (
                                <a
                                  key={fi}
                                  href={foto}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block h-16 w-16 overflow-hidden rounded-md border"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={foto}
                                    alt={`Avaria ${i + 1} — foto ${fi + 1}`}
                                    className="h-full w-full object-cover"
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
