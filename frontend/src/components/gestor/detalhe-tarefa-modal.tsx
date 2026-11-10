"use client";

import {
  CalendarClock,
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
  Play,
  ListChecks,
  Loader2,
  OctagonAlert,
} from "lucide-react";

// Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
import { useEffect, useState } from "react";
import { parsearDataSegura, plural } from "@/lib/utils";
import { TipoLimpezaBadge } from "@/components/tipo-limpeza-badge";
import { adminGet, adminPatch, type ContactoHospedeDTO } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { lerUtilizador } from "@/lib/auth";

import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { OfertaVagaBadge } from "@/components/gestor/oferta-vaga-badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DetalhesReservaCard } from "@/components/detalhes-reserva-card";
import { MudarDiaDialog, podeMudarDia } from "@/components/gestor/mudar-dia-dialog";

/** Tarefa no formato devolvido pelo GET /api/gestor/tarefas (com populate). */
export interface AvariaDTO {
  _id?: string;
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
  tipo_limpeza?: string | null;
  propriedade_id?: { nome: string; morada?: string; capacidade_hospedes?: number | null } | null;
  utilizador_id?: { _id?: string; nome: string } | null;
  equipa_atribuida?: { _id?: string; nome: string }[] | null;
  pessoas_em_falta?: number;
  oferta_estado?: string | null;
  oferta_expira_em?: string | null;
  // Início da limpeza e alertas (ex.: «Não consegui começar»).
  iniciada_em?: string | null;
  inicio_origem?: "botao" | "automatico" | null;
  alerta?: string | null;
  hora_conclusao?: string | null;
  concluida_em?: string | null;
}

/** Prova da limpeza (GET /api/gestor/tarefas/:id/prova): carrega-se só ao abrir o modal. */
interface ProvaDTO {
  hora_conclusao: string | null;
  fotos: string[];
  fotos_expiradas: boolean;
  checklist: { feitos: number; total: number };
  avarias: { _id: string | null; descricao: string; fotos: string[]; resolvido: boolean; data_registo: string | null }[];
}

function horaCurta(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });
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

