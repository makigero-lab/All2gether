"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Clock,
  ClipboardList,
  LogOut,
  CalendarDays,
  CalendarOff,
  Loader2,
  AlertTriangle,
  Send,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { TaskCard } from "@/components/staff/task-card";
import { PushNotificationSetup } from "@/components/staff/push-notification-setup";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { fazerLogout, lerUtilizador } from "@/lib/auth";
import type { UtilizadorAuth } from "@/lib/auth";

/**
 * Interface para a tarefa real vinda da API.
 * Espelha o que o backend devolve em /api/auth/me/tarefas.
 */
interface TarefaReal {
  _id: string;
  propriedade_id?: { nome: string; morada?: string } | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
}

/**
 * Adapta a tarefa real da API para o formato que o TaskCard espera
 *
 */
function adaptarTarefa(t: TarefaReal) {
  return {
    id: t._id,
    propriedade_nome: t.propriedade_id?.nome ?? "Propriedade",
    hora_limite: "",
    tempo_estimado_minutos: t.tempo_limpeza_minutos,
    estado: t.estado as "por_atribuir" | "atribuida" | "em_curso" | "concluida" | "cancelada",
    tipo: t.tipo as "limpeza" | "check_in" | "check_out" | "manutencao" | "outro",
    endereco: t.propriedade_id?.morada,
  };
}

/**
 * Área do Staff (/staff) — mobile-first.
 * Cabeçalho "Bem-vindo, [Nome]" + lista de cartões de tarefas do dia.
 *
 * Dados reais: busca o nome do utilizador via /api/auth/me e as tarefas
 * de hoje via /api/auth/me/tarefas.
 */
