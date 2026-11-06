"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clock,
  ClipboardList,
  LogOut,
  Loader2,
  AlertTriangle,
  Send,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { TaskCard } from "@/components/staff/task-card";
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
import { NotificationBell } from "@/components/notification-bell";
// Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
import { dataPorExtenso, parsearDataSegura } from "@/lib/utils";
import { mensagemErro } from "@/lib/rascunho-staff";

/**
 * Interface para a tarefa real vinda da API.
 * Espelha o que o backend devolve em /api/auth/me/tarefas.
 */
interface TarefaReal {
  _id: string;
  propriedade_id?: { nome: string; morada?: string; fornecedor_id?: string | null } | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
  tipo_limpeza?: string | null;
  // Prompt 136 — detalhes_reserva (para mostrar nome_hospede no cartão).
  detalhes_reserva?: {
    checkin?: string | null;
    checkout?: string | null;
    pax?: number | null;
    nome_hospede?: string | null;
  } | null;
  // Prompt 137 — tempo de viagem (para badge no cartão).
  tempo_viagem_minutos?: number | null;
  equipa_nomes?: Array<{ _id: string; nome: string; responsavel: boolean; eu?: boolean }> | null;
  iniciada_em?: string | null;
  inicio_origem?: "botao" | "automatico" | null;
  nao_consegui_comecar?: { motivo: string; nota?: string; em?: string } | null;
  roupa_entregue?: boolean;
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
    tipo_limpeza: t.tipo_limpeza ?? null,
    estado: t.estado as "por_atribuir" | "atribuida" | "em_curso" | "concluida" | "cancelada",
    tipo: t.tipo as "limpeza" | "check_in" | "check_out" | "manutencao" | "outro",
    endereco: t.propriedade_id?.morada,
    // v1.56.0 (Prompt 78) — data ISO real para extrair hora de início no TaskCard.
    data: t.data,
    // Prompt 136 — repassa detalhes_reserva para o TaskCard poder mostrar
    // o nome do hóspede na lista de tarefas do staff.
    detalhes_reserva: t.detalhes_reserva ?? null,
    // Prompt 137 — repassa tempo_viagem_minutos para o badge no cartão.
    tempo_viagem_minutos: t.tempo_viagem_minutos ?? null,
    equipa_nomes: t.equipa_nomes ?? null,
    iniciada_em: t.iniciada_em ?? null,
    inicio_origem: t.inicio_origem ?? null,
    nao_consegui_comecar: t.nao_consegui_comecar ?? null,
    tem_lavandaria: !!t.propriedade_id?.fornecedor_id,
    roupa_entregue: t.roupa_entregue === true,
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
  const [erroCarregar, setErroCarregar] = useState(false); // falha de rede/servidor (≠ lista vazia)

  // Estado da funcionalidade "Reportar Falta Hoje".
  const [faltaPendente, setFaltaPendente] = useState(false); // já reportou hoje?
  const [mostrarDialogFalta, setMostrarDialogFalta] = useState(false);
  const [justificacao, setJustificacao] = useState("");
  const [submetendoFalta, setSubmetendoFalta] = useState(false);
  const [erroFalta, setErroFalta] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      // Prompt 113 — Usa lerUtilizador() (com cache temporal) em vez de
      // fetch direto a /api/auth/me. Isto evita:
      //   (a) um 401 separado que dispara window.location.href (loop);
      //   (b) bypass do cache (cada carregar() batia no backend).
      // O RouteGuard do layout já validou a sessão antes de esta página
      // renderizar — se chegamos aqui, o user está autenticado. Se a
      // sessão expirou a meio, lerUtilizador() devolve null (cache 3s)
      // e simplesmente não atualizamos o user; o próximo carregar() ou
      // navegação irá revalidar.
      const userData = await lerUtilizador();
      if (userData) setUser(userData);

      setErroCarregar(false);
      const [tarefasRes, ausenciasRes] = await Promise.all([
        fetch("/api/auth/me/tarefas", { credentials: "include", cache: "no-store" }),
        fetch("/api/staff/ausencias", { credentials: "include", cache: "no-store" }),
      ]);

