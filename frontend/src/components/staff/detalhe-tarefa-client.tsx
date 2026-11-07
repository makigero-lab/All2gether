"use client";

import { TipoLimpezaBadge, rotuloTipoLimpeza } from "@/components/tipo-limpeza-badge";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { comprimirImagem } from "@/lib/imagem";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Clock,
  Timer,
  MapPin,
  SprayCan,
  LogIn,
  LogOut,
  Wrench,
  CheckCircle2,
  ListChecks,
  StickyNote,
  Check,
  AlertTriangle,
  Loader2,
  Users,
  CalendarRange,
  ClipboardList,
  Folder,
  Camera,
  X,
  AlertCircle,
  Navigation,
  Shirt,
  Play,
  TriangleAlert,
} from "lucide-react";
import { textoEquipa } from "@/lib/equipa";

import { cn, parsearDataSegura, googleMapsUrl, plural } from "@/lib/utils";
import {
  MSG_SEM_LIGACAO,
  eErroDeRede,
  guardarRascunho,
  guardarRascunhoAvaria,
  lerRascunho,
  lerRascunhoAvaria,
  limparRascunho,
  mensagemErro,
} from "@/lib/rascunho-staff";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminPost, adminPatch } from "@/lib/api";
import type { TarefaMock, EstadoTarefa, TipoTarefa } from "@/lib/api";
import { DetalhesReservaCard } from "@/components/detalhes-reserva-card";
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
 * Ecrã de Detalhe da Tarefa (Client Component).
 *
 * Estado gerido com React State:
 *  - `itensMarcados`: array booleano (um por item da checklist).
 *  - `observacoes`: texto livre do textarea.
 *  - `concluida`: flag que desativa o botão após concluir (simulação).
 *
 * Regra de Negócio Visual:
 *  O botão "Concluir Limpeza" está `disabled` ENQUANTO nem todas as
 *  checkboxes estiverem marcadas (ou seja, `todasMarcadas === false`).
 */
