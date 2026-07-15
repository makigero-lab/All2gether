"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  Loader2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  MapPin,
  Clock,
  User,
  X,
  Sparkles,
  Table,
  Download,
  Plus,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
// Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
import { parsearDataSegura, formatarDataSegura, extrairHoraISO, calcularHoraFimISO } from "@/lib/utils";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import ptLocale from "@fullcalendar/core/locales/pt";
import type { DatesSetArg, EventClickArg, EventContentArg, EventInput } from "@fullcalendar/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, temHoraReal } from "@/lib/utils";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminGet, adminPost, adminPatch, type PropriedadeDTO, type UtilizadorDTO } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface TarefaCalendario {
  _id: string;
  propriedade_id: { _id: string; nome: string; morada?: string } | null;
  utilizador_id: { _id: string; nome: string } | null;
  data: string;
  tempo_limpeza_minutos: number;
  tipo: string;
  estado: string;
  observacoes?: string;
  // Prompt 99 — Detalhes da reserva (para a coluna Reserva da Vista Tabela).
  detalhes_reserva?: {
    checkin?: string | null;
    checkout?: string | null;
    pax?: number | null;
    nome_hospede?: string | null;
  } | null;
  // Prompt 137 — Tempo de viagem (para criar bloco de viagem no calendário).
  tempo_viagem_minutos?: number | null;
  // v1.57.0 (Prompt 79) — Campos extras para eventos de ausência (FullCalendar allDay multi-dia).
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
}

interface FiltrosState {
  propriedadeId: string;
  utilizadorId: string;
  estado: string;
}

interface PeriodoState {
  inicio: string;
  fim: string;
}

const ESTADO_OPTS = [
  { value: "", label: "Todos os estados" },
  { value: "por_atribuir", label: "Por atribuir" },
  { value: "atribuida", label: "Atribuída" },
  { value: "em_curso", label: "Em curso" },
  { value: "concluida", label: "Concluída" },
  { value: "cancelada", label: "Cancelada" },
];

const TIPO_LABEL: Record<string, string> = {
  limpeza: "Limpeza",
  manutencao: "Manutenção",
  folga_fixa: "Folga Semanal",
  check_in: "Check-in",
  check_out: "Check-out",
  ausencia: "Ausência",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Paleta pastel por estado da tarefa (Prompt 74, ponto 5).
 * Retorna fundo suave + borda + texto escuro para não cansar a vista.
 */
interface PaletaEvento {
  bg: string;
  border: string;
  text: string;
  dot: string; // cor da bolinha (saturada, para destaque)
}

function paletaPorEstado(estado: string): PaletaEvento {
  switch (estado) {
    case "concluida":
      // Verde suave
      return { bg: "#dcfce7", border: "#86efac", text: "#166534", dot: "#22c55e" };
    case "atribuida":
    case "em_curso":
      // Amarelo suave (pendente/em curso)
      return { bg: "#fef9c3", border: "#fde047", text: "#854d0e", dot: "#eab308" };
    case "por_atribuir":
      // Vermelho suave
      return { bg: "#fee2e2", border: "#fca5a5", text: "#991b1b", dot: "#ef4444" };
    case "nao_atribuida":
      // Prompt 138 (136 V2) — vermelho escuro (SLA excedido, mais urgente).
      return { bg: "#fecaca", border: "#f87171", text: "#7f1d1d", dot: "#dc2626" };
    case "cancelada":
      // Cinza suave
      return { bg: "#f1f5f9", border: "#cbd5e1", text: "#475569", dot: "#94a3b8" };
    default:
      return { bg: "#f1f5f9", border: "#cbd5e1", text: "#475569", dot: "#94a3b8" };
  }
}

/** Emoji por tipo de tarefa (Prompt 74, ponto 4). */
function emojiPorTipo(tipo: string): string {
  switch (tipo) {
    case "manutencao":
      return "🛠️";
    case "limpeza":
      return "🧹";
    case "check_in":
      return "🔑";
    case "check_out":
      return "🚪";
    case "folga_fixa":
      return "🏖️";
    default:
      return "🧹";
  }
}

/** Cor de fundo/borda do evento do FullCalendar por estado da tarefa. */
function corPorEstado(estado: string): string {
  return paletaPorEstado(estado).dot;
}

function primeiroNome(nome: string | undefined): string {
  if (!nome) return "";
  return nome.split(" ")[0];
}

/** Devolve a hora "HH:mm" se a tarefa tiver hora real de trabalho; senão "—". */
function horaTarefa(dataISO: string): string {
  if (!dataISO || !dataISO.includes("T")) return "—";
  // Prompt 113 — Tarefas sem hora real (meia-noite local / UTC midnight antigo)
  // não mostram hora, só a data.
  if (!temHoraReal(dataISO)) return "—";
  // Prompt 127 — Extrai a hora diretamente da string ISO sem converter fuso.
  return extrairHoraISO(dataISO);
}

/** Calcula a hora de fim estimada (início + tempo_limpeza_minutos). */
function horaFimTarefa(dataISO: string, minutos: number): string {
  if (!dataISO || !dataISO.includes("T")) return "—";
  if (!temHoraReal(dataISO)) return "—";
  // Prompt 127 — Calcula a hora de fim sem converter fuso.
  return calcularHoraFimISO(dataISO, minutos || 0);
}

/* ------------------------------------------------------------------ */
/* Helpers da Vista Tabela (Prompt 99)                                 */
/* ------------------------------------------------------------------ */

const ESTADO_LABEL_TAB: Record<string, string> = {
  por_atribuir: "Por Atribuir",
  atribuida: "Atribuída",
  em_curso: "Em Curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  // Prompt 138 (136 V2) — SLA excedido.
  nao_atribuida: "Não Atribuída (SLA)",
};

const ESTADO_VARIANT_TAB: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  por_atribuir: "destructive",
  atribuida: "default",
  em_curso: "warning",
  concluida: "success",
  cancelada: "outline",
  // Prompt 138 (136 V2) — vermelho (mais urgente que por_atribuir).
  nao_atribuida: "destructive",
};

/**
 * Formata uma data ISO (ou YYYY-MM-DD) para DD/MM/YYYY.
 * Extrai diretamente os componentes da string para evitar problemas de
 * timezone (parseISO interpreta YYYY-MM-DD como meia-noite UTC, que em
 * Portugal UTC+1 aparece como 01:00 do dia anterior ou da mesma data).
 */
function formatarDataDMY(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const dataStr = iso.slice(0, 10); // YYYY-MM-DD
    const [ano, mes, dia] = dataStr.split("-");
    if (!ano || !mes || !dia) return iso;
    return `${dia}/${mes}/${ano}`;
  } catch {
    return iso;
  }
}

/**
 * Formata uma data/hora ISO para DD/MM/YYYY HH:mm (para checkin/checkout).
 * A parte da data é extraída diretamente da string (sem timezone); a parte
 * da hora usa parseISO apenas se houver componente de tempo.
 */