function formatarDataHora(iso: string): string {
  // Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    const data = d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Europe/Lisbon",
    });
    const hora = d.toLocaleTimeString("pt-PT", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Lisbon",
    });
    if (hora === "00:00") return data;
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
  onAvariaAlterada,
  onDiaAlterado,
}: {
  tarefa: TarefaDetalheGestor | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Chamado depois de marcar uma avaria como resolvida (para a lista recarregar). */
  onAvariaAlterada?: () => void;
  /** Chamado depois de «Mudar dia» (a lista recarrega); `aviso` = ficou por atribuir, falta gente... */
  onDiaAlterado?: (aviso: string | null) => void;
}) {
  const [mudarDiaAberto, setMudarDiaAberto] = useState(false);
  const Icon = tarefa ? (tipoIcon[tarefa.tipo] ?? SprayCan) : SprayCan;

  // Prova da limpeza: fotos, hora de conclusão e checklist, só ao abrir.
  const [prova, setProva] = useState<ProvaDTO | null>(null);
  const [provaErro, setProvaErro] = useState<string | null>(null);
  const [provaA, setProvaA] = useState(false);
  const [resolvendo, setResolvendo] = useState<string | null>(null);
  const [fotoGrande, setFotoGrande] = useState<string | null>(null);

  // Email/telefone do hóspede: só o admin os pede (o backend recusa os outros).
  const [contacto, setContacto] = useState<ContactoHospedeDTO | null>(null);
  const tarefaId = tarefa?._id;
  useEffect(() => {
    setContacto(null);
    if (!open || !tarefaId) return;
    let cancelado = false;
    (async () => {
      try {
        const user = await lerUtilizador();
        if (user?.role !== "admin") return;
        const c = await adminGet<ContactoHospedeDTO>(
          `/api/gestor/tarefas/${tarefaId}/contacto-hospede`
        );
        if (!cancelado) setContacto(c);
      } catch {
        // Sem contacto disponível: o cartão simplesmente não o mostra.
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [open, tarefaId]);

  useEffect(() => {
    setProva(null);
    setProvaErro(null);
    setFotoGrande(null);
    if (!open || !tarefaId) return;
    let cancelado = false;
    setProvaA(true);
    (async () => {
      try {
        const p = await adminGet<ProvaDTO>(`/api/gestor/tarefas/${tarefaId}/prova`);
        if (!cancelado) setProva(p);
      } catch (e) {
        if (!cancelado) setProvaErro(mensagemErro(e, "Não foi possível carregar as fotos."));
      } finally {
        if (!cancelado) setProvaA(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [open, tarefaId]);

  async function resolverAvaria(avariaId: string | null) {
    if (!tarefaId || !avariaId) return;
    setResolvendo(avariaId);
    try {
      await adminPatch(`/api/gestor/tarefas/${tarefaId}/avarias/${avariaId}/resolver`, { resolvido: true });
      setProva((p) => (p ? { ...p, avarias: p.avarias.map((a) => (a._id === avariaId ? { ...a, resolvido: true } : a)) } : p));
      onAvariaAlterada?.();
    } catch (e) {
      setProvaErro(mensagemErro(e, "Não foi possível marcar a avaria como resolvida."));
    } finally {
      setResolvendo(null);
    }
  }

  // Avarias a mostrar: as da prova (com fotos) ou, enquanto carrega, as da lista (sem fotos).
  const avariasMostrar: AvariaDTO[] = prova
    ? prova.avarias.map((a) => ({ _id: a._id ?? undefined, descricao: a.descricao, fotos: a.fotos, resolvido: a.resolvido, data_registo: a.data_registo ?? undefined }))
    : (tarefa?.avarias ?? []).map(normalizarAvaria);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <div>
          <DialogTitle className="flex items-center gap-2">
            {tarefa && <Icon className="h-5 w-5 text-brand-text" />}
            Detalhe da Limpeza
          </DialogTitle>
          <DialogDescription>
            Informação completa da limpeza e da reserva associada.
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
              <EstadoTarefaBadge estado={tarefa.estado} />
              <OfertaVagaBadge tarefa={tarefa} />
              {tarefa.tipo === "limpeza" && podeMudarDia(tarefa) && (
                <Button type="button" variant="outline" size="sm" className="ml-auto h-9 gap-1.5" onClick={() => setMudarDiaAberto(true)}>
                  <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  Mudar dia
                </Button>
              )}
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
              {(() => {
                // Equipa completa (responsável primeiro, sem repetidos).
                const vistos = new Set<string>();
                const nomes: string[] = [];
                for (const m of [tarefa.utilizador_id, ...(tarefa.equipa_atribuida ?? [])]) {
                  if (!m?.nome || vistos.has(m._id ?? m.nome)) continue;
                  vistos.add(m._id ?? m.nome);
                  nomes.push(m.nome);
                }
                if (nomes.length === 0) return null;
                return (
                  <span className="flex items-center gap-1">
                    <User className="h-4 w-4" />
                    {nomes.length > 1 ? `${nomes[0]} (resp.) + ${nomes.slice(1).join(" + ")}` : nomes[0]}
                    {(tarefa.pessoas_em_falta ?? 0) > 0 && (
                      <span className="font-medium text-amber-700 dark:text-amber-400">
                        {" "}· falta {tarefa.pessoas_em_falta} {tarefa.pessoas_em_falta === 1 ? "pessoa" : "pessoas"}
                      </span>
                    )}
                  </span>
                );
              })()}
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

            {/* Tipo de limpeza (não muda preços) */}
            {tarefa.tipo === "limpeza" && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Tipo de limpeza:</span>
                <TipoLimpezaBadge tipo={tarefa.tipo_limpeza} sempre />
              </div>
            )}

            {/* Prompt 114 — Lotação/Capacidade Máxima destacada */}
            {tarefa.propriedade_id?.capacidade_hospedes != null &&
              tarefa.propriedade_id.capacidade_hospedes > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/20">
                  <Users className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="text-amber-900 dark:text-amber-100">
                    <strong>Lotação máxima:</strong>{" "}
                    {plural(tarefa.propriedade_id.capacidade_hospedes, "hóspede")}
                  </span>
                </div>
              )}

            {/* Prompt 95 — Card de detalhes da reserva Smoobu */}
            <DetalhesReservaCard detalhes={tarefa.detalhes_reserva} contacto={contacto} />

            {/* Alerta (ex.: «não conseguiu começar», reserva alterada no Smoobu) */}
            {tarefa.alerta && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
                <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-pre-wrap">{tarefa.alerta.split(" | ").join("\n")}</span>
              </div>
            )}

            {/* Início da limpeza */}
            {tarefa.iniciada_em && (
              <p className="flex items-center gap-2 text-sm">
                <Play className="h-4 w-4 text-brand-text" aria-hidden="true" />
                Começou às <strong>{horaCurta(tarefa.iniciada_em)}</strong>
                <span className="text-muted-foreground">
                  ({tarefa.inicio_origem === "automatico" ? "início automático, à hora marcada" : "pelo botão «Comecei»"})
                </span>
              </p>
            )}

            {/* Prova da limpeza: hora de conclusão, checklist e fotos */}
            {tarefa.estado === "concluida" && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Camera className="h-4 w-4 text-emerald-600" />
                    Prova da limpeza
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  {provaA && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> A carregar fotos…
                    </p>
                  )}
                  {provaErro && (
                    <p role="alert" className="text-sm text-destructive">{provaErro}</p>
                  )}
                  <p className="text-sm">
                    Concluída às{" "}
                    <strong>{horaCurta(prova?.hora_conclusao ?? tarefa.hora_conclusao ?? tarefa.concluida_em)}</strong>
                    {prova && prova.checklist.total > 0 && (
                      <span className="ml-3 inline-flex items-center gap-1 text-muted-foreground">
                        <ListChecks className="h-4 w-4" aria-hidden="true" />
                        Checklist: {prova.checklist.feitos}/{prova.checklist.total} itens feitos
                      </span>
                    )}
                  </p>
                  {prova && prova.fotos.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {prova.fotos.map((f, i) => (
                        <li key={i}>
                          <button type="button" onClick={() => setFotoGrande(f)} className="block h-20 w-20 overflow-hidden rounded-md border" aria-label={`Ampliar foto ${i + 1} da limpeza`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={f} alt={`Foto ${i + 1} da limpeza`} className="h-full w-full object-cover" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {prova && prova.fotos.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {prova.fotos_expiradas
                        ? "As fotos já foram apagadas (guardam-se durante 7 dias)."
                        : "Sem fotos nesta limpeza."}
                    </p>
                  )}
                  {fotoGrande && (
                    <div className="space-y-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fotoGrande} alt="Foto ampliada da limpeza" className="max-h-[60vh] w-full rounded-md object-contain" />
                      <Button variant="outline" size="sm" onClick={() => setFotoGrande(null)}>Fechar foto</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Observações do gestor */}
            {tarefa.observacoes && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <StickyNote className="h-4 w-4 text-brand-text" />
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
            {avariasMostrar.length > 0 && (
              <Card className="border-destructive/30">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    Avarias Reportadas ({avariasMostrar.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-3">
                    {avariasMostrar.map((av, i) => {
                      return (
                        <li
                          key={i}
                          className="rounded-md bg-destructive/5 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium">
                              {av.descricao}
                            </p>
                            {av.resolvido ? (
                              <Badge
                                variant="secondary"
                                className="shrink-0 gap-1 text-xs"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                Resolvida
                              </Badge>
                            ) : (
                              av._id && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-9 shrink-0 gap-1"
                                  disabled={resolvendo === av._id}
                                  onClick={() => resolverAvaria(av._id ?? null)}
                                  aria-label={`Marcar a avaria «${av.descricao}» como resolvida`}
                                >
                                  {resolvendo === av._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                                  Resolvida
                                </Button>
                              )
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
      <MudarDiaDialog
        tarefa={tarefa}
        open={mudarDiaAberto}
        onOpenChange={setMudarDiaAberto}
        onFeito={(aviso) => {
          onOpenChange(false);
          onDiaAlterado?.(aviso);
        }}
      />
    </Dialog>
  );
}
