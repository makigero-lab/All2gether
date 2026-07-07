"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
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
 *  O botão "Concluir Tarefa" está `disabled` ENQUANTO nem todas as
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

  const [itensMarcados, setItensMarcados] = useState<boolean[]>(
    () => checklist.map(() => false)
  );
  const [observacoes, setObservacoes] = useState("");
  const [concluida, setConcluida] = useState(false);
  const [concluindo, setConcluindo] = useState(false);
  const [erroConcluir, setErroConcluir] = useState<string | null>(null);

  // Modal de reportar atraso
  const [mostrarAtraso, setMostrarAtraso] = useState(false);
  const [minutosAtraso, setMinutosAtraso] = useState<number | null>(null);
  const [atrasoSubmitting, setAtrasoSubmitting] = useState(false);
  const [atrasoResultado, setAtrasoResultado] = useState<string | null>(null);

  // Modal de reportar avaria (v1.38.0)
  const [mostrarAvaria, setMostrarAvaria] = useState(false);
  const [avariaDesc, setAvariaDesc] = useState("");
  const [avariaSubmitting, setAvariaSubmitting] = useState(false);
  const [avariaResultado, setAvariaResultado] = useState<string | null>(null);

  // Número de itens concluídos e total — para o contador e a regra do botão.
  const totalItens = checklist.length;
  const itensConcluidos = useMemo(
    () => itensMarcados.filter(Boolean).length,
    [itensMarcados]
  );
  // Se a checklist estiver vazia, o botão fica sempre ativo (não há itens para marcar).
  const todasMarcadas = totalItens === 0 || itensConcluidos === totalItens;

  const toggleItem = (index: number, value: boolean) => {
    setItensMarcados((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleConcluir = async () => {
    if (!todasMarcadas || concluida || concluindo) return;
    setConcluindo(true);
    setErroConcluir(null);
    // PATCH real para a rota do staff (v1.34.0) — envia observacoes_staff.
    try {
      await fetch(`/api/staff/tarefas/${tarefa.id}/concluir`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observacoes_staff: observacoes }),
      });
      setConcluida(true);
      // Mostra a mensagem verde durante 1.2s antes de redirecionar.
      setTimeout(() => router.push("/staff"), 1200);
    } catch (e) {
      setErroConcluir(
        e instanceof Error ? e.message : "Erro ao concluir tarefa."
      );
    } finally {
      setConcluindo(false);
    }
  };

  async function handleReportarAtraso() {
    if (minutosAtraso === null) return;
    setAtrasoSubmitting(true);
    setAtrasoResultado(null);
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
      setAtrasoResultado(
        e instanceof Error ? e.message : "Erro ao reportar atraso."
      );
    } finally {
      setAtrasoSubmitting(false);
    }
  }

  // v1.38.0 — Reportar avaria
  async function handleReportarAvaria() {
    if (!avariaDesc.trim()) return;
    setAvariaSubmitting(true);
    setAvariaResultado(null);
    try {
      const res = await fetch(`/api/staff/tarefas/${tarefa.id}/avaria`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descricao: avariaDesc.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setAvariaResultado("Avaria reportada com sucesso. O gestor será notificado.");
      setAvariaDesc("");
      // Fecha o dialog após 1.5s.
      setTimeout(() => {
        setMostrarAvaria(false);
        setAvariaResultado(null);
      }, 1500);
    } catch (e) {
      setAvariaResultado(
        e instanceof Error ? e.message : "Erro ao reportar avaria."
      );
    } finally {
      setAvariaSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-muted/20">
      {/* Cabeçalho com nome da propriedade no topo + voltar */}
      <header className="sticky top-0 z-10 border-b bg-background/95 px-5 pb-4 pt-5 backdrop-blur">
        <Link
          href="/staff"
          prefetch
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Link>

        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold leading-tight">
              {tarefa.propriedade_nome}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tipoLabel[tarefa.tipo]}
            </p>
          </div>
        </div>

        {/* Metadados rápidos */}
        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {tarefa.hora_limite}
          </span>
          <span className="flex items-center gap-1">
            <Timer className="h-3.5 w-3.5" />
            {formatarMinutos(tarefa.tempo_estimado_minutos)}
          </span>
          {tarefa.endereco && (
            <span className="flex min-w-0 items-center gap-1">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{tarefa.endereco}</span>
            </span>
          )}
        </div>
      </header>

      {/* Conteúdo principal */}
      <main className="flex-1 space-y-5 p-5">
        {/* Prompt 95 — Card de detalhes da reserva Smoobu (se existir). */}
        <DetalhesReservaCard detalhes={tarefa.detalhes_reserva} />

        {/* Checklist interativa */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ListChecks className="h-5 w-5 text-primary" />
                Checklist
              </CardTitle>
              <Badge variant={todasMarcadas ? "success" : "secondary"}>
                {itensConcluidos}/{totalItens}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
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
              <StickyNote className="h-5 w-5 text-primary" />
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
            />
            <p className="mt-1 text-right text-xs text-muted-foreground">
              {observacoes.length}/500
            </p>
          </CardContent>
        </Card>
      </main>

      {/* Botão Concluir Tarefa — fixo no fundo */}
      <footer className="sticky bottom-0 space-y-2 border-t bg-background/95 p-4 backdrop-blur">
        {/* Mensagem de erro */}
        {erroConcluir && (
          <p className="text-center text-sm text-destructive">{erroConcluir}</p>
        )}

        {/* Mensagem de sucesso verde vibrante */}
        {concluida && (
          <div className="flex items-center justify-center gap-2 rounded-lg bg-emerald-500 p-3 text-center text-white">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-semibold">Limpeza Concluída!</span>
          </div>
        )}

        {/* Botão Reportar Atraso */}
        {!concluida && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 gap-2 text-amber-600 border-amber-300 hover:bg-amber-50"
              onClick={() => {
                setMostrarAtraso(true);
                setMinutosAtraso(null);
                setAtrasoResultado(null);
              }}
            >
              <AlertTriangle className="h-4 w-4" />
              Atraso
            </Button>
            {/* Botão Reportar Avaria (v1.38.0) */}
            <Button
              variant="outline"
              className="flex-1 gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={() => {
                setMostrarAvaria(true);
                setAvariaDesc("");
                setAvariaResultado(null);
              }}
            >
              <AlertTriangle className="h-4 w-4" />
              Avaria
            </Button>
          </div>
        )}

        {!concluida && (
          <Button
            size="lg"
            className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
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
                Concluir Limpeza
              </>
            ) : (
              `Concluir Limpeza (${itensConcluidos}/${totalItens})`
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
              Reportar Atraso
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
                        ? "border-amber-500 bg-amber-500 text-white"
                        : "border-input bg-background hover:bg-accent"
                    }`}
                  >
                    +{min} min
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200">
              {atrasoResultado}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarAtraso(false)}
            disabled={atrasoSubmitting}
          >
            {atrasoResultado ? "Fechar" : "Cancelar"}
          </Button>
          {!atrasoResultado && (
            <Button
              type="button"
              className="bg-amber-500 text-white hover:bg-amber-600"
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
                  Confirmar Atraso
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* Modal de Reportar Avaria (v1.38.0) */}
      <Dialog
        open={mostrarAvaria}
        onOpenChange={(o) => !o && setMostrarAvaria(false)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Reportar Avaria
            </DialogTitle>
            <DialogDescription>
              Descreve o problema encontrado na propriedade.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setMostrarAvaria(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {!avariaResultado ? (
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
          ) : (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/20 p-3 text-sm text-emerald-800 dark:text-emerald-200">
              {avariaResultado}
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarAvaria(false)}
            disabled={avariaSubmitting}
          >
            {avariaResultado ? "Fechar" : "Cancelar"}
          </Button>
          {!avariaResultado && (
            <Button
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
                  Reportar Avaria
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </div>
  );
}