function formatarDataHoraCurta(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const dataStr = iso.slice(0, 10);
    const [ano, mes, dia] = dataStr.split("-");
    if (!ano || !mes || !dia) return iso;
    const dataFmt = `${dia}/${mes}/${ano}`;
    // Se for só data (YYYY-MM-DD), devolve só a data.
    if (iso.length <= 10) return dataFmt;
    // Se tem tempo, extrai HH:mm diretamente (sem conversão de timezone).
    const tempoParte = iso.slice(11, 16); // HH:mm
    return `${dataFmt} ${tempoParte}`;
  } catch {
    return iso;
  }
}

/**
 * Constrói a string de Reserva: "In: [checkin] Out: [checkout] - [pax] pax".
 * Se não houver detalhes_reserva, usa a data da tarefa como check-in
 * (fallback para tarefas criadas antes do Prompt 93).
 */
function formatarReserva(
  detalhes?: TarefaCalendario["detalhes_reserva"],
  dataTarefa?: string
): string {
  if (!detalhes) {
    // Tarefas antigas sem detalhes_reserva — mostra pelo menos o check-in
    // (data da tarefa = dia do check-in).
    if (dataTarefa) {
      return `In: ${formatarDataDMY(dataTarefa)} Out: — - —`;
    }
    return "—";
  }
  const checkin = detalhes.checkin
    ? formatarDataHoraCurta(detalhes.checkin)
    : dataTarefa
    ? formatarDataDMY(dataTarefa)
    : "—";
  const checkout = detalhes.checkout ? formatarDataHoraCurta(detalhes.checkout) : "—";
  const pax = detalhes.pax != null ? `${detalhes.pax} pax` : "—";
  return `In: ${checkin} Out: ${checkout} - ${pax}`;
}

/**
 * Prompt 100 — Variante para Excel: devolve string VAZIA quando não há
 * detalhes_reserva (ex: tarefa de manutenção), para a célula ficar em
 * branco no Excel. Os sub-campos em falta também ficam vazios (não "—").
 */
function formatarReservaExcel(detalhes?: TarefaCalendario["detalhes_reserva"]): string {
  if (!detalhes) return "";
  const checkin = detalhes.checkin ? formatarDataHoraCurta(detalhes.checkin) : "";
  const checkout = detalhes.checkout ? formatarDataHoraCurta(detalhes.checkout) : "";
  const pax = detalhes.pax != null ? `${detalhes.pax} pax` : "";
  // Se não houver nenhum campo preenchido, devolve vazio (não "In:  Out:  - ").
  if (!checkin && !checkout && !pax) return "";
  return `In: ${checkin} Out: ${checkout} - ${pax}`;
}

