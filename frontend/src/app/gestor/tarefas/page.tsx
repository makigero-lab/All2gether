"use client";

import { TipoMarca, TipoLimpezaBadge } from "@/components/tipo-limpeza-badge";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  ClipboardList,
  Loader2,
  AlertCircle,
  RefreshCw,
  UserCheck,
  SprayCan,
  CheckCircle2,
  Wrench,
  Filter,
  Sparkles,
  Eye,
  Info,
  UserMinus,
  Download,
  ChevronDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { OfertaVagaBadge } from "@/components/gestor/oferta-vaga-badge";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  adminGet,
  adminPost,
  adminPatch,
  type PropriedadeDTO,
  type UtilizadorDTO,
  type Role,
} from "@/lib/api";
import { PaginationBar } from "@/components/admin/pagination-bar";
import { DetalheTarefaModal } from "@/components/gestor/detalhe-tarefa-modal";
import { parsearDataSegura, extrairHoraISO, plural } from "@/lib/utils";
import { SeletorDisponiveis, corpoAtribuicao, type InfoDisponiveis } from "@/components/gestor/seletor-disponiveis";

interface TarefaAdmin {
  _id: string;
  // FIX (qtd hóspedes) — Inclui capacidade_hospedes no populate da propriedade
  // para fallback quando tarefa.hospedes é null/0.
  propriedade_id?: { _id?: string; nome: string; capacidade_hospedes?: number | null } | null;
  utilizador_id?: { _id?: string; nome: string } | null;
  // Equipa completa (responsável incluído). Vazia em tarefas antigas: vale só utilizador_id.
  equipa_atribuida?: { _id?: string; nome: string }[] | null;
  // > 0 quando faltou alguém e não houve substituto.
  pessoas_em_falta?: number;
  oferta_estado?: string | null;
  oferta_expira_em?: string | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
  avarias?: string[];
  // v1.68.0 (Prompt 91) — Observações (descrição da avaria em manutenções).
  observacoes?: string;
  // Prompt 95 (Fase 1.5) — Observações do staff + detalhes da reserva.
  observacoes_staff?: string;
  detalhes_reserva?: {
    checkin?: string | null;
    checkout?: string | null;
    pax?: number | null;
    nome_hospede?: string | null;
  } | null;
  // FIX (qtd hóspedes) — Número de hóspedes da reserva (vindo do Smoobu
  // ou preenchido manualmente). Fallback: propriedade.capacidade_hospedes.
  hospedes?: number | null;
  // FIX (sync parceiros) — true se a tarefa veio de uma reserva de parceiro.
  origem_parceiro?: boolean;
  /** Tipo de limpeza; sem o campo = normal. */
  tipo_limpeza?: string | null;
  // FIX (motivo_falha_atribuicao) — Motivo pelo qual a auto-atribuição falhou
  // (ex: "Toda a equipa de folga/férias", "Lotação máxima excedida").
  motivo_nao_atribuicao?: string | null;
}

/** Nomes da equipa (responsável primeiro, sem repetidos). */
function nomesEquipa(t: TarefaAdmin): string[] {
  const vistos = new Set<string>();
  const nomes: string[] = [];
  const todos = [t.utilizador_id, ...(t.equipa_atribuida ?? [])];
  for (const m of todos) {
    if (!m || !m.nome) continue;
    const chave = m._id ?? m.nome;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    nomes.push(m.nome);
  }
  return nomes;
}

/** Equipa para mostrar: "Ana (resp.) + Bia" quando há mais de um membro. */
function EquipaTarefa({ t }: { t: TarefaAdmin }) {
  const nomes = nomesEquipa(t);
  if (nomes.length === 0) return <>—</>;
  return (
    <span className="block">
      {nomes.length === 1 ? (
        nomes[0]
      ) : (
        <>
          <span className="font-medium text-foreground">{nomes[0]}</span>
          <span className="text-xs"> (resp.)</span>
          {nomes.slice(1).map((n) => (
            <span key={n}> + {n}</span>
          ))}
        </>
      )}
      {(t.pessoas_em_falta ?? 0) > 0 && (
        <span className="mt-0.5 block text-xs font-medium text-amber-700 dark:text-amber-400">
          Falta {t.pessoas_em_falta} {t.pessoas_em_falta === 1 ? "pessoa" : "pessoas"}
        </span>
      )}
    </span>
  );
}

function formatarData(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    return d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * v1.68.0 (Prompt 91) — Formata data + hora (ex: "06/07/2026 - 14:30").
 * Se a data for meia-noite exata (sem hora definida), mostra só a data.
 * Prompt 127 — Usa extrairHoraISO para evitar time shift do browser.
 */
function formatarDataHora(iso: string): string {
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    const data = d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    // Prompt 127 — Extrai a hora da string ISO sem converter fuso.
    const hora = extrairHoraISO(iso);
    if (hora === "—") return data;
    return `${data} - ${hora}`;
  } catch {
    return iso;
  }
}