export function DetalheTarefaClient({
  tarefa,
  checklist,
}: {
  tarefa: TarefaMock;
  checklist: string[];
}) {
  const router = useRouter();
  const Icon = tipoIcon[tarefa.tipo];

  // Prompt 113 — Se a tarefa JÁ estiver concluída (ex.: reabrir o detalhe),
  // bloqueia TODA a interação: checklists, observações, Concluir, Atraso,
  // Avaria. Mostra o estado final sem permitir editar.
  const jaConcluida = tarefa.estado === "concluida";

  // Início da limpeza («Comecei» / automático): estado local, atualizado sem recarregar a página
  // (recarregar perderia a checklist e as notas por gravar).
  const [estadoLocal, setEstadoLocal] = useState<string>(tarefa.estado);
  const [iniciadaEm, setIniciadaEm] = useState<string | null>(tarefa.iniciada_em ?? null);
  const [inicioOrigem, setInicioOrigem] = useState<string | null>(tarefa.inicio_origem ?? null);
  const [naoConseguiAvisado, setNaoConseguiAvisado] = useState<boolean>(!!tarefa.nao_consegui_comecar);
  const podeComecar = estadoLocal === "atribuida" && !jaConcluida;

  // Prompt 133 — Checklist dinâmica (snapshot do ModeloChecklist).
  // Se existir e tiver pelo menos 1 item, renderiza secções em vez da
  // checklist flat. Caso contrário, cai no comportamento antigo (array de
  // strings do propriedade_id.checklist).
  const seccoesDinamicas = (tarefa.checklist_dinamica ?? []).filter(
    (s) => Array.isArray(s.items) && s.items.length > 0
  );
  const temChecklistDinamica = seccoesDinamicas.length > 0;

  // Estado da checklist dinâmica — clona o snapshot para podermos fazer toggle
  // local (optimistic) sem mutar o prop. Cada item mantém o seu concluido.
  const [dinamica, setDinamica] = useState(() =>
    seccoesDinamicas.map((s) => ({
      nome: s.nome,
      items: s.items.map((it) => ({
        texto: it.texto,
        concluido: jaConcluida ? true : it.concluido,
      })),
    }))
  );

  // Rascunho local (notas + checklist flat) para sobreviver a falhas de rede.
  const [rascunhoInicial] = useState(() =>
    jaConcluida || typeof window === "undefined"
      ? null
      : lerRascunho(String(tarefa.id), checklist.length)
  );
  const [itensMarcados, setItensMarcados] = useState<boolean[]>(
    // Se já estiver concluída, pré-marca todos os itens (reflete o final).
    () => rascunhoInicial?.itens ?? checklist.map(() => jaConcluida)
  );
  const [observacoes, setObservacoes] = useState(jaConcluida ? (tarefa.observacoes_staff ?? "") : (rascunhoInicial?.observacoes ?? ""));
  const [concluida, setConcluida] = useState(jaConcluida);
  const [concluindo, setConcluindo] = useState(false);
  const [erroConcluir, setErroConcluir] = useState<string | null>(null);

  // HF19 — Modal de conclusão com fotos obrigatórias
  const [mostrarConcluir, setMostrarConcluir] = useState(false);
  const [concluirFotos, setConcluirFotos] = useState<string[]>([]);
  const [concluirResultado, setConcluirResultado] = useState<string | null>(null);
  // FIX (portal lavandaria) — Sacos de roupa suja recolhidos pelo staff.
  // Enviado no PATCH /concluir para o backend guardar em tarefa.sacos_roupa_suja.
  const [sacosRoupaSuja, setSacosRoupaSuja] = useState<string>("");

  // Modal de reportar atraso
  const [mostrarAtraso, setMostrarAtraso] = useState(false);
  const [minutosAtraso, setMinutosAtraso] = useState<number | null>(null);
  const [atrasoSubmitting, setAtrasoSubmitting] = useState(false);
  const [atrasoResultado, setAtrasoResultado] = useState<string | null>(null);
  // Erro (ex.: sem rede): NUNCA vai para o estado de sucesso; o formulário mantém-se.
  const [atrasoErro, setAtrasoErro] = useState<string | null>(null);

  // Modal de reportar avaria (v1.38.0 / HF13 enriquecido com fotos)
  const [mostrarAvaria, setMostrarAvaria] = useState(false);
  const [avariaDesc, setAvariaDesc] = useState(() =>
    typeof window === "undefined" ? "" : lerRascunhoAvaria(String(tarefa.id))
  );
  const [avariaErro, setAvariaErro] = useState<string | null>(null);
  // HF13 — fotos em base64 (upload simplificado, sem object storage).
  // O input type="file" lê o ficheiro e converte para base64 via FileReader.
  const [avariaFotos, setAvariaFotos] = useState<string[]>([]);
  const [erroFotosAvaria, setErroFotosAvaria] = useState<string | null>(null);
  const [avariaSubmitting, setAvariaSubmitting] = useState(false);
  const [avariaResultado, setAvariaResultado] = useState<string | null>(null);

  // Número de itens concluídos e total — para o contador e a regra do botão.
  // Prompt 133 — Quando há checklist dinâmica, conta itens das secções.
  const totalItens = temChecklistDinamica
    ? dinamica.reduce((acc, s) => acc + s.items.length, 0)
    : checklist.length;
  const itensConcluidos = useMemo(() => {
    if (temChecklistDinamica) {
      return dinamica.reduce(
        (acc, s) => acc + s.items.filter((i) => i.concluido).length,
        0
      );
    }
    return itensMarcados.filter(Boolean).length;
  }, [temChecklistDinamica, dinamica, itensMarcados]);
  // Se a checklist estiver vazia, o botão fica sempre ativo (não há itens para marcar).
  const todasMarcadas = totalItens === 0 || itensConcluidos === totalItens;

  // O texto da avaria sobrevive a fechar/reabrir e a recarregar (fotos não: RGPD).
  useEffect(() => {
    guardarRascunhoAvaria(String(tarefa.id), avariaDesc);
  }, [tarefa.id, avariaDesc]);

  // Guarda o rascunho sempre que muda (nunca fotos nem dados do hóspede).
  useEffect(() => {
    if (concluida) return;
    guardarRascunho(String(tarefa.id), { observacoes, itens: itensMarcados });
  }, [tarefa.id, observacoes, itensMarcados, concluida]);

  // Se o envio falhou por falta de rede e o diálogo continua aberto, volta a
  // tentar sozinho quando a rede regressa (o botão "Tentar de novo" também serve).
  useEffect(() => {
    const aoVoltarRede = () => {
      if (mostrarAvaria && avariaErro === MSG_SEM_LIGACAO && !avariaSubmitting) {
        void handleReportarAvaria();
      } else if (mostrarAtraso && atrasoErro === MSG_SEM_LIGACAO && !atrasoSubmitting) {
        void handleReportarAtraso();
      }
    };
    window.addEventListener("online", aoVoltarRede);
    return () => window.removeEventListener("online", aoVoltarRede);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mostrarAvaria, mostrarAtraso, avariaErro, atrasoErro, avariaSubmitting, atrasoSubmitting]);

  const toggleItem = (index: number, value: boolean) => {
    setItensMarcados((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  // Prompt 133 — Toggle de item da checklist dinâmica.
  // Faz PATCH ao endpoint do staff passando seccaoIndex/itemIndex e atualiza
  // o estado local OTIMISTICAMENTE. Em caso de erro, reverte.
  const toggleItemDinamico = async (
    seccaoIndex: number,
    itemIndex: number,
    novoValor: boolean
  ) => {
    // Snapshot do estado atual (para reverter se falhar).
    const estadoAnterior = dinamica;

    // Optimistic: atualiza local imediatamente.
    setDinamica((prev) =>
      prev.map((s, si) =>
        si === seccaoIndex
          ? {
              ...s,
              items: s.items.map((it, ii) =>
                ii === itemIndex ? { ...it, concluido: novoValor } : it
              ),
            }
          : s
      )
    );

    try {
      await adminPatch(
        `/api/staff/tarefas/${tarefa.id}/checklist/${seccaoIndex}/item/${itemIndex}`,
        { concluido: novoValor }
      );
      // Sucesso — mantém o estado optimistic.
    } catch (e) {
      // Erro — reverte ao estado anterior.
      setDinamica(estadoAnterior);
      setErroConcluir(
        eErroDeRede(e)
          ? MSG_SEM_LIGACAO
          : e instanceof Error
            ? `Não foi possível atualizar o item: ${e.message}`
            : "Erro ao atualizar item da checklist."
      );
      // Limpa a mensagem após 4s.
      setTimeout(() => setErroConcluir(null), 4000);
    }
  };

  // HF19 — Abre o modal de conclusão (em vez de concluir diretamente).
  const handleConcluir = () => {
    if (!todasMarcadas || concluida || concluindo) return;
    setConcluirFotos([]);
    setConcluirResultado(null);
    setMostrarConcluir(true);
  };

  // HF19 — Processa a seleção de fotos para a conclusão (mesma lógica das avarias).
  async function handleSelecionarFotosConcluir(e: React.ChangeEvent<HTMLInputElement>) {
    const ficheiros = Array.from(e.target.files || []);
    e.target.value = "";
    if (ficheiros.length === 0) return;
    const slotsDisponiveis = 5 - concluirFotos.length;
    if (ficheiros.length > slotsDisponiveis) {
      setErroConcluir("Máximo de 5 fotos. As restantes foram ignoradas.");
    } else {
      setErroConcluir(null);
    }
    for (const ficheiro of ficheiros.slice(0, Math.max(0, slotsDisponiveis))) {
      const r = await comprimirImagem(ficheiro);
      if (r.ok) {
        setConcluirFotos((prev) => [...prev, r.dataUrl].slice(0, 5));
      } else {
        setErroConcluir(r.erro);
      }
    }
  }

  function removerFotoConcluir(index: number) {
    setConcluirFotos((prev) => prev.filter((_, i) => i !== index));
  }

  // HF19 — Confirma a conclusão: envia PATCH com fotos_conclusao obrigatórias.
  async function handleConfirmarConclusao() {
    if (concluirFotos.length === 0) return;
    setConcluindo(true);
    setErroConcluir(null);
    try {
      const res = await fetch(`/api/staff/tarefas/${tarefa.id}/concluir`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observacoes_staff: observacoes,
          fotos_conclusao: concluirFotos,
          // FIX (portal lavandaria) — Sacos de roupa suja recolhidos.
          sacos_roupa_suja: sacosRoupaSuja === "" ? 0 : Number(sacosRoupaSuja),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setConcluida(true);
      limparRascunho(String(tarefa.id));
      setMostrarConcluir(false);
      // Mostra a mensagem verde durante 1.2s antes de redirecionar.
      setTimeout(() => router.push("/staff"), 1200);
    } catch (e) {
      setErroConcluir(mensagemErro(e, "Erro ao concluir tarefa."));
    } finally {
      setConcluindo(false);
    }
  }

  async function handleReportarAtraso() {
    if (minutosAtraso === null) return;
    setAtrasoSubmitting(true);
    setAtrasoResultado(null);
    setAtrasoErro(null);
    try {
      // v1.55.0 (Prompt 77) — usa o endpoint do staff (não do gestor) para
      // evitar 403. O backend valida que a tarefa pertence ao req.user.id.
      const res = await adminPost<{ carga_total: number; cascata_desatribuida: boolean }>(
        `/api/staff/tarefas/${tarefa.id}/atraso`,
        { minutos_atraso: minutosAtraso }
      );
      if (res.cascata_desatribuida) {
        setAtrasoResultado(
          `Atraso registado. Carga total: ${res.carga_total} min. Uma tarefa posterior foi desatribuída para não comprometer as limpezas.`
        );
      } else {
        setAtrasoResultado(
          `Atraso registado com sucesso. Carga total do dia: ${res.carga_total} min.`
        );
      }
    } catch (e) {
      setAtrasoErro(mensagemErro(e, "Erro ao reportar atraso."));
    } finally {
      setAtrasoSubmitting(false);
    }
  }

  // v1.38.0 / HF13 — Reportar avaria (com fotos opcional)
  async function handleReportarAvaria() {
    if (!avariaDesc.trim()) return;
    setAvariaSubmitting(true);
    setAvariaResultado(null);
    setAvariaErro(null);
    try {
      const res = await fetch(`/api/staff/tarefas/${tarefa.id}/avaria`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descricao: avariaDesc.trim(),
          // HF13 — envia as fotos em base64 (se houver).
          fotos: avariaFotos.length > 0 ? avariaFotos : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setAvariaResultado("Avaria reportada com sucesso. O gestor será notificado.");
      setAvariaDesc("");
      setAvariaFotos([]);
      guardarRascunhoAvaria(String(tarefa.id), "");
      // Fecha o dialog após 1.5s.
      setTimeout(() => {
        setMostrarAvaria(false);
        setAvariaResultado(null);
      }, 1500);
    } catch (e) {
      // Erro: o formulário (texto e fotos) mantém-se e pode tentar-se de novo.
      setAvariaErro(mensagemErro(e, "Erro ao reportar avaria."));
    } finally {
      setAvariaSubmitting(false);
    }
  }

  // HF13 — Processa a seleção de ficheiros e converte para base64.
  // Limita a 5 fotos, cada uma até ~2MB (base64 incluído no payload JSON).
  async function handleSelecionarFotos(e: React.ChangeEvent<HTMLInputElement>) {
    const ficheiros = Array.from(e.target.files || []);
    e.target.value = "";
    if (ficheiros.length === 0) return;
    const slotsDisponiveis = 5 - avariaFotos.length;
    setErroFotosAvaria(
      ficheiros.length > slotsDisponiveis ? "Máximo de 5 fotos. As restantes foram ignoradas." : null
    );
    for (const ficheiro of ficheiros.slice(0, Math.max(0, slotsDisponiveis))) {
      const r = await comprimirImagem(ficheiro);
      if (r.ok) {
        setAvariaFotos((prev) => [...prev, r.dataUrl].slice(0, 5));
      } else {
        setErroFotosAvaria(r.erro);
      }
    }
  }

  // HF13 — Remove uma foto da lista (botão X sobre a preview).
  function removerFoto(index: number) {
    setAvariaFotos((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-muted/20">
      {/* Cabeçalho com nome da propriedade no topo + voltar */}
      <header className="sticky top-0 z-20 border-b bg-background/95 px-5 pb-4 pt-5 backdrop-blur">
        <Link
          href="/staff"
          prefetch
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Link>

        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-brand-text">
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold leading-tight">
              {tarefa.propriedade_nome}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {tarefa.tipo === "limpeza" && tarefa.tipo_limpeza && tarefa.tipo_limpeza !== "normal"
                ? <TipoLimpezaBadge tipo={tarefa.tipo_limpeza} />
                : tipoLabel[tarefa.tipo]}
            </div>
          </div>
        </div>

        {/* Metadados rápidos */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Clock className="h-3.5 w-3.5" />
            {tarefa.hora_limite}
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Timer className="h-3.5 w-3.5" />
            {formatarMinutos(tarefa.tempo_estimado_minutos)}
          </span>
          {/* Prompt 138 (136 V2) — Tempo de viagem entre a tarefa anterior e esta. */}
          {tarefa.tempo_viagem_minutos != null && tarefa.tempo_viagem_minutos > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap text-amber-600 dark:text-amber-400">
              <MapPin className="h-3.5 w-3.5" />
              +{formatarMinutos(tarefa.tempo_viagem_minutos)} viagem
            </span>
          )}
          {textoEquipa(tarefa.equipa_nomes) && (
            <span className="flex basis-full items-center gap-1 font-medium text-foreground sm:basis-auto">
              <Users className="h-3.5 w-3.5" />
              Equipa: {textoEquipa(tarefa.equipa_nomes)}
            </span>
          )}
          {tarefa.endereco && (
            <span className="flex min-w-0 basis-full items-center gap-1">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{tarefa.endereco}</span>
              {/* FIX (google maps integration) — Botão "Abrir no Google Maps"
                  para navegação direta à propriedade. */}
              {(() => {
                const url = googleMapsUrl(tarefa.endereco);
                if (!url) return null;
                return (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="-my-3.5 -mr-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-brand-text hover:underline"
                    title="Abrir no Google Maps"
                    aria-label="Abrir no Google Maps"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                  </a>
                );
              })()}
            </span>
          )}
        </div>

        {/* Prompt 118 — Data da Limpeza + Hora destacadas no topo */}
        {tarefa.data && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
            <CalendarRange className="h-5 w-5 shrink-0 text-brand-text" />
            <div className="flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Data da Limpeza
              </p>
              <p className="text-sm font-bold text-foreground">
                {(() => {
                  // Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
                  const d = parsearDataSegura(tarefa.data);
                  if (!d) return tarefa.data ?? "—";
                  try {
                    const dataFmt = d.toLocaleDateString("pt-PT", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                      timeZone: "Europe/Lisbon",
                    });
                    const hora = d.toLocaleTimeString("pt-PT", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Europe/Lisbon",
                    });
                    return hora !== "00:00" ? `${dataFmt} · ${hora}` : dataFmt;
                  } catch {
                    return tarefa.data ?? "—";
                  }
                })()}
              </p>
            </div>
          </div>
        )}
      </header>

      {/* Conteúdo principal */}
      <main className="flex-1 space-y-5 p-5">
        {/* Início da limpeza: «Comecei» (ou o estado atual) e «Não consegui começar». */}
        {!jaConcluida && podeComecar && (
          <div className="space-y-1 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <BotaoComecei
              tarefaId={String(tarefa.id)}
              onFeito={() => {
                setEstadoLocal("em_curso");
                setIniciadaEm(new Date().toISOString());
                setInicioOrigem("botao");
                setNaoConseguiAvisado(false);
              }}
            />
            <BotaoNaoConsegui
              tarefaId={String(tarefa.id)}
              onFeito={() => setNaoConseguiAvisado(true)}
            />
            {naoConseguiAvisado && (
              <p className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-200">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Avisaste o gestor que não conseguiste começar.
              </p>
            )}
          </div>
        )}
        {!jaConcluida && estadoLocal === "em_curso" && (
          <p className="flex items-center gap-2 rounded-md bg-status-curso-bg px-3 py-2.5 text-sm font-medium text-status-curso">
            <Play className="h-4 w-4 shrink-0" aria-hidden="true" />
            Em curso{horaCurta(iniciadaEm) ? ` desde as ${horaCurta(iniciadaEm)}` : ""}
            {inicioOrigem === "automatico" ? " (início automático)" : ""}
          </p>
        )}

        {/* Avaria por resolver noutra limpeza desta casa. */}
        {!jaConcluida && tarefa.avarias_abertas_casa && tarefa.avarias_abertas_casa.length > 0 && (
          <div role="note" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm">
            <p className="flex items-center gap-2 font-semibold text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              Avaria aberta nesta casa
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-6 text-foreground">
              {tarefa.avarias_abertas_casa.map((a, i) => (
                <li key={i}>{a.descricao}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Checklist interativa */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ListChecks className="h-5 w-5 text-brand-text" />
                Checklist
              </CardTitle>
              <Badge variant={todasMarcadas ? "success" : "secondary"}>
                {itensConcluidos}/{totalItens}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {/* Prompt 133 — Checklist dinâmica (secções + items). */}
            {temChecklistDinamica ? (
              <div className="space-y-4">
                {dinamica.map((sec, secIdx) => {
                  const secTotal = sec.items.length;
                  const secConcluidos = sec.items.filter((i) => i.concluido).length;
                  return (
                    <div key={`sec-${secIdx}`} className="space-y-1">
                      {/* Sub-header da secção */}
                      <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Folder className="h-4 w-4 shrink-0 text-brand-text" />
                          <span className="truncate text-sm font-semibold text-foreground">
                            {sec.nome || "Secção"}
                          </span>
                        </div>
                        <Badge
                          variant={secConcluidos === secTotal ? "success" : "outline"}
                          className="shrink-0 text-xs"
                        >
                          {secConcluidos}/{secTotal}
                        </Badge>
                      </div>
                      {/* Items da secção */}
                      <ul className="space-y-1">
                        {sec.items.map((item, itemIdx) => {
                          const checked = item.concluido;
                          const checkboxId = `tarefa-${tarefa.id}-sec-${secIdx}-item-${itemIdx}`;
                          return (
                            <li
                              key={`${secIdx}-${itemIdx}-${item.texto}`}
                              className={cn(
                                "flex items-center gap-3 rounded-md px-3 py-3 transition-colors",
                                checked
                                  ? "bg-emerald-50 dark:bg-emerald-950/30"
                                  : "hover:bg-accent"
                              )}
                            >
                              <Checkbox
                                id={checkboxId}
                                checked={checked}
                                onCheckedChange={(v) =>
                                  toggleItemDinamico(secIdx, itemIdx, v)
                                }
                                disabled={jaConcluida}
                              />
                              <label
                                htmlFor={checkboxId}
                                className={cn(
                                  "flex-1 cursor-pointer text-sm transition-colors",
                                  checked && "text-muted-foreground line-through"
                                )}
                              >
                                {item.texto}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Fallback — Checklist flat antiga (array de strings). */
              <ul className="space-y-1">
                {checklist.map((item, index) => {
                  const checked = itensMarcados[index];
                  const checkboxId = `tarefa-${tarefa.id}-item-${index}`;
                  return (
                    <li
                      key={`${item}-${index}`}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-3 transition-colors",
                        checked ? "bg-emerald-50 dark:bg-emerald-950/30" : "hover:bg-accent"
                      )}
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        onCheckedChange={(v) => toggleItem(index, v)}
                        disabled={jaConcluida}
                      />
                      <label
                        htmlFor={checkboxId}
                        className={cn(
                          "flex-1 cursor-pointer text-sm transition-colors",
                          checked && "text-muted-foreground line-through"
                        )}
                      >
                        {item}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Barra de progresso visual */}
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{
                  width: `${
                    totalItens > 0 ? (itensConcluidos / totalItens) * 100 : 0
                  }%`,
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Observações */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <StickyNote className="h-5 w-5 text-brand-text" />
              Observações ou Problemas
              <span className="text-xs font-normal text-muted-foreground">
                (opcional)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              placeholder="Ex.: faltava toalhas no WC; torneira da cozinha a pingar…"
              rows={4}
              maxLength={500}
              disabled={jaConcluida}
            />
            <p className="mt-1 text-right text-xs text-muted-foreground">
              {observacoes.length}/500
            </p>
          </CardContent>
        </Card>
        {/* Tipo de limpeza especial: só promete checklist própria quando a tarefa a tem. */}
        {tarefa.tipo === "limpeza" && tarefa.tipo_limpeza && tarefa.tipo_limpeza !== "normal" && (
          <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
            <strong>Limpeza {rotuloTipoLimpeza(tarefa.tipo_limpeza).toLowerCase()}:</strong>{" "}
            {tarefa.checklist_do_tipo
              ? "segue a checklist própria desta casa"
              : "segue a checklist habitual da casa"}
          </p>
        )}

        {/* Prompt 114 — Lotação/Capacidade Máxima destacada */}
        {tarefa.capacidade_hospedes != null && tarefa.capacidade_hospedes > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2.5 text-sm dark:bg-amber-950/20">
            <Users className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="text-amber-900 dark:text-amber-100">
              <strong>Lotação máxima:</strong>{" "}
              {plural(tarefa.capacidade_hospedes, "hóspede")}
            </span>
          </div>
        )}

        {/* Lavandaria: só com fornecedor associado à casa. */}
        {tarefa.tem_lavandaria && tarefa.tipo === "limpeza" && (
          <p
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium",
              tarefa.roupa_entregue
                ? "bg-status-conc-bg text-status-conc"
                : "border border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/20 dark:text-amber-100"
            )}
          >
            <Shirt className="h-4 w-4 shrink-0" aria-hidden="true" />
            Roupa limpa: {tarefa.roupa_entregue ? "entregue" : "em falta"}
          </p>
        )}

        {/* Prompt 95 — Card de detalhes da reserva Smoobu (se existir). */}
        <DetalhesReservaCard detalhes={tarefa.detalhes_reserva} />

        {/* Prompt 126 — Observações/notas internas da propriedade (regras de acesso, etc.). */}
        {tarefa.observacoes_propriedade && tarefa.observacoes_propriedade.trim() && (
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-5 w-5 text-brand-text" />
                Observações da Propriedade
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {tarefa.observacoes_propriedade}
              </p>
            </CardContent>
          </Card>
        )}

      </main>

      {/* Botão Concluir Limpeza — fixo no fundo */}
      <footer className="sticky bottom-0 space-y-2 border-t bg-background/95 p-4 backdrop-blur">
        {/* Mensagem de erro */}
        {erroConcluir && (
          <p className="text-center text-sm text-destructive">{erroConcluir}</p>
        )}

        {/* Mensagem de sucesso verde vibrante */}
        {concluida && (
          <div className="flex items-center justify-center gap-2 rounded-lg bg-status-conc p-3 text-center text-status-foreground">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-semibold">Limpeza Concluída!</span>
          </div>
        )}

        {/* Botão Reportar Atraso */}
        {!concluida && (
          <div className="flex gap-2">
            <Button size="touch"
              variant="outline"
              className="flex-1 gap-2 text-status-porat border-status-porat/40 hover:bg-status-porat-bg"
              onClick={() => {
                setMostrarAtraso(true);
                setMinutosAtraso(null);
                setAtrasoResultado(null);
                setAtrasoErro(null);
              }}
            >
              <AlertTriangle className="h-4 w-4" />
              Atraso
            </Button>
            {/* Botão Reportar Avaria (v1.38.0) */}
            <Button size="touch"
              variant="outline"
              className="flex-1 gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={() => {
                // Mantém o texto e as fotos já escritos (rascunho).
                setMostrarAvaria(true);
                setAvariaResultado(null);
                setAvariaErro(null);
              }}
            >
              <AlertTriangle className="h-4 w-4" />
              Avaria
            </Button>
          </div>
        )}

        {!concluida && (
          <Button
            size="touch"
            className={cn(
              "w-full",
              todasMarcadas
                ? "bg-status-conc text-status-foreground hover:bg-status-conc/90"
                : // Incompleto: cinzento tracejado com texto legível (não só "mais pálido").
                  "border border-dashed border-border bg-muted text-muted-foreground disabled:opacity-100"
            )}
            disabled={!todasMarcadas || concluindo}
            onClick={handleConcluir}
          >
            {concluindo ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                A concluir…
              </>
            ) : todasMarcadas ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                Concluir limpeza
              </>
            ) : (
              `Concluir limpeza (${itensConcluidos}/${totalItens})`
            )}
          </Button>
        )}
        {!todasMarcadas && !concluida && totalItens > 0 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Marca todos os itens da checklist para concluir a tarefa.
          </p>
        )}
      </footer>

      {/* Modal de Reportar Atraso */}
      <Dialog
        open={mostrarAtraso}
        onOpenChange={(o) => !o && setMostrarAtraso(false)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Reportar atraso
            </DialogTitle>
            <DialogDescription>
              Quanto tempo extra precisas para concluir esta tarefa?
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setMostrarAtraso(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {!atrasoResultado ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[15, 30, 60].map((min) => (
                  <button
                    key={min}
                    type="button"
                    onClick={() => setMinutosAtraso(min)}
                    className={`rounded-md border px-4 py-3 text-sm font-medium transition-colors ${
                      minutosAtraso === min
                        ? "border-status-porat bg-status-porat text-status-foreground"
                        : "border-input bg-background hover:bg-accent"
                    }`}
                  >
                    +{min} min
                  </button>
                ))}
              </div>
              {atrasoErro && (
                <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {atrasoErro}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200">
              {atrasoResultado}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button size="touch"
            type="button"
            variant="outline"
            onClick={() => setMostrarAtraso(false)}
            disabled={atrasoSubmitting}
          >
            {atrasoResultado ? "Fechar" : "Cancelar"}
          </Button>
          {!atrasoResultado && (
            <Button size="touch"
              type="button"
              className="bg-status-porat text-status-foreground hover:bg-status-porat/90"
              disabled={minutosAtraso === null || atrasoSubmitting}
              onClick={handleReportarAtraso}
            >
              {atrasoSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A enviar…
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4" />
                  {atrasoErro ? "Tentar de novo" : "Confirmar Atraso"}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* Modal de Reportar Avaria (v1.38.0 / HF13 com fotos) */}
      <Dialog
        open={mostrarAvaria}
        onOpenChange={(o) => {
          // Fechar não apaga o que foi escrito: só o envio com sucesso limpa.
          if (!o) setMostrarAvaria(false);
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Reportar avaria
            </DialogTitle>
            <DialogDescription>
              Descreve o problema encontrado na propriedade. Podes anexar fotos
              (opcional, máx. 5).
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setMostrarAvaria(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {!avariaResultado ? (
            <>
              <div className="space-y-1.5">
              <label htmlFor="avaria-desc" className="text-sm font-medium">
                Descreva o problema
              </label>
              <textarea
                id="avaria-desc"
                value={avariaDesc}
                onChange={(e) => setAvariaDesc(e.target.value)}
                rows={3}
                placeholder="Ex.: torneira da cozinha a pingar; lâmpada fundida no WC…"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              </div>

              {/* HF13 — Input de fotos (opcional, máx. 5) */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Fotos (opcional)
                </label>
                {avariaFotos.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {avariaFotos.map((foto, idx) => (
                      <div
                        key={idx}
                        className="relative h-20 w-20 overflow-hidden rounded-md border"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={foto}
                          alt={`Avaria ${idx + 1}`}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removerFoto(idx)}
                          className="absolute right-0 top-0 rounded-bl-md bg-red-600 p-0.5 text-white hover:bg-red-700"
                          aria-label="Remover foto"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {avariaFotos.length < 5 && (
                  <label
                    htmlFor="avaria-fotos"
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50"
                  >
                    <Camera className="h-4 w-4" />
                    {avariaFotos.length === 0
                      ? "Adicionar fotos"
                      : `Adicionar mais (${avariaFotos.length}/5)`}
                    <input
                      id="avaria-fotos"
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleSelecionarFotos}
                      className="hidden"
                    />
                  </label>
                )}
                {erroFotosAvaria && (
                  <p role="alert" className="text-sm text-destructive">{erroFotosAvaria}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Máx. 5 fotos (são reduzidas automaticamente).
                </p>
              </div>
              {avariaErro && (
                <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {avariaErro}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/20 p-3 text-sm text-emerald-800 dark:text-emerald-200">
              {avariaResultado}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button size="touch"
            type="button"
            variant="outline"
            onClick={() => setMostrarAvaria(false)}
            disabled={avariaSubmitting}
          >
            {avariaResultado ? "Fechar" : "Cancelar"}
          </Button>
          {!avariaResultado && (
            <Button size="touch"
              type="button"
              variant="destructive"
              disabled={!avariaDesc.trim() || avariaSubmitting}
              onClick={handleReportarAvaria}
            >
              {avariaSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A enviar…
                </>
              ) : (
                <>
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  {avariaErro ? "Tentar de novo" : "Reportar Avaria"}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* HF19 — Modal de Conclusão com Fotos Obrigatórias */}
      <Dialog
        open={mostrarConcluir}
        onOpenChange={(o) => {
          if (!o && !concluindo) {
            setMostrarConcluir(false);
            setConcluirFotos([]);
          }
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Confirmar conclusão
            </DialogTitle>
            <DialogDescription>
              Tira pelo menos 1 foto da propriedade limpa para confirmar a
              conclusão. (Máx. 5 fotos)
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !concluindo && setMostrarConcluir(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {/* Preview das fotos */}
          {concluirFotos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {concluirFotos.map((foto, idx) => (
                <div
                  key={idx}
                  className="relative h-20 w-20 overflow-hidden rounded-md border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={foto}
                    alt={`Conclusão ${idx + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removerFotoConcluir(idx)}
                    className="absolute right-0 top-0 rounded-bl-md bg-red-600 p-0.5 text-white hover:bg-red-700"
                    aria-label="Remover foto"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input de fotos */}
          {concluirFotos.length < 5 && (
            <label
              htmlFor="concluir-fotos"
              className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50"
            >
              <Camera className="h-4 w-4" />
              {concluirFotos.length === 0
                ? "Tirar foto / Anexar (obrigatório)"
                : `Adicionar mais (${concluirFotos.length}/5)`}
              <input
                id="concluir-fotos"
                type="file"
                accept="image/*"
                multiple
                onChange={handleSelecionarFotosConcluir}
                className="hidden"
              />
            </label>
          )}

          {/* Aviso se não há fotos */}
          {concluirFotos.length === 0 && (
            <p className="text-sm text-destructive">
              ⚠️ É obrigatório anexar pelo menos 1 foto para concluir.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Máx. 5 fotos (são reduzidas automaticamente).
          </p>

          {/* FIX (portal lavandaria) — Input de sacos de roupa suja recolhidos. */}
          <div className="space-y-1.5 rounded-md border border-input p-3">
            <label htmlFor="sacos-roupa-suja" className="text-sm font-medium flex items-center gap-1.5">
              <Shirt className="h-4 w-4 text-brand-text" />
              Sacos de Roupa Suja Recolhidos
            </label>
            <Input
              id="sacos-roupa-suja"
              type="number"
              min={0}
              step={1}
              value={sacosRoupaSuja}
              onChange={(e) => setSacosRoupaSuja(e.target.value)}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground">
              Nº de sacos de roupa suja recolhidos nesta limpeza (para a lavandaria).
            </p>
          </div>

          {erroConcluir && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {erroConcluir}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button size="touch"
            type="button"
            variant="outline"
            onClick={() => setMostrarConcluir(false)}
            disabled={concluindo}
          >
            Cancelar
          </Button>
          <Button size="touch"
            type="button"
            disabled={concluirFotos.length === 0 || concluindo}
            onClick={handleConfirmarConclusao}
            className="bg-status-conc text-status-foreground hover:bg-status-conc/90"
          >
            {concluindo ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A concluir…
              </>
            ) : (
              <>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Confirmar conclusão
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