/** Horário da tarefa: "HH:mm - HH:mm" (ou "—" se sem hora). */
function formatarHorario(t: TarefaCalendario): string {
  const inicio = horaTarefa(t.data);
  if (inicio === "—") return "—";
  const fim = horaFimTarefa(t.data, t.tempo_limpeza_minutos);
  return `${inicio} - ${fim}`;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function CalendarioOperacionalPage() {
  const [filtros, setFiltros] = useState<FiltrosState>({
    propriedadeId: "",
    utilizadorId: "",
    estado: "",
  });

  const [tarefas, setTarefas] = useState<TarefaCalendario[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [equipa, setEquipa] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  // Prompt 114 — Toast de warning (ex.: distância entre tarefas do mesmo dia).
  const [warningToast, setWarningToast] = useState<string | null>(null);
  // Prompt 135 — Conflito de horário (soft block): modal de confirmação.
  const [conflitoModal, setConflitoModal] = useState<{ warning: string; tarefaCriada?: TarefaCalendario } | null>(null);
  const [conflitoForcar, setConflitoForcar] = useState(false);

  // SSR-safe mount: FullCalendar só pode ser renderizado no cliente.
  const [mounted, setMounted] = useState(false);

  // Período atual do calendário (definido via datesSet do FullCalendar).
  const [periodo, setPeriodo] = useState<PeriodoState | null>(null);

  // Prompt 99 — Toggle de vistas: "calendario" (FullCalendar) | "tabela" (Data Table).
  const [vista, setVista] = useState<"calendario" | "tabela">("calendario");
  const [exportando, setExportando] = useState(false);

  // Modal de detalhe.
  const [tarefaSelecionada, setTarefaSelecionada] = useState<TarefaCalendario | null>(null);
  const [reatribuindoPara, setReatribuindoPara] = useState<string>("");
  const [reatribuindo, setReatribuindo] = useState(false);

  // v1.59.0 (Prompt 81) — Staff indisponíveis (férias/doença) no dia da tarefa selecionada.
  const [indisponiveis, setIndisponiveis] = useState<Array<{
    utilizador_id: string;
    tipo: string;
    data_inicio: string;
    data_fim: string;
  }>>([]);

  /* --- Marca montação no cliente (inibe o SSR do FullCalendar) --- */
  useEffect(() => {
    setMounted(true);
  }, []);

  /* --- Carregar propriedades + equipa (uma vez) --- */
  const carregarFiltros = useCallback(async () => {
    try {
      const [propRes, equipaRes] = await Promise.all([
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/gestor/propriedades"),
        adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
      ]);
      setPropriedades((propRes.propriedades ?? []).filter((p) => p.ativo));
      setEquipa(
        // Prompt 105 — Só staff pode receber limpezas.
        // Prompt 114 — Só staff ATIVO (não inativos/desativados).
        (equipaRes.utilizadores ?? []).filter(
          (u) => u.role === "staff" && u.ativo === true
        )
      );
    } catch (e) {
      // Não bloqueia o calendário se os filtros falharem.
      console.error("Erro ao carregar filtros:", e);
    }
  }, []);

  useEffect(() => {
    carregarFiltros();
  }, [carregarFiltros]);

  /* --- Carregar tarefas do período + filtros (lógica original — NÃO MUDAR) --- */
  const carregarTarefas = useCallback(async () => {
    if (!periodo) return;
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim });
      if (filtros.propriedadeId) params.set("propriedadeId", filtros.propriedadeId);
      if (filtros.utilizadorId) params.set("utilizadorId", filtros.utilizadorId);
      if (filtros.estado) params.set("estado", filtros.estado);

      const res = await adminGet<{ tarefas: TarefaCalendario[] }>(
        `/api/gestor/calendario/dados?${params.toString()}`
      );
      setTarefas(res.tarefas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar calendário.");
    } finally {
      setLoading(false);
    }
  }, [periodo, filtros]);

  // Recarrega quando o período (definido pelo FullCalendar) ou os filtros mudam.
  useEffect(() => {
    if (periodo) carregarTarefas();
  }, [carregarTarefas, periodo]);

  /* --- Mapear tarefas → eventos do FullCalendar --- */
  // Prompt 137 — Se a tarefa tem tempo_viagem_minutos > 0, cria DOIS eventos:
  //   Evento A (Viagem): cinzento/tracejado, início = hora_tarefa - viagem, fim = hora_tarefa.
  //   Evento B (Limpeza): a tarefa normal com a cor da propriedade/estado.
  const eventos = useMemo<EventInput[]>(() => {
    return tarefas.flatMap((t) => {
      // Ausência aprovada (férias/doença) — banner horizontal contínuo
      // cinzento/roxo pastel atravessando os dias (Prompt 80, ponto 2).
      if (t.tipo === "ausencia") {
        // O backend já envia start/end/allDay/title. Usamos esses campos
        // e aplicamos uma classe CSS para o estilo de banner.
        return [{
          id: t._id,
          title: t.title ?? `Ausência: ${t.utilizador_id?.nome ?? "Staff"}`,
          start: t.start ?? t.data,
          end: t.end,
          allDay: true,
          // Roxo pastel suave com opacidade — distinto de tarefas normais.
          backgroundColor: "#ede9fe",
          borderColor: "#c4b5fd",
          textColor: "#5b21b6",
          extendedProps: t,
          // Flag custom para o eventContent aplicar a classe de banner.
          classNames: ["fc-evt-ausencia"],
        } as EventInput];
      }

      // Folga fixa semanal — bloco cinzento claro, todo o dia.
      if (t.tipo === "folga_fixa") {
        return [{
          id: t._id,
          title: `Folga - ${t.utilizador_id?.nome ?? "Staff"}`,
          start: t.data,
          allDay: true,
          backgroundColor: "#e2e8f0",
          borderColor: "#cbd5e1",
          textColor: "#475569",
          extendedProps: t,
        } as EventInput];
      }

      // Prompt 129 — Extrai a hora diretamente da string ISO sem converter fuso.
      // O FullCalendar com timeZone: "local" aplica o offset do browser aos
      // ISO strings com Z. Para evitar o time shift (11:00 → 12:00), usamos
      // extrairHoraISO que faz parse manual da string. Depois construímos
      // uma string LOCAL (sem Z) para o FullCalendar não converter.
      const inicio = parsearDataSegura(t.data) ?? new Date();
      const semHoraReal = !temHoraReal(t.data);
      const paleta = paletaPorEstado(t.estado);
      const classNames =
        t.estado === "por_atribuir" || t.estado === "nao_atribuida"
          ? ["fc-evt-por-atribuir"]
          : [];

      if (semHoraReal) {
        // Evento all-day: só precisa da data (YYYY-MM-DD).
        return [{
          id: t._id,
          title: t.propriedade_id?.nome ?? "—",
          start: inicio.toISOString().slice(0, 10),
          allDay: true,
          backgroundColor: paleta.bg,
          borderColor: paleta.border,
          textColor: paleta.text,
          extendedProps: t,
          classNames,
        } as EventInput];
      }

      // Prompt 129 — Constrói a data/hora como string LOCAL (sem Z) para o
      // FullCalendar não aplicar offset. extrairHoraISO devolve "HH:mm" do
      // ISO sem conversão de fuso. Combinamos com a data YYYY-MM-DD.
      const dataStr = t.data.slice(0, 10); // YYYY-MM-DD do ISO
      const horaInicio = extrairHoraISO(t.data); // "HH:mm" sem conversão
      const [hIni, mIni] = horaInicio !== "—" ? horaInicio.split(":").map(Number) : [0, 0];

      // Calcula a hora de fim (início + tempo_limpeza) matematicamente.
      const tempoMin = t.tempo_limpeza_minutos || 45;
      let totalFim = hIni * 60 + mIni + tempoMin;
      totalFim = totalFim % (24 * 60);
      const hFim = Math.floor(totalFim / 60);
      const mFim = totalFim % 60;

      // Strings LOCAIS (sem Z) — o FullCalendar não converte fuso.
      const startLocal = `${dataStr}T${String(hIni).padStart(2, "0")}:${String(mIni).padStart(2, "0")}:00`;
      const endLocal = `${dataStr}T${String(hFim).padStart(2, "0")}:${String(mFim).padStart(2, "0")}:00`;

      // Prompt 135 — Se a tarefa tem um warning de conflito (criada em sobreposição),
      // usa borda âmbar para alertar visualmente.
      const temConflito = !!(t as TarefaCalendario & { _conflito?: boolean })._conflito;

      // Evento B (A Limpeza) — a tarefa normal.
      const eventoLimpeza: EventInput = {
        id: t._id,
        title: t.propriedade_id?.nome ?? "—",
        start: startLocal,
        end: endLocal,
        backgroundColor: temConflito ? "#fef3c7" : paleta.bg,
        borderColor: temConflito ? "#f59e0b" : paleta.border,
        textColor: temConflito ? "#92400e" : paleta.text,
        extendedProps: t,
        classNames: temConflito ? [...classNames, "fc-evt-conflito"] : classNames,
      };

      // Prompt 137 — Evento A (A Viagem): só cria se tempo_viagem_minutos > 0.
      // O bloco de viagem aparece ANTES da tarefa (início = hora_tarefa - viagem,
      // fim = hora_tarefa). Cor cinzenta + borda tracejada para distinguir da
      // tarefa real.
      const tempoViagem = Number(t.tempo_viagem_minutos) || 0;
      const eventos: EventInput[] = [eventoLimpeza];

      if (tempoViagem > 0) {
        // Calcula o início da viagem (hora_tarefa - tempo_viagem) matematicamente.
        let totalViagemInicio = hIni * 60 + mIni - tempoViagem;
        // Se a viagem começar antes da meia-noite, clampar a 00:00 (não
        // suportamos viagens que cruzam a meia-noite no calendário).
        if (totalViagemInicio < 0) totalViagemInicio = 0;
        const hViagem = Math.floor(totalViagemInicio / 60);
        const mViagem = totalViagemInicio % 60;
        const startViagemLocal = `${dataStr}T${String(hViagem).padStart(2, "0")}:${String(mViagem).padStart(2, "0")}:00`;

        const eventoViagem: EventInput = {
          // ID único com sufixo "-viagem" para não colidir com o evento da limpeza.
          id: `${t._id}-viagem`,
          title: `🚗 Viagem (${tempoViagem}m)`,
          start: startViagemLocal,
          end: startLocal,
          // Cinzento suave + borda tracejada (classe CSS fc-evt-viagem).
          backgroundColor: "#f1f5f9",
          borderColor: "#94a3b8",
          textColor: "#475569",
          extendedProps: { ...t, _isViagem: true },
          classNames: ["fc-evt-viagem"],
        };
        // A viagem aparece ANTES da limpeza no calendário.
        eventos.unshift(eventoViagem);
      }

      return eventos;
    });
  }, [tarefas]);

  /* --- Renderização customizada do bloco de evento (Prompt 74, ponto 4) --- */
  /* --- Prompt 80: destaque por_atribuir + banner ausência --- */
  /* --- Prompt 137: bloco de viagem (cinzento + tracejado) --- */
  const renderEventContent = useCallback((arg: EventContentArg) => {
    const t = arg.event.extendedProps as TarefaCalendario & { _isViagem?: boolean };
    const isMonthView = arg.view.type === "dayGridMonth";
    const paleta = paletaPorEstado(t.estado);
    const emoji = emojiPorTipo(t.tipo);
    const titulo = t.propriedade_id?.nome ?? "—";
    const staff = t.utilizador_id?.nome ?? null;
    const isFolga = t.tipo === "folga_fixa";
    const isAusencia = t.tipo === "ausencia";
    const isPorAtribuir = t.estado === "por_atribuir";
    const isViagem = !!t._isViagem;

    // --- Bloco de Viagem (Prompt 137) — cinzento + tracejado + ícone 🚗 ---
    if (isViagem) {
      const tituloViagem = arg.event.title ?? "🚗 Viagem";
      if (isMonthView) {
        return (
          <div className="fc-evt-month fc-evt-month--viagem" title={tituloViagem}>
            <span className="fc-evt-month__title">{tituloViagem}</span>
          </div>
        );
      }
      return (
        <div className="fc-evt-block fc-evt-block--viagem" title={tituloViagem}>
          <div className="fc-evt-block__header">
            <span className="fc-evt-block__emoji" aria-hidden>🚗</span>
            <span className="fc-evt-block__time">{arg.timeText}</span>
          </div>
          <div className="fc-evt-block__title">{tituloViagem}</div>
          {staff && (
            <div className="fc-evt-block__subtitle">
              <User className="fc-evt-block__icon" />
              <span>{primeiroNome(staff)}</span>
            </div>
          )}
        </div>
      );
    }

    // --- Ausência: banner contínuo (não tem propriedade, só staff) ---
    // Renderiza um conteúdo minimalista — o título já vem do backend
    // ("🌴 Férias: Nome"). Não mostra hora nem bolinha.
    if (isAusencia) {
      const bannerTitle = t.title ?? `Ausência: ${staff ?? "Staff"}`;
      return (
        <div className="fc-evt-ausencia__content" title={bannerTitle}>
          <span className="fc-evt-ausencia__title">{bannerTitle}</span>
        </div>
      );
    }

    // --- Vista mensal: layout compacto em linha ---
    if (isMonthView) {
      // Prompt 80, ponto 1 — destaque forte para por_atribuir na vista mensal.
      if (isPorAtribuir) {
        return (
          <div className="fc-evt-month fc-evt-month--alert" title={`⚠️ Por atribuir — ${titulo}`}>
            <span className="fc-evt-month__alert-icon" aria-hidden>⚠️</span>
            <span className="fc-evt-month__title">
              {emoji} {titulo}
            </span>
            <span className="fc-evt-month__alert-tag">Por Atribuir</span>
          </div>
        );
      }
      return (
        <div className="fc-evt-month">
          <span
            className="fc-evt-month__dot"
            style={{ backgroundColor: isFolga ? "#94a3b8" : paleta.dot }}
            aria-hidden
          />
          <span className="fc-evt-month__time">{arg.timeText}</span>
          <span className="fc-evt-month__title" title={titulo}>
            {emoji} {titulo}
          </span>
        </div>
      );
    }

    // --- Vistas semanal/diária: bloco rico com título + subtítulo ---
    return (
      <div className={isPorAtribuir ? "fc-evt-block fc-evt-block--alert" : "fc-evt-block"}>
        <div className="fc-evt-block__header">
          <span
            className="fc-evt-block__dot"
            style={{ backgroundColor: isFolga ? "#94a3b8" : paleta.dot }}
            aria-hidden
          />
          <span className="fc-evt-block__emoji" aria-hidden>
            {emoji}
          </span>
          <span className="fc-evt-block__time">{arg.timeText}</span>
        </div>
        <div className="fc-evt-block__title" title={titulo}>
          {titulo}
        </div>
        <div className="fc-evt-block__subtitle">
          {staff ? (
            <>
              <User className="fc-evt-block__icon" />
              <span>{primeiroNome(staff)}</span>
            </>
          ) : (
            <span className="fc-evt-block__unassigned">⚠️ Por Atribuir</span>
          )}
        </div>
      </div>
    );
  }, []);

  /* --- Callbacks do FullCalendar --- */
  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setPeriodo({
      inicio: format(arg.start, "yyyy-MM-dd"),
      fim: format(arg.end, "yyyy-MM-dd"),
    });
  }, []);

  const handleEventClick = useCallback((arg: EventClickArg) => {
    const tarefa = arg.event.extendedProps as TarefaCalendario;
    setTarefaSelecionada(tarefa);
    setReatribuindoPara(tarefa.utilizador_id?._id ?? "");
  }, []);

  /* --- v1.59.0 (Prompt 81): busca staff indisponíveis para o dia da tarefa --- */
  useEffect(() => {
    if (!tarefaSelecionada) {
      setIndisponiveis([]);
      return;
    }
    let cancelado = false;
    (async () => {
      try {
        // Extrai YYYY-MM-DD da data da tarefa.
        const dia = tarefaSelecionada.data?.slice(0, 10);
        if (!dia) {
          setIndisponiveis([]);
          return;
        }
        const res = await adminGet<{ indisponiveis: typeof indisponiveis }>(
          `/api/gestor/tarefas/indisponiveis?data=${dia}`
        );
        if (!cancelado) {
          setIndisponiveis(res.indisponiveis ?? []);
        }
      } catch {
        if (!cancelado) setIndisponiveis([]);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [tarefaSelecionada]);

  /* --- Reatribuição Inteligente (Prompt 75) --- */
  // Chama PATCH /api/gestor/tarefas/:id/reatribuir, que recalcula a hora de
  // início via scheduler sequencial (Haversine + almoço 13h-14h) no backend.
  async function handleReatribuir() {
    if (!tarefaSelecionada || !reatribuindoPara) return;
    setReatribuindo(true);
    try {
      // Prompt 114 — Captura warning de distância.
      const res = await adminPatch<{
        tarefa: TarefaCalendario;
        novo_inicio: string;
        origem: string;
        tempo_viagem: number;
        warning?: string;
      }>(`/api/gestor/tarefas/${tarefaSelecionada._id}/reatribuir`, {
        utilizador_id: reatribuindoPara,
      });
      if (res.warning) setWarningToast(res.warning);

      // Atualiza localmente a tarefa no estado com a data recalculada.
      const novoStaff = equipa.find((u) => u._id === reatribuindoPara);
      setTarefas((prev) =>
        prev.map((t) =>
          t._id === tarefaSelecionada._id
            ? {
                ...t,
                // O backend devolve a tarefa atualizada; usamos essa versão
                // para garantir consistência (data + utilizador + estado).
                ...(res?.tarefa ?? {}),
                utilizador_id: novoStaff
                  ? { _id: novoStaff._id, nome: novoStaff.nome }
                  : null,
                estado: "atribuida",
              }
            : t
        )
      );
      setTarefaSelecionada(null);
      setReatribuindoPara("");
    } catch (e) {
      // O backend pode devolver 400 (folga) ou 409 (capacidade excedida).
      // O helper adminPatch lança Error com a mensagem do corpo.
      setErro(e instanceof Error ? e.message : "Erro ao reatribuir tarefa.");
    } finally {
      setReatribuindo(false);
    }
  }

  /* --- v1.64.0 (Prompt 87): Auto-Atribuição em lote --- */
  const [autoAtribuindo, setAutoAtribuindo] = useState(false);
  const [confirmarAutoAtribuir, setConfirmarAutoAtribuir] = useState(false);
  const [autoAtribuirResultado, setAutoAtribuirResultado] = useState<string | null>(null);

  async function handleAutoAtribuir() {
    setAutoAtribuindo(true);
    setConfirmarAutoAtribuir(false);
    setErro(null);
    setAutoAtribuirResultado(null);
    try {
      const res = await adminPost<{
        sucesso: boolean;
        processadas: number;
        reatribuidas: number;
        orfas: number;
        mensagem?: string;
      }>("/api/gestor/tarefas/auto-atribuir", {});

      const msg =
        res.processadas === 0
          ? res.mensagem ?? "Não há tarefas por atribuir a partir de hoje."
          : `Foram reatribuídas ${res.reatribuidas} tarefa(s). ` +
            (res.orfas > 0
              ? `${res.orfas} continuam órfãs (sem staff disponível).`
              : "Nenhuma ficou órfã. ✅");
      setAutoAtribuirResultado(msg);

      // Atualiza o calendário para mostrar os blocos a mudarem de vermelho para as cores dos funcionários.
      await carregarTarefas();
    } catch (e) {
      setErro(
        e instanceof Error
          ? `Auto-atribuição falhou: ${e.message}`
          : "Erro ao auto-atribuir tarefas."
      );
    } finally {
      setAutoAtribuindo(false);
    }
  }

  /* --- Prompt 113 — Nova Tarefa Manual (a partir do calendário) --- */
  const [mostrarNovaTarefa, setMostrarNovaTarefa] = useState(false);
  const [novaTarefaLoading, setNovaTarefaLoading] = useState(false);
  const [novaTarefaErro, setNovaTarefaErro] = useState<string | null>(null);
  // Prompt 117 — adicionados hora, check_in, check_out, hospedes.
  const [novaForm, setNovaForm] = useState({
    propriedade_id: "",
    utilizador_id: "",
    data: "",
    hora: "",
    check_in: "",
    check_out: "",
    hospedes: "",
    nome_hospede: "",
    tempo_limpeza_minutos: "45",
    tipo: "limpeza",
  });

  async function handleCriarTarefa(e: React.FormEvent) {
    e.preventDefault();
    setNovaTarefaErro(null);
    if (!novaForm.propriedade_id || !novaForm.data) {
      setNovaTarefaErro("Propriedade e Data são obrigatórias.");
      return;
    }
    setNovaTarefaLoading(true);
    try {
      // Prompt 114 — Captura warning de distância (Haversine > 15km).
      // Prompt 117 — envia hora, check_in, check_out, hospedes. A combinação
      // data + hora é tratada pelo backend como LOCAL (não UTC midnight).
      const res = await adminPost<{ tarefa: TarefaCalendario; warning?: string }>(
        "/api/gestor/tarefas",
        {
          propriedade_id: novaForm.propriedade_id,
          utilizador_id: novaForm.utilizador_id || null,
          data: novaForm.data,
          hora: novaForm.hora || undefined,
          check_in: novaForm.check_in || undefined,
          check_out: novaForm.check_out || undefined,
          hospedes: novaForm.hospedes ? Number(novaForm.hospedes) : undefined,
          nome_hospede: novaForm.nome_hospede || undefined,
          tempo_limpeza_minutos: Number(novaForm.tempo_limpeza_minutos) || 45,
          tipo: novaForm.tipo,
        }
      );
      if (res.warning) {
        const temConflito = res.warning.toLowerCase().includes("horário");
        if (temConflito && !conflitoForcar) {
          // 1º clique com conflito: abre modal de confirmação.
          // A tarefa JÁ FOI CRIADA pelo backend (soft block). Mostramos o
          // modal para o gestor confirmar que quer manter a tarefa duplicada.
          setConflitoModal({
            warning: res.warning,
            tarefaCriada: res.tarefa,
          });
          setNovaForm({
            propriedade_id: "",
            utilizador_id: "",
            data: "",
            hora: "",
            check_in: "",
            check_out: "",
            hospedes: "",
            nome_hospede: "",
            tempo_limpeza_minutos: "45",
            tipo: "limpeza",
          });
          setMostrarNovaTarefa(false);
          await carregarTarefas();
          setNovaTarefaLoading(false);
          return;
        }
        // 2º clique (conflitoForcar=true) ou warning de distância: mostra toast.
        setWarningToast(res.warning);
      }
      setConflitoForcar(false);
      setNovaForm({
        propriedade_id: "",
        utilizador_id: "",
        data: "",
        hora: "",
        check_in: "",
        check_out: "",
        hospedes: "",
        nome_hospede: "",
        tempo_limpeza_minutos: "45",
        tipo: "limpeza",
      });
      setMostrarNovaTarefa(false);
      await carregarTarefas();
    } catch (e) {
      setNovaTarefaErro(e instanceof Error ? e.message : "Erro ao criar tarefa.");
    } finally {
      setNovaTarefaLoading(false);
    }
  }

  /* --- Prompt 99/106 — Tarefas para a Vista Tabela --- */
  // Filtra só tarefas reais (exclui eventos de ausência/folga) e aplica
  // a regra das -2h: só mostra tarefas cuja hora de FIM seja posterior a
  // (agora - 2h). Tarefas que terminaram há mais de 2h são escondidas.
  const tarefasTabela = useMemo<TarefaCalendario[]>(() => {
    // Prompt 106 — now - 2h: limite operacional.
    const agora = new Date();
    const limiteOperacional = new Date(agora.getTime() - 2 * 60 * 60 * 1000).getTime();

    return tarefas
      .filter((t) => {
        if (t.tipo === "ausencia" || t.tipo === "folga_fixa") return false;

        // Calcula a hora de fim da tarefa (início + tempo_limpeza_minutos).
        const inicio = (parsearDataSegura(t.data) ?? new Date(0)).getTime();
        const fim = inicio + (t.tempo_limpeza_minutos || 45) * 60000;

        // Mostra se a hora de FIM for posterior a (now - 2h).
        // Tarefas que ainda estão a decorrer ou que terminaram há menos de
        // 2h continuam visíveis. As mais antigas são escondidas.
        return fim >= limiteOperacional;
      })
      .slice()
      .sort((a, b) => {
        try {
          return (parsearDataSegura(a.data)?.getTime() ?? 0) - (parsearDataSegura(b.data)?.getTime() ?? 0);
        } catch {
          return 0;
        }
      });
  }, [tarefas]);

  /* --- Prompt 99/100 — Exportar para Excel (xlsx) --- */
  const exportarExcel = useCallback(async () => {
    setExportando(true);
    try {
      // Import dinâmico para não carregar a lib no bundle inicial (e evitar
      // problemas de SSR do xlsx).
      const XLSX = await import("xlsx");

      // Prompt 103 — Busca TODAS as tarefas do período (incluindo canceladas)
      // para o Excel ter histórico completo. O calendário visual exclui
      // canceladas, mas o Excel deve incluí-las.
      if (!periodo) return;
      const params = new URLSearchParams({
        inicio: periodo.inicio,
        fim: periodo.fim,
        incluir_canceladas: "true",
      });
      if (filtros.propriedadeId) params.set("propriedadeId", filtros.propriedadeId);
      if (filtros.utilizadorId) params.set("utilizadorId", filtros.utilizadorId);

      const res = await adminGet<{ tarefas: TarefaCalendario[] }>(
        `/api/gestor/calendario/dados?${params.toString()}`
      );
      const todasTarefas = (res.tarefas ?? [])
        .filter((t) => t.tipo !== "ausencia" && t.tipo !== "folga_fixa")
        .slice()
        .sort((a, b) => {
          try {
            return (parsearDataSegura(a.data)?.getTime() ?? 0) - (parsearDataSegura(b.data)?.getTime() ?? 0);
          } catch {
            return 0;
          }
        });

      // Constrói as linhas com os dados, formatados como texto/data.
      // Prompt 100: células de Reserva em branco (não "—") quando não há
      // detalhes_reserva; estados traduzidos para PT (Em Curso, Por Atribuir…).
      // Prompt 103: inclui canceladas com "Cancelada" no Estado.
      const linhas = todasTarefas.map((t) => ({
        Data: formatarDataDMY(t.data),
        Propriedade: t.propriedade_id?.nome ?? "",
        Reserva: formatarReservaExcel(t.detalhes_reserva),
        Funcionário: t.utilizador_id?.nome ?? "Por Atribuir",
        Horário: formatarHorario(t) === "—" ? "" : formatarHorario(t),
        Estado: ESTADO_LABEL_TAB[t.estado] ?? t.estado,
      }));

      const ws = XLSX.utils.json_to_sheet(linhas, {
        header: ["Data", "Propriedade", "Reserva", "Funcionário", "Horário", "Estado"],
      });
      // Larguras de coluna estimadas (em caracteres).
      ws["!cols"] = [
        { wch: 12 }, // Data
        { wch: 28 }, // Propriedade
        { wch: 48 }, // Reserva
        { wch: 24 }, // Funcionário
        { wch: 16 }, // Horário
        { wch: 14 }, // Estado
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Limpezas");
      XLSX.writeFile(wb, "Relatorio_Limpezas.xlsx");
    } catch (e) {
      setErro(e instanceof Error ? `Exportação falhou: ${e.message}` : "Erro ao exportar Excel.");
    } finally {
      setExportando(false);
    }
  }, [periodo, filtros]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Calendário Operacional</h1>
          <Button
            variant="outline"
            size="icon"
            onClick={carregarTarefas}
            disabled={loading || !periodo}
            aria-label="Atualizar"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          {/* Prompt 113 — Nova Tarefa Manual direto do calendário */}
          <Button
            variant="outline"
            onClick={() => {
              setNovaTarefaErro(null);
              setMostrarNovaTarefa(true);
            }}
            disabled={loading}
            title="Cria uma tarefa manualmente (limpeza, manutenção, etc.)."
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            Nova Tarefa
          </Button>
          {/* v1.64.0 (Prompt 87) — Auto-Atribuir Pendentes */}
          <Button
            onClick={() => setConfirmarAutoAtribuir(true)}
            disabled={autoAtribuindo || loading}
            title="Corre o load balancer para atribuir automaticamente todas as tarefas futuras sem funcionário."
            className="gap-2"
          >
            {autoAtribuindo ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {autoAtribuindo ? "A atribuir…" : "Auto-Atribuir Pendentes"}
          </Button>

          {/* Prompt 99 — Toggle de vistas (Calendário / Tabela) */}
          <div className="ml-auto flex items-center gap-1 rounded-md border bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => setVista("calendario")}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                vista === "calendario"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={vista === "calendario"}
            >
              <CalendarRange className="h-3.5 w-3.5" />
              Vista Calendário
            </button>
            <button
              type="button"
              onClick={() => setVista("tabela")}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                vista === "tabela"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={vista === "tabela"}
            >
              <Table className="h-3.5 w-3.5" />
              Vista Tabela
            </button>
          </div>

          {/* Prompt 99 — Exportar Excel (só relevante na Vista Tabela) */}
          <Button
            variant="outline"
            onClick={exportarExcel}
            disabled={exportando || loading || tarefasTabela.length === 0}
            title="Exporta os dados visíveis na tabela para um ficheiro Excel (.xlsx)"
            className="gap-2"
          >
            {exportando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exportando ? "A exportar…" : "Exportar Excel"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Vista mensal, semanal e diária de todas as tarefas de limpeza. Filtra por
          propriedade, staff ou estado. Clica numa tarefa para ver o detalhe e reatribuir.
          Alterna para a Vista Tabela e exporta para Excel.
        </p>
      </div>

      {/* Zona de Filtros */}
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex lg:gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Propriedade</label>
            <select
              value={filtros.propriedadeId}
              onChange={(e) => setFiltros((f) => ({ ...f, propriedadeId: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              <option value="">Todas</option>
              {propriedades.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Staff</label>
            <select
              value={filtros.utilizadorId}
              onChange={(e) => setFiltros((f) => ({ ...f, utilizadorId: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              <option value="">Todos</option>
              <option value="null">Por atribuir</option>
              {equipa.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Estado</label>
            <select
              value={filtros.estado}
              onChange={(e) => setFiltros((f) => ({ ...f, estado: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring lg:w-44"
            >
              {ESTADO_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {(filtros.propriedadeId || filtros.utilizadorId || filtros.estado) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 self-end"
              onClick={() => setFiltros({ propriedadeId: "", utilizadorId: "", estado: "" })}
            >
              <X className="h-3.5 w-3.5" />
              Limpar
            </Button>
          )}
        </div>

        {/* Indicador de loading discreto */}
        {loading && (
          <Badge variant="secondary" className="self-start px-3 py-1.5 text-xs lg:self-end">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            A sincronizar…
          </Badge>
        )}
      </div>

      {/* Erro */}
      {erro && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{erro}</span>
          <Button variant="outline" size="sm" onClick={carregarTarefas} className="ml-auto">
            Tentar novamente
          </Button>
        </div>
      )}

      {/* Prompt 114 — Toast de warning (ex.: distância entre tarefas do mesmo dia) */}
      {warningToast && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span className="flex-1">{warningToast}</span>
          <Button variant="outline" size="sm" onClick={() => setWarningToast(null)} className="ml-auto">
            Fechar
          </Button>
        </div>
      )}

      {/* v1.64.0 (Prompt 87) — Banner de resultado da auto-atribuição */}
      {autoAtribuirResultado && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/50 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-400">
          <Sparkles className="h-5 w-5 shrink-0" />
          <span className="flex-1">{autoAtribuirResultado}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoAtribuirResultado(null)}
            className="ml-auto"
          >
            Fechar
          </Button>
        </div>
      )}

      {/* Prompt 99 — Vista Calendário (FullCalendar) */}
      {vista === "calendario" && (
        <div className="rounded-lg border bg-card p-2 sm:p-4">
          {mounted ? (
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              locale={ptLocale}
              timeZone="local"
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay",
              }}
              // Ponto 1 — Horário comercial (esconde madrugada/noite)
              slotMinTime="08:00:00"
              slotMaxTime="20:00:00"
              // Ponto 2 — Grelha de tempo: linhas de 15min, label de 1h
              slotDuration="00:15:00"
              slotLabelInterval="01:00:00"
              // Ponto 3 — Indicador de tempo real (linha vermelha)
              nowIndicator
              height={700}
              editable={false}
              eventStartEditable={false}
              eventDurationEditable={false}
              events={eventos}
              eventClick={handleEventClick}
              datesSet={handleDatesSet}
              dayMaxEvents
              eventDisplay="block"
              // Ponto 4 — Renderização customizada do bloco
              eventContent={renderEventContent}
              // Formato 24h europeu (Prompt 72)
              eventTimeFormat={{
                hour: "2-digit",
                minute: "2-digit",
                meridiem: false,
                hour12: false,
              }}
              slotLabelFormat={{
                hour: "2-digit",
                minute: "2-digit",
                meridiem: false,
                hour12: false,
              }}
            />
          ) : (
            <div className="flex h-[700px] items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A preparar calendário…
            </div>
          )}
        </div>
      )}

      {/* Prompt 99 — Vista Tabela (Data Table) */}
      {vista === "tabela" && (
        <div className="rounded-lg border bg-card">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar tarefas…
            </div>
          ) : tarefasTabela.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <Table className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Sem tarefas para o período/filtros selecionados.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Data</th>
                    <th className="px-4 py-3 font-medium">Propriedade</th>
                    <th className="px-4 py-3 font-medium">Reserva</th>
                    <th className="px-4 py-3 font-medium">Funcionário</th>
                    <th className="px-4 py-3 font-medium">Horário</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tarefasTabela.map((t) => (
                    <tr
                      key={t._id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setTarefaSelecionada(t)}
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-medium">
                        {formatarDataDMY(t.data)}
                      </td>
                      <td className="px-4 py-3">
                        {t.propriedade_id?.nome ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatarReserva(t.detalhes_reserva, t.data)}
                      </td>
                      <td className="px-4 py-3">
                        {t.utilizador_id?.nome ?? (
                          <span className="text-amber-600 dark:text-amber-400">Por Atribuir</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatarHorario(t)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={ESTADO_VARIANT_TAB[t.estado] ?? "secondary"}>
                          {ESTADO_LABEL_TAB[t.estado] ?? t.estado}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              {tarefasTabela.length} tarefa(s) no período selecionado
              {periodo ? ` (${formatarDataDMY(periodo.inicio)} → ${formatarDataDMY(periodo.fim)})` : ""}.
            </span>
            <span>Clica numa linha para ver o detalhe.</span>
          </div>
        </div>
      )}

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Legenda:</span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#fee2e2", borderColor: "#fca5a5" }}
          />
          Por atribuir
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#fef9c3", borderColor: "#fde047" }}
          />
          Atribuída / Em curso
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#dcfce7", borderColor: "#86efac" }}
          />
          Concluída
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#f1f5f9", borderColor: "#cbd5e1" }}
          />
          Cancelada
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded border"
            style={{ backgroundColor: "#e2e8f0", borderColor: "#cbd5e1" }}
          />
          Folga fixa
        </span>
      </div>

      {/* Modal de detalhe + reatribuição */}
      <Dialog
        open={tarefaSelecionada !== null}
        onOpenChange={(o) => !o && setTarefaSelecionada(null)}
      >
        <DialogHeader>
          <DialogTitle>Detalhe da Tarefa</DialogTitle>
          <DialogDescription>Informação da tarefa e reatribuição rápida.</DialogDescription>
          <DialogClose onClick={() => setTarefaSelecionada(null)} />
        </DialogHeader>
        {tarefaSelecionada && (
          <DialogContent className="space-y-4">
            {/* Estado + tipo + propriedade */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  tarefaSelecionada.estado === "concluida"
                    ? "default"
                    : tarefaSelecionada.estado === "cancelada"
                    ? "secondary"
                    : tarefaSelecionada.estado === "por_atribuir"
                    ? "destructive"
                    : "outline"
                }
              >
                {ESTADO_OPTS.find((o) => o.value === tarefaSelecionada.estado)?.label ??
                  tarefaSelecionada.estado}
              </Badge>
              {/* v1.58.0 (Prompt 80, ponto 4) — Badge de tipo para deixar claro
                  que manutenções também podem ser atribuídas/reatribuídas. */}
              {tarefaSelecionada.tipo && TIPO_LABEL[tarefaSelecionada.tipo] && (
                <Badge variant="outline" className="gap-1">
                  {emojiPorTipo(tarefaSelecionada.tipo)} {TIPO_LABEL[tarefaSelecionada.tipo]}
                </Badge>
              )}
              <span className="font-medium">
                {tarefaSelecionada.propriedade_id?.nome ?? "—"}
              </span>
            </div>

            {/* Data + tempo */}
            <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
                <span>
                  {formatarDataSegura(tarefaSelecionada.data, (d) => format(d, "EEEE, d 'de' MMMM yyyy", { locale: pt }), "—")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span>
                  {horaTarefa(tarefaSelecionada.data)} -{" "}
                  {horaFimTarefa(
                    tarefaSelecionada.data,
                    tarefaSelecionada.tempo_limpeza_minutos
                  )}{" "}
                  · {tarefaSelecionada.tempo_limpeza_minutos} min
                </span>
              </div>
              {tarefaSelecionada.propriedade_id?.morada && (
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {tarefaSelecionada.propriedade_id.morada}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span>
                  Staff atual:{" "}
                  {tarefaSelecionada.utilizador_id?.nome ?? (
                    <span className="text-destructive">Por atribuir</span>
                  )}
                </span>
              </div>
            </div>

            {/* Reatribuição Inteligente (Prompt 75) */}
            <div className="space-y-1.5">
              <label htmlFor="reatribuir" className="text-sm font-medium">
                Reatribuir a (recalcula horário)
              </label>
              <p className="text-xs text-muted-foreground">
                O sistema recalcula a hora de início com base nas tarefas
                existentes do staff, tempo de viagem e hora de almoço (13h-14h).
              </p>
              <select
                id="reatribuir"
                value={reatribuindoPara}
                onChange={(e) => setReatribuindoPara(e.target.value)}
                disabled={tarefaSelecionada.estado === "concluida"}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">— Selecionar staff —</option>
                {equipa
                  // NÃO mostrar os staff indisponíveis no dropdown (férias/
                  // doença/ausência nesse dia). Antes eram mostrados como
                  // option disabled; agora são omitidos para a lista só
                  // conter quem pode realmente receber a tarefa.
                  .filter(
                    (u) => !indisponiveis.some((i) => i.utilizador_id === u._id)
                  )
                  .map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.nome}
                    </option>
                  ))}
              </select>
              {/* Aviso visual de staff indisponível (omitidos da lista) */}
              {indisponiveis.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ {indisponiveis.length} membro(s) da equipa está(ão) de férias/ausência neste dia e foram omitidos da lista.
                </p>
              )}
            </div>

            {/* v1.68.0 (Prompt 91) — Bloco de destaque para observações.
                Se for manutenção (avaria), fundo amarelado/vermelho claro
                com ícone de alerta. Caso contrário, bloco neutro normal. */}
            {tarefaSelecionada.observacoes && (
              <div
                className={
                  tarefaSelecionada.tipo === "manutencao"
                    ? "rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm dark:bg-amber-950/20"
                    : "rounded-md bg-muted/30 p-3 text-sm"
                }
              >
                <p
                  className={
                    "mb-1 flex items-center gap-1.5 text-xs font-semibold " +
                    (tarefaSelecionada.tipo === "manutencao"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground")
                  }
                >
                  {tarefaSelecionada.tipo === "manutencao" ? "🛠️ Avaria Reportada:" : "Observações:"}
                </p>
                <p
                  className={
                    tarefaSelecionada.tipo === "manutencao"
                      ? "text-amber-900 dark:text-amber-100"
                      : ""
                  }
                >
                  {tarefaSelecionada.observacoes}
                </p>
              </div>
            )}
          </DialogContent>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setTarefaSelecionada(null)}
            disabled={reatribuindo}
          >
            Fechar
          </Button>
          <Button
            type="button"
            onClick={handleReatribuir}
            disabled={
              tarefaSelecionada?.estado === "concluida" ||
              !reatribuindoPara ||
              reatribuindo
            }
            title={
              tarefaSelecionada?.estado === "concluida"
                ? "Tarefa concluída — não pode ser reatribuída."
                : undefined
            }
          >
            {reatribuindo ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A reatribuir…
              </>
            ) : (
              "Reatribuir"
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* v1.64.0 (Prompt 87) — Dialog de confirmação: Auto-Atribuir Pendentes */}
      <Dialog open={confirmarAutoAtribuir} onOpenChange={setConfirmarAutoAtribuir}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Auto-Atribuir Pendentes
          </DialogTitle>
          <DialogDescription>
            O sistema vai tentar atribuir automaticamente todas as tarefas
            futuras que estão sem funcionário. Continuar?
          </DialogDescription>
          <DialogClose onClick={() => setConfirmarAutoAtribuir(false)} />
        </DialogHeader>
        <DialogContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            O load balancer vai procurar o staff com menor carga para cada
            tarefa, respeitando férias, folgas fixas, tempo de viagem e hora
            de almoço (13h-14h). As tarefas que não conseguirem ser atribuídas
            (sem staff disponível) continuam por atribuir.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmarAutoAtribuir(false)}
            disabled={autoAtribuindo}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleAutoAtribuir}
            disabled={autoAtribuindo}
          >
            {autoAtribuindo ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A atribuir…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Sim, auto-atribuir
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 113 — Dialog: Nova Tarefa Manual */}
      <Dialog open={mostrarNovaTarefa} onOpenChange={setMostrarNovaTarefa}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-primary" />
            Nova Tarefa
          </DialogTitle>
          <DialogDescription>
            Cria uma tarefa manual no calendário. A data é tratada como local
            (Lisboa) — a tarefa aparece no dia certo em todas as vistas.
          </DialogDescription>
          <DialogClose onClick={() => setMostrarNovaTarefa(false)} />
        </DialogHeader>
        <DialogContent>
          <form onSubmit={handleCriarTarefa} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nt-prop">Propriedade</label>
              <select
                id="nt-prop"
                value={novaForm.propriedade_id}
                onChange={(e) => setNovaForm((f) => ({ ...f, propriedade_id: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                required
              >
                <option value="">— Selecionar —</option>
                {propriedades.map((p) => (
                  <option key={p._id} value={p._id}>{p.nome}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-data">Data</label>
                <Input
                  id="nt-data"
                  type="date"
                  value={novaForm.data}
                  onChange={(e) => setNovaForm((f) => ({ ...f, data: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-hora">Hora da Limpeza</label>
                <Input
                  id="nt-hora"
                  type="time"
                  value={novaForm.hora}
                  onChange={(e) => setNovaForm((f) => ({ ...f, hora: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-tempo">Tempo (min)</label>
                <Input
                  id="nt-tempo"
                  type="number"
                  min={5}
                  step={5}
                  value={novaForm.tempo_limpeza_minutos}
                  onChange={(e) => setNovaForm((f) => ({ ...f, tempo_limpeza_minutos: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-hospedes">Nº de Hóspedes</label>
                <Input
                  id="nt-hospedes"
                  type="number"
                  min={0}
                  value={novaForm.hospedes}
                  onChange={(e) => setNovaForm((f) => ({ ...f, hospedes: e.target.value }))}
                  placeholder="0"
                />
              </div>
              {/* Task 131 — Nome do Hóspede */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-nome-hospede">Nome do Hóspede</label>
                <Input
                  id="nt-nome-hospede"
                  type="text"
                  value={novaForm.nome_hospede}
                  onChange={(e) => setNovaForm((f) => ({ ...f, nome_hospede: e.target.value }))}
                  placeholder="Ex.: João Silva"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-checkin">Data de Check-in</label>
                <Input
                  id="nt-checkin"
                  type="date"
                  value={novaForm.check_in}
                  onChange={(e) => setNovaForm((f) => ({ ...f, check_in: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="nt-checkout">Data de Check-out</label>
                <Input
                  id="nt-checkout"
                  type="date"
                  value={novaForm.check_out}
                  onChange={(e) => setNovaForm((f) => ({ ...f, check_out: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nt-tipo">Tipo</label>
              <select
                id="nt-tipo"
                value={novaForm.tipo}
                onChange={(e) => setNovaForm((f) => ({ ...f, tipo: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="limpeza">Limpeza</option>
                <option value="manutencao">Manutenção</option>
                <option value="check_in">Check-in</option>
                <option value="check_out">Check-out</option>
                <option value="outro">Outro</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nt-staff">
                Atribuir a (opcional)
              </label>
              <select
                id="nt-staff"
                value={novaForm.utilizador_id}
                onChange={(e) => setNovaForm((f) => ({ ...f, utilizador_id: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Por atribuir (deixar órfã) —</option>
                {equipa.map((u) => (
                  <option key={u._id} value={u._id}>{u.nome}</option>
                ))}
              </select>
            </div>

            {novaTarefaErro && (
              <p className="text-sm text-destructive">{novaTarefaErro}</p>
            )}
          </form>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarNovaTarefa(false)}
            disabled={novaTarefaLoading}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleCriarTarefa}
            disabled={novaTarefaLoading || !novaForm.propriedade_id || !novaForm.data}
          >
            {novaTarefaLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A criar…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Criar Tarefa
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 135 — Modal de Confirmação de Conflito de Horário */}
      <Dialog open={conflitoModal !== null} onOpenChange={(o) => !o && setConflitoModal(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Conflito de Horário Detetado
            </DialogTitle>
            <DialogDescription>
              {conflitoModal?.warning || "O funcionário já tem uma tarefa agendada neste horário."}
              <br />
              A tarefa foi criada, mas fica marcada com cor de alerta.
              Queres mantê-la ou voltar atrás?
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setConflitoModal(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Se mantiveres a tarefa, ela aparecerá no calendário com uma{" "}
            <strong className="text-amber-600">borda âmbar</strong> para alertar
            do sobre-agendamento. Podes cancelá-la depois se necessário.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={async () => {
              // Cancela a tarefa criada em conflito.
              if (conflitoModal?.tarefaCriada?._id) {
                try {
                  await adminPatch(`/api/gestor/tarefas/${conflitoModal.tarefaCriada._id}/estado`, { estado: "cancelada" });
                  await carregarTarefas();
                } catch (e) {
                  setErro("Não foi possível cancelar a tarefa em conflito.");
                }
              }
              setConflitoModal(null);
            }}
          >
            Voltar Atrás (Cancelar Tarefa)
          </Button>
          <Button
            type="button"
            variant="default"
            className="bg-amber-600 hover:bg-amber-700"
            onClick={() => setConflitoModal(null)}
          >
            Manter Tarefa
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