      if (tarefasRes.ok) {
        const data = await tarefasRes.json();
        setTarefas(data.tarefas ?? []);
      } else {
        // 401 é tratado pelo middleware/login; qualquer outra falha é mostrada.
        setErroCarregar(true);
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
          const ini = parsearDataSegura(a.data_inicio);
          const fim = parsearDataSegura(a.data_fim);
          if (!ini || !fim) return false;
          return hojeUTC >= ini && hojeUTC <= fim;
        });
        setFaltaPendente(temFaltaHoje);
      }
    } catch {
      setErroCarregar(true);
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
      setErroFalta(mensagemErro(e, "Erro ao reportar falta."));
    } finally {
      setSubmetendoFalta(false);
    }
  }

  const nome = user?.nome ?? "Equipa";
  const iniciais = nome
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();


  // Prompt 120 — Evitar mismatch de hidratação: a data formatada depende do
  // timezone do cliente. No SSR (servidor UTC) e no CSR (browser Lisboa) o
  // output pode diferir (especialmente perto da meia-noite). Só renderizamos
  // a data depois do mount (client-side).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Prompt 124 — Navegação de dias (1 dia de cada vez).
  // diaSelecionado é um offset em dias a partir de hoje (0 = hoje, -1 = ontem, 1 = amanhã).
  const [offsetDia, setOffsetDia] = useState(0);

  const hoje = mounted
    ? dataPorExtenso(new Date())
    : "";

  // Calcula a data do dia selecionado.
  const diaSelecionadoDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDia);
    return d;
  }, [offsetDia]);

  const diaSelecionadoStr = diaSelecionadoDate.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });

  // Label do dia selecionado: "Hoje" / "Ontem" / "Amanhã" / "15 de Outubro".
  const diaLabel = useMemo(() => {
    if (offsetDia === 0) return "Hoje";
    if (offsetDia === -1) return "Ontem";
    if (offsetDia === 1) return "Amanhã";
    return dataPorExtenso(diaSelecionadoDate);
  }, [offsetDia, diaSelecionadoDate]);

  // Filtra as tarefas do dia selecionado (ativas + concluídas).
  const tarefasDoDia = useMemo(() => {
    return tarefas.filter((t) => {
      const dia = (parsearDataSegura(t.data) ?? new Date()).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
      return dia === diaSelecionadoStr;
    });
  }, [tarefas, diaSelecionadoStr]);

  const tarefasAtivasDia = tarefasDoDia.filter((t) => t.estado !== "concluida");
  // Resumo do cabeçalho: só tarefas por fazer do dia selecionado.
  const totalMinutos = tarefasAtivasDia.reduce((acc, t) => acc + t.tempo_limpeza_minutos, 0);
  const tarefasConcluidasDia = tarefasDoDia.filter((t) => t.estado === "concluida");

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
          {/* Prompt 114 — Sino de Notificações + Botão logout */}
          <div className="flex items-center gap-1">
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 sm:h-9 sm:w-9 text-muted-foreground hover:text-destructive"
              onClick={() => fazerLogout()}
              aria-label="Terminar sessão"
              title="Terminar sessão"
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Data + resumo */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{hoje}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <ClipboardList className="h-3.5 w-3.5" />
              {tarefasAtivasDia.length} {tarefasAtivasDia.length === 1 ? "tarefa" : "tarefas"}
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
        {/* v1.66.0 (Prompt 89) — PushNotificationSetup movido para staff/layout.tsx
            para que apareça em TODAS as páginas do staff, não só no dashboard. */}

        {/* Reportar Falta Hoje — aviso se já reportada, senão ação discreta.
            (Agenda, Ausências e Avisos estão na barra de navegação inferior.) */}
        {faltaPendente ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Falta reportada.</strong> Aguarda confirmação do Gestor.
            </span>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="touch"
              className="gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setMostrarDialogFalta(true);
                setErroFalta(null);
              }}
            >
              <AlertTriangle className="h-4 w-4" />
              Reportar falta hoje
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            A carregar tarefas…
          </div>
        ) : (
          <>
            {/* Prompt 124 — Navegação de dias (1 dia de cada vez) */}
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="touch"
                onClick={() => setOffsetDia((d) => d - 1)}
                className="gap-1"
                title="Dia anterior"
              >
                <ChevronLeft className="h-4 w-4" />
                Anterior
              </Button>
              <div className="flex flex-col items-center">
                <span className={`text-sm font-bold ${offsetDia === 0 ? "text-gold-text" : "text-foreground"}`}>
                  {diaLabel}
                </span>
                {offsetDia !== 0 && (
                  <button
                    onClick={() => setOffsetDia(0)}
                    className="px-2 py-2 text-xs font-medium text-gold-text hover:underline"
                  >
                    Voltar a Hoje
                  </button>
                )}
              </div>
              <Button
                variant="outline"
                size="touch"
                onClick={() => setOffsetDia((d) => d + 1)}
                className="gap-1"
                title="Dia seguinte"
              >
                Seguinte
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Tarefas ativas do dia selecionado */}
            {tarefasAtivasDia.length > 0 && (
              <div className="space-y-4">
                {tarefasAtivasDia.map((t) => (
                  <TaskCard key={t._id} tarefa={adaptarTarefa(t)} onAtualizar={carregar} />
                ))}
              </div>
            )}

            {/* Tarefas concluídas do dia selecionado */}
            {tarefasConcluidasDia.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 pt-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Concluídas ({tarefasConcluidasDia.length})
                  </h2>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="space-y-4 opacity-60">
                  {tarefasConcluidasDia.map((t) => (
                    <TaskCard key={t._id} tarefa={adaptarTarefa(t)} />
                  ))}
                </div>
              </div>
            )}

            {/* Falha ao carregar — distinto de "sem tarefas" */}
            {erroCarregar && (
              <div
                role="alert"
                className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive"
              >
                <p>Não foi possível carregar as tuas tarefas. Verifica a ligação e tenta de novo.</p>
                <Button variant="outline" size="touch" onClick={() => { setLoading(true); carregar(); }}>
                  Tentar de novo
                </Button>
              </div>
            )}

            {/* Sem tarefas no dia selecionado */}
            {!erroCarregar && tarefasDoDia.length === 0 && (
              <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
                <ClipboardList className="h-10 w-10 opacity-40" />
                <p className="text-sm">Sem tarefas neste dia.</p>
              </div>
            )}
          </>
        )}
      </main>

      {/* Rodapé */}
      <footer className="border-t px-5 py-4 text-center text-xs text-muted-foreground">
        All2gether · Área do Staff
      </footer>

      {/* Dialog: Reportar Falta Hoje */}
      <Dialog open={mostrarDialogFalta} onOpenChange={setMostrarDialogFalta}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Reportar falta hoje
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
            <Button size="touch"
              type="button"
              variant="outline"
              onClick={() => setMostrarDialogFalta(false)}
              disabled={submetendoFalta}
            >
              Cancelar
            </Button>
            <Button size="touch"
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
                  Confirmar falta
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