export default function AdminTarefasPage() {
  const [tarefas, setTarefas] = useState<TarefaAdmin[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [staff, setStaff] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  // Prompt 114 — Toast de warning (ex.: distância entre tarefas do mesmo dia).
  const [warningToast, setWarningToast] = useState<string | null>(null);

  // Filtro: mostrar só tarefas com avarias.
  const [soAvarias, setSoAvarias] = useState(false);

  // FIX (filtros avançados) — Filtros de intervalo de datas, propriedade e staff.
  // Aplicados client-side sobre as tarefas já carregadas (que cobrem 3 meses).
  const [filtroDataInicio, setFiltroDataInicio] = useState("");
  const [filtroDataFim, setFiltroDataFim] = useState("");
  const [filtroPropriedade, setFiltroPropriedade] = useState("");
  const [filtroStaff, setFiltroStaff] = useState("");
  // FIX (sync parceiros) — Toggle para mostrar só tarefas de reservas de parceiros.
  const [soParceiros, setSoParceiros] = useState(false);

  // v1.58.0 (Prompt 80, ponto 3) — Aba de filtragem por estado.
  // 'todas' | 'por_atribuir' | 'pendentes' | 'concluidas'
  type AbaEstado = "todas" | "por_atribuir" | "pendentes" | "concluidas";
  const [abaEstado, setAbaEstado] = useState<AbaEstado>("todas");

  // Aplica filtros client-side (avarias + aba de estado + filtros avançados).
  const tarefasFiltradas = tarefas.filter((t) => {
    // Filtro de avarias (toggle existente).
    if (soAvarias && !(Array.isArray(t.avarias) && t.avarias.length > 0)) {
      return false;
    }
    // FIX (sync parceiros) — Filtro “Apenas Parceiros”.
    if (soParceiros && !t.origem_parceiro) {
      return false;
    }
    // FIX (filtros avançados) — Intervalo de datas.
    if (filtroDataInicio) {
      const dataTarefa = t.data?.slice(0, 10);
      if (!dataTarefa || dataTarefa < filtroDataInicio) return false;
    }
    if (filtroDataFim) {
      const dataTarefa = t.data?.slice(0, 10);
      if (!dataTarefa || dataTarefa > filtroDataFim) return false;
    }
    // FIX (filtros avançados) — Filtro de propriedade (compara por nome).
    if (filtroPropriedade) {
      const nomeSelecionado = propriedades.find((p) => p._id === filtroPropriedade)?.nome;
      if (t.propriedade_id?.nome !== nomeSelecionado) return false;
    }
    // FIX (filtros avançados) — Filtro de staff (compara por nome).
    if (filtroStaff) {
      const nomeStaff = staff.find((s) => s._id === filtroStaff)?.nome;
      if (t.utilizador_id?.nome !== nomeStaff) return false;
    }
    // Filtro da aba de estado.
    switch (abaEstado) {
      case "por_atribuir":
        // Prompt 138 (136 V2) — inclui 'nao_atribuida' (SLA excedido).
        return t.estado === "por_atribuir" || t.estado === "nao_atribuida";
      case "pendentes":
        // Pendentes = atribuídas/em_curso (ainda não concluídas nem canceladas).
        return t.estado === "atribuida" || t.estado === "em_curso";
      case "concluidas":
        return t.estado === "concluida";
      case "todas":
      default:
        return true;
    }
  });

  // Paginação client-side.
  const [pagina, setPagina] = useState(1);
  const [tamPagina, setTamPagina] = useState(25);
  const totalPaginas = Math.max(1, Math.ceil(tarefasFiltradas.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const tarefasPagina = tarefasFiltradas.slice(
    (paginaSegura - 1) * tamPagina,
    paginaSegura * tamPagina
  );
  useEffect(() => {
    if (pagina > totalPaginas) setPagina(totalPaginas);
  }, [pagina, totalPaginas]);

  // Formulário de criação
  // Prompt 117 — adicionados hora, check_in, check_out, hospedes.
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form, setForm] = useState({
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
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);
  // Prompt 126 — Conflito de horário (soft block): o backend cria a tarefa e
  // devolve um warning com a palavra "horário". Em vez de fechar o form,
  // mostramos um aviso inline e pedimos um 2º clique ("Forçar Agendamento").
  const [conflitoForcar, setConflitoForcar] = useState(false);
  // Menu «Ações» (telemóvel).
  const [menuAcoes, setMenuAcoes] = useState(false);
  const menuAcoesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuAcoes) return;
    const fora = (e: MouseEvent) => {
      if (menuAcoesRef.current && !menuAcoesRef.current.contains(e.target as Node)) setMenuAcoes(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuAcoes(false);
    };
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [menuAcoes]);
  // A limpeza em conflito JÁ foi criada no 1.º clique: o 2.º clique só a confirma (não volta a criar).
  const [tarefaConflitoId, setTarefaConflitoId] = useState<string | null>(null);

  // Modal de atribuição
  const [atribuindo, setAtribuindo] = useState<TarefaAdmin | null>(null);
  const [atribuirUserId, setAtribuirUserId] = useState("");
  const [atribuirSubmitting, setAtribuirSubmitting] = useState(false);

  // Prompt 95 — Modal de detalhe da tarefa (card de detalhes_reserva).
  const [detalheTarefa, setDetalheTarefa] = useState<TarefaAdmin | null>(null);

  // Quem pode fazer a limpeza (o seletor pergunta ao servidor) e se é uma vaga de equipa.
  const [infoDisp, setInfoDisp] = useState<InfoDisponiveis | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const hoje = new Date();
      const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      const fim = new Date(hoje.getFullYear(), hoje.getMonth() + 3, 0);
      const inicioStr = inicio.toISOString().split("T")[0];
      const fimStr = fim.toISOString().split("T")[0];

      const [tarefasRes, propRes, equipaRes] = await Promise.all([
        adminGet<{ tarefas: TarefaAdmin[] }>(
          `/api/gestor/tarefas?inicio=${inicioStr}&fim=${fimStr}`
        ),
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/gestor/propriedades"),
        adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
      ]);

      setTarefas(tarefasRes.tarefas ?? []);
      setPropriedades(propRes.propriedades ?? []);
      setStaff(
        // Prompt 105 — Só staff (não gestores/admins) pode receber limpezas.
        // Prompt 114 — Só staff ATIVO (não inativos/desativados).
        (equipaRes.utilizadores ?? []).filter(
          (u) => u.role === "staff" && u.ativo === true
        )
      );
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar tarefas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleSubmeter(e: React.FormEvent) {
    e.preventDefault();
    setFormErro(null);

    if (!form.propriedade_id || !form.data) {
      setFormErro("Propriedade e Data são obrigatórias.");
      return;
    }

    // 2.º clique de «Forçar Agendamento»: a limpeza já existe (criada no 1.º clique). Confirmar é
    // fechar o formulário, sem pedir outra criação (daria 409 «já existe») nem duplicar.
    if (conflitoForcar && tarefaConflitoId) {
      setConflitoForcar(false);
      setTarefaConflitoId(null);
      setForm({
        propriedade_id: "", utilizador_id: "", data: "", hora: "", check_in: "", check_out: "",
        hospedes: "", nome_hospede: "", tempo_limpeza_minutos: "45", tipo: "limpeza",
      });
      setMostrarForm(false);
      await carregar();
      return;
    }

    setSubmitting(true);
    try {
      // Prompt 114 — Captura warning de distância (Haversine > 15km entre
      // tarefas do mesmo dia do mesmo staff).
      // Prompt 117 — envia hora, check_in, check_out, hospedes.
      // A combinação data + hora é enviada como "YYYY-MM-DD" + "HH:mm"
      // separados — o backend combina como LOCAL (new Date("YYYY-MM-DDTHH:mm")
      // sem Z) para não gravar às 00:00 UTC.
      // Prompt 126 — Se conflitoForcar=true (2º clique), envia flag para o
      // backend ignorar o conflito de horário.
      const res = await adminPost<{
        tarefa: TarefaAdmin;
        warning?: string;
        conflito_horario?: boolean;
        aviso_horario?: string;
      }>(
        "/api/gestor/tarefas",
        {
          propriedade_id: form.propriedade_id,
          utilizador_id: form.utilizador_id || null,
          data: form.data,
          hora: form.hora || undefined,
          check_in: form.check_in || undefined,
          check_out: form.check_out || undefined,
          hospedes: form.hospedes ? Number(form.hospedes) : undefined,
          nome_hospede: form.nome_hospede || undefined,
          tempo_limpeza_minutos: Number(form.tempo_limpeza_minutos) || 45,
          tipo: form.tipo,
          forcar: conflitoForcar || undefined,
        }
      );

      // Prompt 126 — Conflito de horário: o warning contém a palavra "horário".
      // No 1º clique (conflitoForcar=false), mostra o aviso inline e NÃO fecha
      // o form. No 2º clique (conflitoForcar=true), o utilizador já confirmou —
      // fecha o form normalmente.
      // O backend marca o conflito real com `conflito_horario`; o aviso de «fora do
      // horário de trabalho» vem em `aviso_horario` e é só informativo.
      const temConflitoHorario = res.conflito_horario === true;

      if (temConflitoHorario && !conflitoForcar) {
        // 1º clique com conflito: ativa o modo "Forçar Agendamento". A limpeza já ficou criada.
        setConflitoForcar(true);
        setTarefaConflitoId(res.tarefa?._id ?? null);
        await carregar();
        // Não mostra como toast global — o aviso aparece inline acima do botão.
        setSubmitting(false);
        return;
      }

      // 2º clique (conflito confirmado) ou sem conflito: fluxo normal.
      // Reset do flag de conflito.
      setConflitoForcar(false);

      // Warning logístico (distância > 15km) — mostra como toast.
      const avisoToast = [!temConflitoHorario ? res.warning : null, res.aviso_horario]
        .filter(Boolean)
        .join(" | ");
      if (avisoToast) setWarningToast(avisoToast);

      setForm({
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
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar tarefa.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAtribuir() {
    if (!atribuindo || !atribuirUserId) return;
    setAtribuirSubmitting(true);
    try {
      // Prompt 114 — Captura warning de distância.
      const res = await adminPatch<{ tarefa: TarefaAdmin; warning?: string; aviso_horario?: string }>(
        `/api/gestor/tarefas/${atribuindo._id}/atribuir`,
        corpoAtribuicao(atribuirUserId, infoDisp, atribuindo.utilizador_id, atribuindo.equipa_atribuida)
      );
      const avisoAtribuir = [res.warning, res.aviso_horario].filter(Boolean).join(" | ");
      if (avisoAtribuir) setWarningToast(avisoAtribuir);
      setAtribuindo(null);
      setAtribuirUserId("");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao atribuir tarefa.");
    } finally {
      setAtribuirSubmitting(false);
    }
  }

  // FIX (por atribuir manual) — Desatribui uma tarefa (coloca 'por_atribuir').
  async function handleDesatribuir(t: TarefaAdmin) {
    try {
      await adminPatch(`/api/gestor/tarefas/${t._id}/estado`, { estado: "por_atribuir" });
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao desatribuir tarefa.");
    }
  }

  // Prompt 127 — Modal de confirmação para cancelar tarefa.
  const [cancelarTarget, setCancelarTarget] = useState<TarefaAdmin | null>(null);
  const [cancelarLoading, setCancelarLoading] = useState(false);

  // HF18 — Modal "Nova Limpeza Espontânea".
  // Endpoint: POST /api/gestor/tarefas/espontanea
  // Payload: { propriedade_id, data, hora?, observacoes?, utilizador_id? }
  // Origem: 'manual' (sem reserva Smoobu associada).
  // Reaproveita as listas `propriedades` e `staff` já carregadas na página.
  const [espontaneaOpen, setEspontaneaOpen] = useState(false);
  const [espontaneaForm, setEspontaneaForm] = useState({
    propriedade_id: "",
    data: "",
    hora: "",
    observacoes: "",
    utilizador_id: "",
  });
  const [espontaneaSubmitting, setEspontaneaSubmitting] = useState(false);
  const [espontaneaErro, setEspontaneaErro] = useState<string | null>(null);

  /** HF18 — Submete a limpeza espontânea via POST /api/gestor/tarefas/espontanea. */
  async function handleSubmeterEspontanea(e: React.FormEvent) {
    e.preventDefault();
    setEspontaneaErro(null);

    if (!espontaneaForm.propriedade_id || !espontaneaForm.data) {
      setEspontaneaErro("Propriedade e Data são obrigatórias.");
      return;
    }

    setEspontaneaSubmitting(true);
    try {
      await adminPost<{ tarefa: TarefaAdmin }>(
        "/api/gestor/tarefas/espontanea",
        {
          propriedade_id: espontaneaForm.propriedade_id,
          data: espontaneaForm.data,
          // Hora opcional — só envia se preenchida.
          hora: espontaneaForm.hora || undefined,
          observacoes: espontaneaForm.observacoes.trim() || undefined,
          // Utilizador opcional — se vazio, a tarefa fica "por_atribuir"
          // (o gestor pode depois atribuir manualmente ou usar o LB).
          utilizador_id: espontaneaForm.utilizador_id || undefined,
        }
      );

      // Limpa o formulário e fecha o modal.
      setEspontaneaForm({
        propriedade_id: "",
        data: "",
        hora: "",
        observacoes: "",
        utilizador_id: "",
      });
      setEspontaneaOpen(false);
      await carregar();
    } catch (e) {
      setEspontaneaErro(e instanceof Error ? e.message : "Erro ao criar limpeza espontânea.");
    } finally {
      setEspontaneaSubmitting(false);
    }
  }

  async function handleCancelar(t: TarefaAdmin) {
    setCancelarTarget(t);
  }

  async function confirmarCancelamento() {
    if (!cancelarTarget) return;
    setCancelarLoading(true);
    try {
      await adminPatch(`/api/gestor/tarefas/${cancelarTarget._id}/estado`, { estado: "cancelada" });
      setCancelarTarget(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao cancelar tarefa.");
    } finally {
      setCancelarLoading(false);
    }
  }

  // v1.64.0 (Prompt 87) — Auto-atribuição em lote (load balancer manual).
  const [autoAtribuindo, setAutoAtribuindo] = useState(false);
  const [confirmarAutoAtribuir, setConfirmarAutoAtribuir] = useState(false);

  async function handleAutoAtribuir() {
    setAutoAtribuindo(true);
    setConfirmarAutoAtribuir(false);
    setErro(null);
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
          : `Foram reatribuídas ${plural(res.reatribuidas, "tarefa")}. ` +
            (res.orfas > 0
              ? `${res.orfas} continuam por atribuir (sem staff disponível).`
              : "Nenhuma ficou por atribuir. ✅");
      setWarningToast(msg);

      // Atualiza a grelha para mostrar os blocos a mudarem de vermelho para as cores dos funcionários.
      await carregar();
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

  // FIX (import/export excel) — Exporta todas as tarefas para .xlsx (download direto).
  async function handleExportarExcel() {
    try {
      const res = await fetch("/api/gestor/reservas/exportar-excel", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Erro ao exportar Excel.");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reservas_all2gether.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao exportar Excel.");
    }
  }

  /** Ações da limpeza (iguais na tabela e nos cartões; `tam` ajusta o alvo de toque). */
  function acoesTarefa(t: TarefaAdmin, tam: string) {
    return (
      <>
        <Button variant="ghost" size="icon" className={tam} onClick={() => setDetalheTarefa(t)} aria-label="Ver detalhe" title="Ver detalhe">
          <Eye className="h-4 w-4" />
        </Button>
        {(t.estado === "por_atribuir" || t.estado === "atribuida" || t.estado === "nao_atribuida") && (
          <Button variant="ghost" size="icon" className={tam} onClick={() => { setAtribuindo(t); setAtribuirUserId(""); setInfoDisp(null); }} aria-label="Atribuir" title="Atribuir / Reatribuir">
            <UserCheck className="h-4 w-4" />
          </Button>
        )}
        {(t.estado === "atribuida" || t.estado === "em_curso") && (
          <Button variant="ghost" size="icon" className={`${tam} text-amber-600 hover:text-amber-700`} onClick={() => handleDesatribuir(t)} aria-label="Desatribuir (por atribuir)" title="Desatribuir (colocar por atribuir)">
            <UserMinus className="h-4 w-4" />
          </Button>
        )}
        {t.estado !== "cancelada" && t.estado !== "concluida" && (
          <span className="ml-2 h-6 w-px shrink-0 bg-border md:hidden" aria-hidden="true" />
        )}
        {t.estado !== "cancelada" && t.estado !== "concluida" && (
          <Button variant="ghost" size="icon" className={`${tam} text-destructive hover:text-destructive`} onClick={() => handleCancelar(t)} aria-label="Cancelar tarefa" title="Cancelar">
            <AlertCircle className="h-4 w-4" />
          </Button>
        )}
      </>
    );
  }

  /** Estado visível (staff desativado => "por atribuir") + motivo. */
  function estadoTarefa(t: TarefaAdmin) {
    const estadoExibido =
      (t.estado === "atribuida" || t.estado === "em_curso") && !t.utilizador_id ? "por_atribuir" : t.estado;
    return (
      <div className="flex flex-wrap items-center gap-1">
        <EstadoTarefaBadge estado={estadoExibido} />
        <OfertaVagaBadge tarefa={t} className="basis-full" />
        {(t.estado === "por_atribuir" || t.estado === "nao_atribuida") && t.motivo_nao_atribuicao && (
          <span title={t.motivo_nao_atribuicao} className="cursor-help">
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6 overflow-x-hidden p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">Limpezas</h1>
          <p className="text-sm text-muted-foreground">
            Gestão manual de limpezas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:[&>button]:h-11 max-sm:[&>button]:min-w-[44px]">
          {/* Cabeçalho da opção A: Exportar, Mais (secundárias), Nova limpeza e a ação principal em petróleo. */}
          <Button variant="outline" onClick={handleExportarExcel} disabled={loading} title="Exporta todas as limpezas para um ficheiro Excel (.xlsx)." className="gap-2 max-sm:hidden">
            <Download className="h-4 w-4" aria-hidden="true" />
            Exportar
          </Button>
          <div className="relative" ref={menuAcoesRef}>
            <Button
              variant="outline"
              className="gap-1.5"
              aria-haspopup="menu"
              aria-expanded={menuAcoes}
              onClick={() => setMenuAcoes((v) => !v)}
            >
              Mais
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            {menuAcoes && (
              <div role="menu" className="absolute right-0 z-40 mt-1 w-64 rounded-md border bg-popover p-1 shadow-md">
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => { setMenuAcoes(false); setSoAvarias((v) => !v); setPagina(1); }}
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                  {soAvarias ? "Mostrar todas as limpezas" : "Só limpezas com avarias"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setMenuAcoes(false);
                    setEspontaneaOpen(true);
                    setEspontaneaErro(null);
                    setEspontaneaForm({ propriedade_id: "", data: "", hora: "", observacoes: "", utilizador_id: "" });
                  }}
                >
                  <SprayCan className="h-4 w-4" aria-hidden="true" />
                  Limpeza espontânea
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                  disabled={loading}
                  onClick={() => { setMenuAcoes(false); carregar(); }}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Atualizar a lista
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 sm:hidden"
                  disabled={autoAtribuindo}
                  onClick={() => { setMenuAcoes(false); setConfirmarAutoAtribuir(true); }}
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Auto-atribuir pendentes
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 sm:hidden"
                  disabled={loading}
                  onClick={() => { setMenuAcoes(false); handleExportarExcel(); }}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Exportar Excel
                </button>
              </div>
            )}
          </div>
          <Button variant="outline" onClick={() => { setMostrarForm((v) => !v); setConflitoForcar(false); }}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nova limpeza
          </Button>
          <Button
            onClick={() => setConfirmarAutoAtribuir(true)}
            disabled={autoAtribuindo}
            title="Atribui automaticamente todas as tarefas futuras sem funcionário."
            className="max-sm:hidden"
          >
            {autoAtribuindo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
            {autoAtribuindo ? "A atribuir…" : "Auto-atribuir pendentes"}
          </Button>
        </div>
      </div>

      {/* Indicador de filtro ativo */}
      {soAvarias && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>
            A mostrar {plural(tarefasFiltradas.length, "tarefa")} com avarias reportadas.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setSoAvarias(false)}
          >
            Limpar filtro
          </Button>
        </div>
      )}

      {/* Formulário de criação */}
      {mostrarForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SprayCan className="h-5 w-5 text-brand-text" />
              Nova limpeza manual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmeter} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Propriedade</label>
                  <select
                    value={form.propriedade_id}
                    onChange={(e) => setForm((f) => ({ ...f, propriedade_id: e.target.value }))}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    required
                  >
                    <option value="">Selecionar…</option>
                    {propriedades.filter((p) => p.ativo).map((p) => (
                      <option key={p._id} value={p._id}>{p.nome}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Equipa (opcional)</label>
                  <select
                    value={form.utilizador_id}
                    onChange={(e) => setForm((f) => ({ ...f, utilizador_id: e.target.value }))}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— Por atribuir —</option>
                    {staff.map((u) => (
                      <option key={u._id} value={u._id}>{u.nome}</option>
                    ))}
                  </select>
                </div>
                {/* v1.57.0 (Prompt 79) — Select de tipo para permitir criar
                    tarefas de manutenção (avarias) manualmente, não só limpezas. */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Tipo</label>
                  <select
                    value={form.tipo}
                    onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="limpeza">Limpeza</option>
                    <option value="manutencao">Manutenção</option>
                    <option value="check_in">Check-in</option>
                    <option value="check_out">Check-out</option>
                    <option value="outro">Outro</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Data</label>
                  <Input type="date" value={form.data} onChange={(e) => setForm((f) => ({ ...f, data: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Tempo (min)</label>
                  <Input type="number" min={0} value={form.tempo_limpeza_minutos} onChange={(e) => setForm((f) => ({ ...f, tempo_limpeza_minutos: e.target.value }))} />
                </div>
                {/* Prompt 117 — Hora da Limpeza (combina com Data como LOCAL) */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Hora da Limpeza</label>
                  <Input type="time" value={form.hora} onChange={(e) => setForm((f) => ({ ...f, hora: e.target.value }))} />
                </div>
                {/* Prompt 117 — Data de Check-in */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Data de Check-in</label>
                  <Input type="date" value={form.check_in} onChange={(e) => setForm((f) => ({ ...f, check_in: e.target.value }))} />
                </div>
                {/* Prompt 117 — Data de Check-out */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Data de Check-out</label>
                  <Input type="date" value={form.check_out} onChange={(e) => setForm((f) => ({ ...f, check_out: e.target.value }))} />
                </div>
                {/* Prompt 117 — Nº de Hóspedes */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Nº de Hóspedes</label>
                  <Input type="number" min={0} value={form.hospedes} onChange={(e) => setForm((f) => ({ ...f, hospedes: e.target.value }))} placeholder="0" />
                </div>
                {/* Task 131 — Nome do Hóspede */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Nome do Hóspede</label>
                  <Input type="text" value={form.nome_hospede} onChange={(e) => setForm((f) => ({ ...f, nome_hospede: e.target.value }))} placeholder="Ex.: João Silva" />
                </div>
              </div>
              {formErro && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />{formErro}
                </p>
              )}
              {/* Prompt 126 — Aviso inline de conflito de horário (não toast). */}
              {conflitoForcar && (
                <p className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  ⚠️ Conflito de horário detetado. A limpeza já ficou criada: confirma para a manter ou desfaz.
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  disabled={submitting}
                  variant={conflitoForcar ? "outline" : "default"}
                  className={conflitoForcar ? "border-destructive/50 text-destructive hover:bg-destructive/10 dark:text-amber-400 dark:border-amber-500/50 dark:hover:bg-amber-500/10" : ""}
                >
                  {submitting ? (
                    <><Loader2 className="h-4 w-4 animate-spin" />A guardar…</>
                  ) : conflitoForcar ? (
                    "Forçar Agendamento"
                  ) : (
                    "Criar Limpeza"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    // Em conflito a limpeza já foi criada: «Cancelar» desfaz-a (sem deixar lixo).
                    if (conflitoForcar && tarefaConflitoId) {
                      try {
                        await adminPatch(`/api/gestor/tarefas/${tarefaConflitoId}/estado`, { estado: "cancelada" });
                        await carregar();
                      } catch (e) {
                        setErro(e instanceof Error ? e.message : "Não foi possível cancelar a limpeza em conflito.");
                      }
                    }
                    setMostrarForm(false);
                    setConflitoForcar(false);
                    setTarefaConflitoId(null);
                  }}
                  disabled={submitting}
                >
                  {conflitoForcar && tarefaConflitoId ? "Desfazer limpeza" : "Cancelar"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Erro */}
      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{erro}</span>
            <Button variant="outline" size="sm" onClick={carregar} className="ml-auto">Tentar novamente</Button>
          </CardContent>
        </Card>
      )}

      {/* Prompt 114 — Toast de warning (ex.: distância entre tarefas do mesmo dia) */}
      {warningToast && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{warningToast}</span>
            <Button variant="outline" size="sm" onClick={() => setWarningToast(null)} className="ml-auto">Fechar</Button>
          </CardContent>
        </Card>
      )}

      {/* v1.58.0 (Prompt 80, ponto 3) — Abas de filtragem por estado */}
      <Tabs value={abaEstado} onValueChange={(v) => setAbaEstado(v as AbaEstado)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:inline-flex sm:h-9 sm:w-auto">
          <TabsTrigger value="todas" className="gap-1.5">
            Todas
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-xs">
              {tarefas.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="por_atribuir" className="gap-1.5">
            Por atribuir
            {tarefas.filter((t) => ["por_atribuir", "nao_atribuida"].includes(t.estado)).length > 0 && (
              <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-xs">
                {tarefas.filter((t) => ["por_atribuir", "nao_atribuida"].includes(t.estado)).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pendentes" className="gap-1.5">
            Pendentes
            {tarefas.filter((t) => t.estado === "atribuida" || t.estado === "em_curso").length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-xs">
                {tarefas.filter((t) => t.estado === "atribuida" || t.estado === "em_curso").length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="concluidas" className="gap-1.5">
            Concluídas
            {tarefas.filter((t) => t.estado === "concluida").length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-xs">
                {tarefas.filter((t) => t.estado === "concluida").length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* FIX (filtros avançados) — Barra de filtros: datas, propriedade, staff. */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
            <label className="text-xs font-medium text-muted-foreground">Data de início</label>
            <Input
              type="date"
              aria-label="Data de início"
              value={filtroDataInicio}
              onChange={(e) => { setFiltroDataInicio(e.target.value); setPagina(1); }}
              className="h-11 w-full min-w-0 sm:h-9 sm:w-[150px]"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
            <label className="text-xs font-medium text-muted-foreground">Data de fim</label>
            <Input
              type="date"
              aria-label="Data de fim"
              value={filtroDataFim}
              onChange={(e) => { setFiltroDataFim(e.target.value); setPagina(1); }}
              className="h-11 w-full min-w-0 sm:h-9 sm:w-[150px]"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
            <label className="text-xs font-medium text-muted-foreground">Propriedade</label>
            <select
              value={filtroPropriedade}
              onChange={(e) => { setFiltroPropriedade(e.target.value); setPagina(1); }}
              className="h-11 w-full min-w-0 max-w-full truncate rounded-md border border-input bg-background px-3 text-sm ring-offset-background sm:h-9 sm:w-auto sm:max-w-[16rem] focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Filtrar por propriedade"
            >
              <option value="">Todas</option>
              {propriedades.filter((p) => p.ativo).map((p) => (
                <option key={p._id} value={p._id}>{p.nome}</option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
            <label className="text-xs font-medium text-muted-foreground">Equipa</label>
            <select
              value={filtroStaff}
              onChange={(e) => { setFiltroStaff(e.target.value); setPagina(1); }}
              className="h-11 w-full min-w-0 max-w-full truncate rounded-md border border-input bg-background px-3 text-sm ring-offset-background sm:h-9 sm:w-auto sm:max-w-[16rem] focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Filtrar por funcionário"
            >
              <option value="">Todos</option>
              {staff.map((u) => (
                <option key={u._id} value={u._id}>{u.nome}</option>
              ))}
            </select>
          </div>
          {/* FIX (sync parceiros) — Toggle “Apenas Parceiros”. */}
          <Button
            variant={soParceiros ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => { setSoParceiros((v) => !v); setPagina(1); }}
            aria-pressed={soParceiros}
            title="Mostrar só limpezas geradas por reservas de proprietários"
          >
            🤝 Apenas proprietários
          </Button>
          {(filtroDataInicio || filtroDataFim || filtroPropriedade || filtroStaff || soParceiros) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => {
                setFiltroDataInicio("");
                setFiltroDataFim("");
                setFiltroPropriedade("");
                setFiltroStaff("");
                setSoParceiros(false);
                setPagina(1);
              }}
            >
              Limpar filtros
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {tarefasFiltradas.length} de {plural(tarefas.length, "tarefa")}
          </span>
        </CardContent>
      </Card>

      {/* Tabela */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />A carregar limpezas…
            </div>
          ) : tarefasFiltradas.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <ClipboardList className="h-10 w-10 opacity-40" />
              <p className="text-sm">
                {soAvarias
                  ? "Sem limpezas com avarias reportadas."
                  : abaEstado === "por_atribuir"
                  ? "Sem limpezas por atribuir. Tudo sob controlo! ✅"
                  : abaEstado === "pendentes"
                  ? "Sem limpezas pendentes."
                  : abaEstado === "concluidas"
                  ? "Sem limpezas concluídas."
                  : "Sem limpezas."}
              </p>
            </div>
          ) : (
            <>
            {/* Telemóvel: cartões (sem scroll horizontal) */}
            <ul className="divide-y md:hidden" aria-label="Limpezas">
              {tarefasPagina.map((t) => (
                <li key={t._id} className="space-y-2 p-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{t.propriedade_id?.nome ?? "—"}</p>
                    <p className="text-xs tabular-nums text-muted-foreground">{formatarDataHora(t.data)}</p>
                    <div className="mt-1.5">{estadoTarefa(t)}</div>
                  </div>
                  <p className="break-words text-sm text-muted-foreground">
                    <span className="text-xs uppercase tracking-wide">Equipa: </span>
                    <EquipaTarefa t={t} />
                  </p>
                  {(t.origem_parceiro || (t.tipo_limpeza && t.tipo_limpeza !== "normal") || (Array.isArray(t.avarias) && t.avarias.length > 0)) && (
                    <div className="flex flex-wrap gap-1">
                      <TipoLimpezaBadge tipo={t.tipo_limpeza} />
                      {t.origem_parceiro && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-xs">🤝 Proprietário</Badge>
                      )}
                      {Array.isArray(t.avarias) && t.avarias.length > 0 && (
                        <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-xs">
                          <Wrench className="h-3 w-3" />
                          Avaria
                        </Badge>
                      )}
                    </div>
                  )}
                  {t.observacoes && (
                    <p className="line-clamp-2 break-words text-xs text-muted-foreground">{t.observacoes}</p>
                  )}
                  <div className="flex items-center justify-end gap-1">{acoesTarefa(t, "h-11 w-11")}</div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="rt w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Data</th>
                    <th className="min-w-[10rem] px-4 py-3 font-medium">Propriedade</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    {/* Prompt 136 — Coluna Hóspede (nome_hospede da reserva). */}
                    <th className="hidden px-4 py-3 font-medium min-[1440px]:table-cell">Hóspede</th>
                    {/* FIX (qtd hóspedes) — Coluna Qtd. Hóspedes com fallback à lotação. */}
                    <th className="hidden px-4 py-3 font-medium min-[1440px]:table-cell">Qtd. Hóspedes</th>
                    <th className="px-4 py-3 font-medium">Equipa</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    {/* v1.68.0 (Prompt 91) — Coluna Observações / Avaria */}
                    <th className="hidden px-4 py-3 font-medium min-[1440px]:table-cell">Observações / Avaria</th>
                    <th className="sticky right-0 z-10 bg-muted px-4 py-3 text-right font-medium shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.25)]">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tarefasPagina.map((t) => {
                    const temAvarias = Array.isArray(t.avarias) && t.avarias.length > 0;
                    return (
                    <tr key={t._id} className="hover:bg-muted/30">
                      {/* v1.68.0 (Prompt 91) — Data + hora (ex: 06/07/2026 - 14:30) */}
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatarDataHora(t.data)}</td>
                      <td className="min-w-[10rem] max-w-[16rem] px-4 py-3 font-medium">
                        <div className="flex items-center gap-2">
                          <span className="line-clamp-2 min-w-0 break-words" title={t.propriedade_id?.nome ?? undefined}>{t.propriedade_id?.nome ?? "—"}</span>
                          {/* FIX (sync parceiros) — Badge “🤝 Parceiro” se a tarefa
                              veio de uma reserva de parceiro. */}
                          {t.origem_parceiro && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 gap-1 whitespace-nowrap text-xs px-1.5 py-0"
                              title="Limpeza gerada por reserva de proprietário"
                            >
                              🤝 Proprietário
                            </Badge>
                          )}
                          {temAvarias && (
                            <Badge
                              variant="destructive"
                              className="shrink-0 gap-1 whitespace-nowrap text-xs px-1.5 py-0"
                              title={`${plural(plural(t.avarias!.length, "avaria"), "reportada")}`}
                            >
                              <Wrench className="h-3 w-3" />
                              Avaria
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3"><TipoMarca tipo={t.tipo_limpeza} /></td>
                      {/* Prompt 136 — Nome do hóspede (da reserva Smoobu ou manual). */}
                      <td className="hidden min-w-[11rem] max-w-[14rem] px-4 py-3 text-muted-foreground min-[1440px]:table-cell">
                        <span className="line-clamp-2 break-words" title={t.detalhes_reserva?.nome_hospede ?? undefined}>{t.detalhes_reserva?.nome_hospede ?? "—"}</span>
                      </td>
                      {/* FIX (qtd hóspedes) — Quantidade de hóspedes com fallback.
                          Mostra t.hospedes (vindo do Smoobu). Se for null/0/inválido,
                          usa propriedade_id.capacidade_hospedes (lotação máxima) e
                          mostra visualmente que é o limite da casa "(Máx: N)". */}
                      <td className="hidden px-4 py-3 min-[1440px]:table-cell">
                        {(() => {
                          const hospedesReal = t.hospedes ?? t.detalhes_reserva?.pax ?? null;
                          const capacidade = t.propriedade_id?.capacidade_hospedes ?? null;
                          if (hospedesReal && hospedesReal > 0) {
                            return (
                              <span className="inline-flex items-center gap-1 font-medium" title="Nº de hóspedes da reserva">
                                <span aria-hidden>👥</span>
                                {hospedesReal}
                              </span>
                            );
                          }
                          if (capacidade && capacidade > 0) {
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-muted-foreground"
                                title="Sem nº de hóspedes — a mostrar a lotação máxima da casa"
                              >
                                <span aria-hidden>👥</span>
                                (Máx: {capacidade})
                              </span>
                            );
                          }
                          return <span className="text-muted-foreground">—</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground"><EquipaTarefa t={t} /></td>
                      <td className="px-4 py-3">{estadoTarefa(t)}</td>
                      {/* v1.68.0 (Prompt 91) — Excerto das observações (descrição da avaria) */}
                      <td className="hidden max-w-xs px-4 py-3 min-[1440px]:table-cell">
                        {t.observacoes ? (
                          <span
                            className={`line-clamp-2 text-xs ${
                              t.tipo === "manutencao"
                                ? "text-amber-700 dark:text-amber-400 font-medium"
                                : "text-muted-foreground"
                            }`}
                            title={t.observacoes}
                          >
                            {t.observacoes}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="sticky right-0 z-10 bg-card px-4 py-3 shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.25)]">
                        <div className="flex items-center justify-end gap-1">{acoesTarefa(t, "h-11 w-11 md:h-8 md:w-8")}</div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
          {/* Paginação */}
          {!loading && tarefasFiltradas.length > 0 && (
            <PaginationBar
              page={paginaSegura}
              totalPages={totalPaginas}
              total={tarefasFiltradas.length}
              pageSize={tamPagina}
              onPageChange={setPagina}
              onPageSizeChange={(n) => {
                setTamPagina(n);
                setPagina(1);
              }}
              label="tarefas"
            />
          )}
        </CardContent>
      </Card>

      {/* Modal de Atribuição */}
      <Dialog open={atribuindo !== null} onOpenChange={(o) => !o && setAtribuindo(null)}>
        <DialogHeader>
          <div>
            <DialogTitle>Atribuir limpeza</DialogTitle>
            <DialogDescription>
              {atribuindo?.propriedade_id?.nome} — {atribuindo ? formatarData(atribuindo.data) : ""}
              {atribuindo && nomesEquipa(atribuindo).length > 1 && (
                <span className="mt-1 block text-xs">
                  Equipa atual: {nomesEquipa(atribuindo).join(" + ")}. {infoDisp?.modo === "vaga" ? "A pessoa escolhida entra na equipa e preenche a vaga." : "A pessoa escolhida passa a responsável e os outros membros mantêm-se."}
                </span>
              )}
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setAtribuindo(null)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{infoDisp?.modo === "vaga" ? "Quem entra na equipa" : "Equipa"}</label>
            {atribuindo && (
              <SeletorDisponiveis
                tarefaId={atribuindo._id}
                acao="atribuir"
                value={atribuirUserId}
                onChange={setAtribuirUserId}
                onInfo={setInfoDisp}
              />
            )}
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAtribuindo(null)} disabled={atribuirSubmitting}>Cancelar</Button>
          <Button onClick={handleAtribuir} disabled={!atribuirUserId || atribuirSubmitting}>
            {atribuirSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />A atribuir…</> : "Atribuir"}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* v1.64.0 (Prompt 87) — Dialog de confirmação: Auto-Atribuir Pendentes */}
      <Dialog open={confirmarAutoAtribuir} onOpenChange={setConfirmarAutoAtribuir}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-brand-text" />
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
            O sistema vai procurar o funcionário com menor carga para cada
            tarefa, respeitando férias, folgas fixas, tempo de viagem e hora
            de almoço (1 h, a começar entre as 12:00 e as 14:00). As tarefas que não conseguirem ser atribuídas
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

      {/* HF18 — Modal "Nova Limpeza Espontânea" */}
      <Dialog
        open={espontaneaOpen}
        onOpenChange={(o) => {
          if (!espontaneaSubmitting) setEspontaneaOpen(o);
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <SprayCan className="h-5 w-5 text-brand-text" />
              Nova limpeza espontânea
            </DialogTitle>
            <DialogDescription>
              Cria uma limpeza avulsa (sem reserva Smoobu associada). Útil
              para limpezas extra solicitadas pelo proprietário ou parceiro
              B2B. A tarefa fica com origem &ldquo;manual&rdquo;.
            </DialogDescription>
          </div>
          <DialogClose
            onClick={() => {
              if (!espontaneaSubmitting) setEspontaneaOpen(false);
            }}
          />
        </DialogHeader>
        <form onSubmit={handleSubmeterEspontanea}>
          <DialogContent className="space-y-4">
            {/* Propriedade — reutiliza a lista `propriedades` já carregada. */}
            <div className="space-y-1.5">
              <label htmlFor="espontanea-propriedade" className="text-sm font-medium">
                Propriedade <span className="text-destructive">*</span>
              </label>
              {propriedades.length === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Não há propriedades carregadas. Cria uma propriedade primeiro
                  (em Propriedades &gt; Adicionar Manual) e depois volta aqui.
                </p>
              ) : (
                <select
                  id="espontanea-propriedade"
                  value={espontaneaForm.propriedade_id}
                  onChange={(e) =>
                    setEspontaneaForm((f) => ({
                      ...f,
                      propriedade_id: e.target.value,
                    }))
                  }
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Selecionar…</option>
                  {propriedades
                    .filter((p) => p.ativo)
                    .map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.nome}
                      </option>
                    ))}
                </select>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Data (obrigatório) */}
              <div className="space-y-1.5">
                <label htmlFor="espontanea-data" className="text-sm font-medium">
                  Data <span className="text-destructive">*</span>
                </label>
                <Input
                  id="espontanea-data"
                  type="date"
                  value={espontaneaForm.data}
                  onChange={(e) =>
                    setEspontaneaForm((f) => ({ ...f, data: e.target.value }))
                  }
                  required
                />
              </div>
              {/* Hora (opcional) */}
              <div className="space-y-1.5">
                <label htmlFor="espontanea-hora" className="text-sm font-medium">
                  Hora (opcional)
                </label>
                <Input
                  id="espontanea-hora"
                  type="time"
                  value={espontaneaForm.hora}
                  onChange={(e) =>
                    setEspontaneaForm((f) => ({ ...f, hora: e.target.value }))
                  }
                />
              </div>
            </div>

            {/* Atribuir a Staff (opcional) */}
            <div className="space-y-1.5">
              <label htmlFor="espontanea-staff" className="text-sm font-medium">
                Atribuir a Staff (opcional)
              </label>
              <select
                id="espontanea-staff"
                value={espontaneaForm.utilizador_id}
                onChange={(e) =>
                  setEspontaneaForm((f) => ({
                    ...f,
                    utilizador_id: e.target.value,
                  }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">— Por atribuir (cria como &ldquo;por atribuir&rdquo;) —</option>
                {staff.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.nome}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Se não escolheres staff, a tarefa fica &ldquo;por
                atribuir&rdquo;. Podes usar depois o botão{" "}
                <strong>Auto-Atribuir Pendentes</strong> ou atribuir manualmente.
              </p>
            </div>

            {/* Observações */}
            <div className="space-y-1.5">
              <label
                htmlFor="espontanea-observacoes"
                className="text-sm font-medium"
              >
                Observações
              </label>
              <Textarea
                id="espontanea-observacoes"
                value={espontaneaForm.observacoes}
                onChange={(e) =>
                  setEspontaneaForm((f) => ({
                    ...f,
                    observacoes: e.target.value,
                  }))
                }
                rows={3}
                placeholder="Ex.: Limpeza extra pedida pelo proprietário após checkout antecipado."
              />
            </div>

            {espontaneaErro && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {espontaneaErro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEspontaneaOpen(false)}
              disabled={espontaneaSubmitting}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={espontaneaSubmitting || propriedades.length === 0}
            >
              {espontaneaSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A criar…
                </>
              ) : (
                <>
                  <SprayCan className="mr-2 h-4 w-4" />
                  Criar
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Prompt 95 — Modal de detalhe da limpeza (card de detalhes_reserva) */}
      <DetalheTarefaModal
        onAvariaAlterada={carregar}
        onDiaAlterado={(aviso) => { if (aviso) setWarningToast(aviso); carregar(); }}
        tarefa={detalheTarefa}
        open={detalheTarefa !== null}
        onOpenChange={(o) => !o && setDetalheTarefa(null)}
      />

      {/* Prompt 127 — Dialog de confirmação para Cancelar Limpeza */}
      <Dialog open={cancelarTarget !== null} onOpenChange={(o) => !o && setCancelarTarget(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              Cancelar limpeza
            </DialogTitle>
            <DialogDescription>
              Tens a certeza que queres cancelar a limpeza de{" "}
              <strong>{cancelarTarget?.propriedade_id?.nome ?? "Propriedade"}</strong>?
              Esta ação não pode ser desfeita.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setCancelarTarget(null)} />
        </DialogHeader>
        <DialogContent>
          <p className="text-sm text-muted-foreground">
            A limpeza será marcada como <strong>cancelada</strong> e deixará de
            aparecer no calendário. O staff atribuído será notificado.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setCancelarTarget(null)} disabled={cancelarLoading}>
            Manter limpeza
          </Button>
          <Button type="button" variant="destructive" onClick={confirmarCancelamento} disabled={cancelarLoading}>
            {cancelarLoading ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A cancelar…</>
            ) : (
              <><AlertCircle className="mr-2 h-4 w-4" />Sim, Cancelar Limpeza</>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

    </div>
  );
}