export default function StaffPage() {
  const [user, setUser] = useState<UtilizadorAuth | null>(null);
  const [tarefas, setTarefas] = useState<TarefaReal[]>([]);
  const [loading, setLoading] = useState(true);

  // Estado da funcionalidade "Reportar Falta Hoje".
  const [faltaPendente, setFaltaPendente] = useState(false); // já reportou hoje?
  const [mostrarDialogFalta, setMostrarDialogFalta] = useState(false);
  const [justificacao, setJustificacao] = useState("");
  const [submetendoFalta, setSubmetendoFalta] = useState(false);
  const [erroFalta, setErroFalta] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const [userRes, tarefasRes, ausenciasRes] = await Promise.all([
        fetch("/api/auth/me", { credentials: "include", cache: "no-store" }),
        fetch("/api/auth/me/tarefas", { credentials: "include", cache: "no-store" }),
        fetch("/api/staff/ausencias", { credentials: "include", cache: "no-store" }),
      ]);

      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData?.utilizador) setUser(userData.utilizador);
      }

      if (tarefasRes.ok) {
        const data = await tarefasRes.json();
        setTarefas(data.tarefas ?? []);
      }

      // Verifica se já existe uma ausência pendente_emergencia para hoje.
      if (ausenciasRes.ok) {
        const ausData = await ausenciasRes.json();
        const hoje = new Date();
        const hojeUTC = new Date(
          Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
        );
        const temFaltaHoje = (ausData.ausencias ?? []).some((a: { estado: string; data_inicio: string; data_fim: string }) => {
          if (a.estado !== "pendente_emergencia") return false;
          const ini = new Date(a.data_inicio);
          const fim = new Date(a.data_fim);
          return hojeUTC >= ini && hojeUTC <= fim;
        });
        setFaltaPendente(temFaltaHoje);
      }
    } catch {
      // silencioso
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Submete a falta de emergência para o dia atual. */
  async function handleReportarFalta(e: React.FormEvent) {
    e.preventDefault();
    setErroFalta(null);
    setSubmetendoFalta(true);
    try {
      const res = await fetch("/api/staff/falta-hoje", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          justificacao: justificacao.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.erro || `Erro ${res.status}`);
      }
      // Sucesso: fecha dialog, mostra aviso amarelo.
      setMostrarDialogFalta(false);
      setJustificacao("");
      setFaltaPendente(true);
    } catch (e) {
      setErroFalta(e instanceof Error ? e.message : "Erro ao reportar falta.");
    } finally {
      setSubmetendoFalta(false);
    }
  }

  const nome = user?.nome ?? "Staff";
  const iniciais = nome
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const totalMinutos = tarefas.reduce(
    (acc, t) => acc + t.tempo_limpeza_minutos,
    0
  );

  const hoje = new Date().toLocaleDateString("pt-PT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // Filtra apenas tarefas não concluídas para a lista principal.
  const tarefasAtivas = tarefas.filter((t) => t.estado !== "concluida");
  const tarefasConcluidas = tarefas.filter((t) => t.estado === "concluida");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-muted/20">
      {/* Cabeçalho */}
      <header className="sticky top-0 z-10 border-b bg-background/95 px-5 pb-4 pt-6 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarFallback>{iniciais}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Bem-vindo,</span>
              <span className="text-lg font-semibold leading-tight">
                {nome}
              </span>
            </div>
          </div>
          {/* Botão logout */}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => fazerLogout()}
            aria-label="Terminar sessão"
            title="Terminar sessão"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>

        {/* Data + resumo */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm capitalize text-muted-foreground">{hoje}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <ClipboardList className="h-3.5 w-3.5" />
              {tarefas.length} tarefas
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {Math.floor(totalMinutos / 60)}h{String(totalMinutos % 60).padStart(2, "0")}
            </span>
          </div>
        </div>
      </header>

      {/* Lista de tarefas */}
      <main className="flex-1 space-y-4 p-5">
        {/* Banner de ativar notificações push */}
        <PushNotificationSetup />

        {/* Reportar Falta Hoje — botão ou aviso de já reportado */}
        {faltaPendente ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Falta reportada.</strong> Aguarda confirmação do Administrador.
            </span>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full justify-center gap-2 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setMostrarDialogFalta(true);
              setErroFalta(null);
            }}
          >
            <AlertTriangle className="h-4 w-4" />
            Reportar Falta Hoje
          </Button>
        )}

        {/* Botão Ver a minha Agenda */}
        <Link href="/staff/calendario" prefetch>
          <Button variant="outline" className="w-full justify-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Ver a minha Agenda
          </Button>
        </Link>

        {/* Botão Pedidos de Ausência */}
        <Link href="/staff/ausencias" prefetch>
          <Button variant="outline" className="w-full justify-center gap-2">
            <CalendarOff className="h-4 w-4" />
            Pedidos de Ausência
          </Button>
        </Link>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar tarefas…
          </div>
        ) : (
          <>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tarefas de hoje
            </h2>
            <div className="space-y-4">
              {tarefasAtivas.map((t) => (
                <TaskCard key={t._id} tarefa={adaptarTarefa(t)} />
              ))}
            </div>

            {tarefasConcluidas.length > 0 && (
              <>
                <h2 className="pt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Concluídas ({tarefasConcluidas.length})
                </h2>
                <div className="space-y-4 opacity-60">
                  {tarefasConcluidas.map((t) => (
                    <TaskCard key={t._id} tarefa={adaptarTarefa(t)} />
                  ))}
                </div>
              </>
            )}

            {tarefas.length === 0 && (
              <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
                <ClipboardList className="h-10 w-10 opacity-40" />
                <p className="text-sm">Sem tarefas atribuídas para hoje.</p>
              </div>
            )}
          </>
        )}
      </main>

      {/* Rodapé */}
      <footer className="border-t px-5 py-4 text-center text-xs text-muted-foreground">
        Autocell · Área do Staff
      </footer>

      {/* Dialog: Reportar Falta Hoje */}
      <Dialog open={mostrarDialogFalta} onOpenChange={setMostrarDialogFalta}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Reportar Falta Hoje
          </DialogTitle>
          <DialogDescription>
            Tem a certeza que não pode trabalhar hoje? O Administrador será
            notificado para redistribuir as suas tarefas.
          </DialogDescription>
          <DialogClose onClick={() => setMostrarDialogFalta(false)} />
        </DialogHeader>
        <form onSubmit={handleReportarFalta}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="justificacao" className="text-sm font-medium">
                Motivo / Justificação (opcional)
              </label>
              <textarea
                id="justificacao"
                value={justificacao}
                onChange={(e) => setJustificacao(e.target.value)}
                rows={3}
                placeholder="Ex.: Doença súbita, emergência familiar…"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {erroFalta && (
              <p className="text-sm text-destructive">{erroFalta}</p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMostrarDialogFalta(false)}
              disabled={submetendoFalta}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={submetendoFalta}
            >
              {submetendoFalta ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A enviar…
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Confirmar Falta
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
