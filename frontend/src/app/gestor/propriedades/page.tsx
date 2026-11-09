"use client";

import { EditarPropriedadeDialog, TIPOLOGIAS, comRegraPessoas, type EditarPropriedadeForm } from "@/components/gestor/editar-propriedade-dialog";
import { useCallback, useEffect, useState } from "react";
import { Plus, Building2, Loader2, AlertCircle, RefreshCw, Power, Pencil, Trash2, CheckCircle2, ListChecks, Navigation } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  adminGet,
  adminPost,
  adminPatch,
  adminPut,
  adminDelete,
  type PropriedadeDTO,
  type UtilizadorDTO,
  type ModeloChecklistDTO,
} from "@/lib/api";
import { lerUtilizador, type Role } from "@/lib/auth";
import { googleMapsUrl, plural } from "@/lib/utils";

/** Tipos de limpeza configuráveis por casa (normal usa os valores base da casa). */
const TIPOS_CONFIG = [
  { id: "intermedia", rotulo: "Intermédia" },
  { id: "profunda", rotulo: "Profunda" },
  { id: "preparacao", rotulo: "Preparação" },
] as const;
type TipoConfig = (typeof TIPOS_CONFIG)[number]["id"];
type ConfigTipos = Record<TipoConfig, { tempo: string; checklist: string }>;
const CONFIG_TIPOS_VAZIA: ConfigTipos = {
  intermedia: { tempo: "", checklist: "" },
  profunda: { tempo: "", checklist: "" },
  preparacao: { tempo: "", checklist: "" },
};
function configTiposDe(p: PropriedadeDTO): ConfigTipos {
  const out = { intermedia: { ...CONFIG_TIPOS_VAZIA.intermedia }, profunda: { ...CONFIG_TIPOS_VAZIA.profunda }, preparacao: { ...CONFIG_TIPOS_VAZIA.preparacao } };
  for (const { id } of TIPOS_CONFIG) {
    const t = p.tempos_limpeza_por_tipo?.[id];
    out[id].tempo = t != null ? String(t) : "";
    out[id].checklist = (p.checklists_por_tipo?.[id] ?? []).join("\n");
  }
  return out;
}

/**
 * Página de Propriedades — Painel de Administração.
 *
 * Consome a API real (GET/POST /api/gestor/propriedades).
 *
 * O JWT é enviado automaticamente pelo helper `adminGet`/`adminPost`
 * (header `Authorization: Bearer <token>`, ver `src/lib/api.ts`).
 */
export default function PropriedadesPage() {
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // FIX (filtros default) — "Ativos" selecionado por defeito para reduzir
  // excesso de informação visual (propriedades inativas só aparecem se o
  // gestor procurar explicitamente).
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "ativos" | "inativos">("ativos");

  // Estado do formulário de criação
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form, setForm] = useState({
    nome: "",
    smoobu_id: "",
    morada: "",
    tempo_limpeza_minutos: "45",
    checklist: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);

  // Lista de apartamentos do Smoobu (para o dropdown no formulário de criação).
  // Carregada via GET /api/gestor/smoobu/propriedades quando o formulário abre.
  const [propriedadesSmoobu, setPropriedadesSmoobu] = useState<
    { id: string | number; name: string }[]
  >([]);
  const [smoobuLoading, setSmoobuLoading] = useState(false);
  const [smoobuErro, setSmoobuErro] = useState<string | null>(null);

  // FIX (hard-delete para admin) — Role do utilizador atual (para mostrar o
  // botão "Eliminar Definitivamente" apenas para admin).
  const [userRole, setUserRole] = useState<Role | null>(null);
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (!cancelado) setUserRole(user?.role ?? null);
    })();
    return () => { cancelado = true; };
  }, []);

  // FIX (hard-delete para admin) — Estado do Dialog de confirmação de hard-delete.
  const [eliminandoProp, setEliminandoProp] = useState<PropriedadeDTO | null>(null);
  const [eliminandoSubmitting, setEliminandoSubmitting] = useState(false);

  /** FIX (hard-delete para admin) — Elimina definitivamente a propriedade. */
  async function handleEliminarDefinitivamente() {
    if (!eliminandoProp) return;
    setEliminandoSubmitting(true);
    try {
      await adminDelete(`/api/gestor/propriedades/${eliminandoProp._id}?hard=true`);
      setEliminandoProp(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao eliminar propriedade.");
    } finally {
      setEliminandoSubmitting(false);
    }
  }

  /** Carrega as propriedades da API. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const data = await adminGet<{ propriedades: PropriedadeDTO[] }>(
        "/api/gestor/propriedades"
      );
      setPropriedades(data.propriedades ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar propriedades.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Carrega a lista de apartamentos do Smoobu (para o dropdown). */
  const carregarSmoobu = useCallback(async () => {
    // Só carrega se ainda não foi carregado (evita pedidos repetidos).
    if (propriedadesSmoobu.length > 0) return;
    setSmoobuLoading(true);
    setSmoobuErro(null);
    try {
      const data = await adminGet<{ propriedadesSmoobu: { id: string | number; name: string }[] }>(
        "/api/gestor/smoobu/propriedades"
      );
      setPropriedadesSmoobu(data.propriedadesSmoobu ?? []);
    } catch (e) {
      setSmoobuErro(
        e instanceof Error
          ? `Não foi possível carregar os apartamentos do Smoobu: ${e.message}`
          : "Erro ao carregar apartamentos do Smoobu."
      );
    } finally {
      setSmoobuLoading(false);
    }
  }, [propriedadesSmoobu.length]);

  // Quando o formulário abre, carrega a lista do Smoobu (se ainda não foi).
  useEffect(() => {
    if (mostrarForm) {
      carregarSmoobu();
    }
  }, [mostrarForm, carregarSmoobu]);

  /** Submete o formulário de nova propriedade. */
  async function handleSubmeter(e: React.FormEvent) {
    e.preventDefault();
    setFormErro(null);

    if (!form.nome.trim() || !form.smoobu_id.trim() || !form.morada.trim()) {
      setFormErro("Nome, Smoobu ID e Morada são obrigatórios.");
      return;
    }

    const tempo = Number(form.tempo_limpeza_minutos);
    if (Number.isNaN(tempo) || tempo < 0) {
      setFormErro("Tempo de Limpeza deve ser um número maior ou igual a 0.");
      return;
    }

    // Prompt 126 — Confirmação de morada inválida (GPS não encontrado).
    // Se moradaWarning está ativo e o utilizador ainda não confirmou, pede
    // um 2º clique (set moradaConfirmada=true) sem submeter novamente.
    if (moradaWarning && !moradaConfirmada) {
      setMoradaConfirmada(true);
      return;
    }

    setSubmitting(true);
    try {
      // Prompt 114 — Captura warning de geocoding (morada não georreferenciada).
      // Prompt 126 — Envia flag forcar_morada para o backend saber que o
      // utilizador confirmou a morada inválida (futura extensão).
      const res = await adminPost<{ propriedade: PropriedadeDTO; warning?: string }>(
        "/api/gestor/propriedades",
        {
          nome: form.nome.trim(),
          smoobu_id: form.smoobu_id.trim(),
          morada: form.morada.trim(),
          tempo_limpeza_minutos: tempo,
          checklist: form.checklist
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          forcar_morada: moradaConfirmada || undefined,
        }
      );
      // Prompt 117 — Aviso de geocoding INLINE (não toast global).
      // Prompt 126 — Se voltar a haver warning, mantém o form aberto para o
      // utilizador confirmar (reset moradaConfirmada para exigir novo clique).
      if (res.warning) {
        setMoradaWarning("Morada guardada, mas não encontrada no GPS. Simplifica-a (ex: remova R/C, Esq).");
        setMoradaConfirmada(false);
        // Atualiza a tabela (a propriedade foi criada) mas não fecha o form.
        await carregar();
        return;
      }
      // Sem warning — limpa o formulário e fecha.
      setMoradaWarning(null);
      setMoradaConfirmada(false);
      setForm({ nome: "", smoobu_id: "", morada: "", tempo_limpeza_minutos: "45", checklist: "" });
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao criar propriedade.");
    } finally {
      setSubmitting(false);
    }
  }

  /** Alterna ativo/inativo com otimismo. */
  async function handleToggleAtivo(p: PropriedadeDTO) {
    const novoEstado = !p.ativo;
    // Otimismo: atualiza UI imediatamente.
    setPropriedades((prev) =>
      prev.map((x) => (x._id === p._id ? { ...x, ativo: novoEstado } : x))
    );
    setFeedbackOk(null);
    try {
      const res = await adminPatch<{
        ativo: boolean;
        tarefasDesatribuidas?: number;
      }>(`/api/gestor/propriedades/${p._id}/estado`);

      // Feedback (Prompt 97): se a propriedade foi desativada e houve
      // tarefas futuras desatribuídas (passaram a 'por_atribuir'), informa.
      if (!novoEstado && typeof res?.tarefasDesatribuidas === "number") {
        const n = res.tarefasDesatribuidas;
        setFeedbackOk(
          n > 0
            ? `Propriedade desativada. ${plural(n, "tarefa futura não concluída foi desatribuída", "tarefas futuras não concluídas foram desatribuídas")} (por atribuir).`
            : `Propriedade desativada. Não havia tarefas futuras por executar.`
        );
      }
    } catch (e) {
      // Reverte em caso de erro.
      setPropriedades((prev) =>
        prev.map((x) => (x._id === p._id ? { ...x, ativo: p.ativo } : x))
      );
      setErro(e instanceof Error ? e.message : "Erro ao alterar estado.");
    }
  }

  // FIX (relocação do botão Smoobu) — Estado `sincronizando`/`sincronizacaoOk`
  // removido. A funcionalidade de importação do Smoobu foi migrada para a
  // página /gestor/configuracoes/integracoes.
  // Estado genérico de feedback de sucesso (toggle de estado, checklist padrão).
  const [feedbackOk, setFeedbackOk] = useState<string | null>(null);
  // Prompt 117 — Aviso de geocoding INLINE (junto ao campo morada, não toast global).
  // String preenchida quando o Nominatim/Google falha ao georreferenciar a morada.
  const [moradaWarning, setMoradaWarning] = useState<string | null>(null);
  // Aviso inline do modal de edição (morada editada não georreferenciada).
  const [editMoradaWarning, setEditMoradaWarning] = useState<string | null>(null);
  // Prompt 126 — Confirmação explícita de morada inválida (GPS não encontrado).
  // Depois do 1º submit com warning, o botão muda para "Confirmar Morada Inválida"
  // e é necessário um 2º clique para confirmar.
  const [moradaConfirmada, setMoradaConfirmada] = useState(false);
  const [editMoradaConfirmada, setEditMoradaConfirmada] = useState(false);

  // FIX (relocação do botão Smoobu) — Estado `sincronizando`/`sincronizacaoOk`
  // removido. A funcionalidade de importação do Smoobu foi migrada para a
  // página /gestor/configuracoes/integracoes.

  // Estado do modal de edição
  const [editando, setEditando] = useState<PropriedadeDTO | null>(null);

  // HF18 — Estado do modal de "Adicionar Propriedade Manual"
  // (fluxo simplificado: nome + morada + tempo de limpeza; origem: 'manual')
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    nome: "",
    morada: "",
    tempo_limpeza_minutos: "45",
    staff_necessario: "1",
    tipologia: "",
    cliente_particular: false,
    dias_fixos_limpeza: [] as number[],
    // FIX (parceiro associado + morada estruturada) — novos campos.
    observacoes: "",
    morada_rua: "",
    morada_codigo_postal: "",
    morada_cidade: "",
    // FIX (parceiro associado relacional) — ID do parceiro B2B associado.
    parceiro_id: "",
    // FIX (restrição lavandaria) — Fornecedor (lavandaria) atribuído.
    fornecedor_id: "",
    // FIX (lotação máxima) — Capacidade máxima de hóspedes (lotação da casa).
    // Usada como fallback quando o Smoobu não envia o número de hóspedes.
    capacidade_hospedes: "",
  });
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualErro, setManualErro] = useState<string | null>(null);

  /** HF18 — Submete o formulário de propriedade manual (origem: 'manual'). */
  async function handleSubmeterManual(e: React.FormEvent) {
    e.preventDefault();
    setManualErro(null);

    if (!manualForm.nome.trim() || (!manualForm.morada.trim() && !manualForm.morada_rua.trim())) {
      setManualErro("Nome e Morada são obrigatórios.");
      return;
    }

    const tempo = Number(manualForm.tempo_limpeza_minutos);
    if (Number.isNaN(tempo) || tempo < 0) {
      setManualErro("Tempo de Limpeza deve ser um número maior ou igual a 0.");
      return;
    }

    setManualSubmitting(true);
    try {
      // HF18 — Payload simplificado. O backend define origem: 'manual'.
      // Não enviamos smoobu_id (a propriedade não vem do Smoobu).
      await adminPost<{ propriedade: PropriedadeDTO; warning?: string }>(
        "/api/gestor/propriedades",
        {
          nome: manualForm.nome.trim(),
          // FIX (morada estruturada) — Se rua foi preenchida, envia morada_estruturada.
          // Senão, envia morada (string única) para retrocompatibilidade.
          ...(manualForm.morada_rua.trim()
            ? {
                morada_estruturada: {
                  rua: manualForm.morada_rua.trim(),
                  codigo_postal: manualForm.morada_codigo_postal.trim(),
                  cidade: manualForm.morada_cidade.trim(),
                },
              }
            : { morada: manualForm.morada.trim() }),
          tempo_limpeza_minutos: tempo,
          staff_necessario: Math.max(1, Math.min(10, Number(manualForm.staff_necessario) || 1)),
          tipologia: manualForm.tipologia === "" ? null : Number(manualForm.tipologia),
          cliente_particular: manualForm.cliente_particular,
          dias_fixos_limpeza: manualForm.dias_fixos_limpeza.length > 0 ? manualForm.dias_fixos_limpeza : undefined,
          // FIX (parceiro associado) — observacoes (notas internas).
          observacoes: manualForm.observacoes.trim() || undefined,
          // FIX (parceiro associado relacional) — ID do parceiro B2B.
          ...(manualForm.parceiro_id.trim()
            ? { parceiro_id: manualForm.parceiro_id.trim() }
            : {}),
          // FIX (restrição lavandaria) — Fornecedor (lavandaria) atribuído.
          ...(manualForm.fornecedor_id.trim()
            ? { fornecedor_id: manualForm.fornecedor_id.trim() }
            : {}),
          // FIX (lotação máxima) — capacidade_hospedes (lotação da casa).
          ...(manualForm.capacidade_hospedes.trim()
            ? { capacidade_hospedes: Number(manualForm.capacidade_hospedes) }
            : {}),
        }
      );
      // Limpa o formulário e fecha o modal.
      setManualForm({ nome: "", morada: "", tempo_limpeza_minutos: "45", staff_necessario: "1", tipologia: "", cliente_particular: false, dias_fixos_limpeza: [], observacoes: "", morada_rua: "", morada_codigo_postal: "", morada_cidade: "", parceiro_id: "", fornecedor_id: "", capacidade_hospedes: "" });
      setManualOpen(false);
      await carregar();
    } catch (e) {
      setManualErro(e instanceof Error ? e.message : "Erro ao criar propriedade.");
    } finally {
      setManualSubmitting(false);
    }
  }

  const [editForm, setEditForm] = useState({
    nome: "",
    smoobu_id: "",
    morada: "",
    tempo_limpeza_minutos: "45",
    checklist: "",
    // Tipos de limpeza: tempo (min) e checklist por tipo (vazios = os da casa).
    tipos: CONFIG_TIPOS_VAZIA,
    funcionario_preferencial_id: "",
    modelo_checklist_id: "",
    // FIX (parceiro associado + morada estruturada) — novos campos.
    observacoes: "",
    morada_rua: "",
    morada_codigo_postal: "",
    morada_cidade: "",
    // FIX (parceiro associado relacional) — ID do parceiro B2B associado.
    parceiro_id: "",
    // FIX (restrição lavandaria) — Fornecedor (lavandaria) atribuído.
    fornecedor_id: "",
    // FIX (equipas preferenciais) — IDs de staff que formam a equipa
    // preferencial desta propriedade (select múltiplo no modal de edição).
    equipa_preferencial: [] as string[],
    // FIX (equipas preferenciais) — Nº de staff necessário para limpar esta
    // propriedade (tornado editável no modal de edição; antes só existia no
    // formulário de criação manual).
    staff_necessario: "1",
    tipologia: "",
    cliente_particular: false,
    // FIX (lotação máxima) — Capacidade máxima de hóspedes (lotação da casa).
    // Usada como fallback quando o Smoobu não envia o número de hóspedes.
    capacidade_hospedes: "",
    // Dias fixos de limpeza (também ao editar).
    dias_fixos_limpeza: [] as number[],
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErro, setEditErro] = useState<string | null>(null);

  // Prompt 134 — Lista de Modelos de Checklist da empresa (para o select no
  // modal de edição). Carregada quando o modal abre.
  const [modelosChecklist, setModelosChecklist] = useState<ModeloChecklistDTO[]>([]);
  const [modelosChecklistLoading, setModelosChecklistLoading] = useState(false);

  const carregarModelosChecklist = useCallback(async () => {
    setModelosChecklistLoading(true);
    try {
      const data = await adminGet<{ modelos: ModeloChecklistDTO[] }>(
        "/api/gestor/checklists"
      );
      setModelosChecklist(data.modelos ?? []);
    } catch {
      // Silencioso — o select aparece vazio mas não bloqueia a edição.
    } finally {
      setModelosChecklistLoading(false);
    }
  }, []);

  // Prompt 113 — Aplicar checklist padrão a todas as propriedades.
  const [checklistLoading, setChecklistLoading] = useState(false);

  const [confirmarChecklistAberto, setConfirmarChecklistAberto] = useState(false);

  async function handleAplicarChecklistPadrao() {
    setConfirmarChecklistAberto(false);
    setChecklistLoading(true);
    setErro(null);
    setFeedbackOk(null);
    try {
      const res = await adminPost<{ message: string; modificadas: number }>(
        "/api/gestor/propriedades/default-checklist",
        {}
      );
      setFeedbackOk(res.message || `Checklist aplicada a ${plural(res.modificadas, "propriedade")}.`);
      await carregar();
    } catch (e) {
      setErro(
        e instanceof Error
          ? `Falha ao aplicar checklist: ${e.message}`
          : "Erro ao aplicar checklist padrão."
      );
    } finally {
      setChecklistLoading(false);
    }
  }

  // Prompt 95 — Lista de staff da empresa (para o select de funcionário
  // preferencial no modal de edição). Carregada uma vez ao montar.
  const [staffList, setStaffList] = useState<UtilizadorDTO[]>([]);
  // FIX (parceiro associado relacional) — Lista de parceiros da empresa
  // (para o select de associação nos formulários de criação/edição).
  const [parceirosList, setParceirosList] = useState<UtilizadorDTO[]>([]);
  // FIX (restrição lavandaria) — Lista de fornecedores (lavandarias) da empresa
  // (para o select "Lavandaria Atribuída" nos formulários de criação/edição).
  const [fornecedoresList, setFornecedoresList] = useState<UtilizadorDTO[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const [staffRes, parceirosRes, fornecedoresRes] = await Promise.all([
          adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/equipa"),
          adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/parceiros"),
          adminGet<{ utilizadores: UtilizadorDTO[] }>("/api/gestor/fornecedores"),
        ]);
        // Só interessa staff ativo (o backend valida isto ao gravar).
        setStaffList(
          (staffRes.utilizadores ?? []).filter(
            (u) => u.role === "staff" && u.ativo
          )
        );
        // FIX (parceiro associado relacional) — Carrega parceiros para o select.
        setParceirosList(parceirosRes.utilizadores ?? []);
        // FIX (restrição lavandaria) — Carrega fornecedores para o select.
        setFornecedoresList(fornecedoresRes.utilizadores ?? []);
      } catch {
        // Silencioso — os selects aparecem vazios mas não bloqueiam a edição.
      }
    })();
  }, []);

  /** Abre o modal de edição com os dados atuais da propriedade. */
  function abrirEdicao(p: PropriedadeDTO) {
    setEditando(p);
    setEditForm({
      nome: p.nome,
      smoobu_id: p.smoobu_id ?? "",
      morada: p.morada ?? "",
      tempo_limpeza_minutos: String(p.tempo_limpeza_minutos ?? 45),
      checklist: (p.checklist ?? []).join("\n"),
      tipos: configTiposDe(p),
      funcionario_preferencial_id: p.funcionario_preferencial_id ?? "",
      // FIX (equipas preferenciais) — Array de IDs de staff preferencial.
      equipa_preferencial: Array.isArray(p.equipa_preferencial)
        ? [...p.equipa_preferencial]
        : [],
      // FIX (equipas preferenciais) — Nº de staff necessário.
      staff_necessario: String(p.staff_necessario ?? 1),
      tipologia: p.tipologia != null ? String(p.tipologia) : "",
      cliente_particular: p.cliente_particular === true,
      // Prompt 134 — Modelo de Checklist associado (string vazia = Nenhum).
      modelo_checklist_id: p.modelo_checklist_id ?? "",
      // FIX (parceiro associado + morada estruturada) — novos campos.
      observacoes: p.observacoes ?? "",
      morada_rua: p.morada_estruturada?.rua ?? "",
      morada_codigo_postal: p.morada_estruturada?.codigo_postal ?? "",
      morada_cidade: p.morada_estruturada?.cidade ?? "",
      // FIX (parceiro associado relacional) — Extrai o ID do parceiro
      // (pode ser string ou objeto populado { _id, nome, ... }).
      parceiro_id:
        p.parceiro_id && typeof p.parceiro_id === "object"
          ? p.parceiro_id._id
          : (p.parceiro_id as string) ?? "",
      // FIX (lotação máxima) — capacidade_hospedes (lotação da casa).
      capacidade_hospedes:
        p.capacidade_hospedes != null ? String(p.capacidade_hospedes) : "",
      // FIX (restrição lavandaria) — fornecedor_id (lavandaria atribuída).
      fornecedor_id:
        p.fornecedor_id && typeof p.fornecedor_id === "object"
          ? p.fornecedor_id._id
          : (p.fornecedor_id as string) ?? "",
      dias_fixos_limpeza: Array.isArray(p.dias_fixos_limpeza) ? [...p.dias_fixos_limpeza] : [],
    });
    setEditErro(null);
    // Prompt 126 — Reset dos avisos de morada ao abrir o modal.
    setEditMoradaWarning(null);
    setEditMoradaConfirmada(false);
    // Prompt 134 — Carrega os modelos de checklist para o select.
    carregarModelosChecklist();
  }

  /**
   * FIX (auto-fill checklist) — Quando o gestor seleciona um Modelo de
   * Checklist no select `edit-modelo-checklist`, faz fetch do modelo e
   * preenche automaticamente o textarea `checklist` (aba "Checklists").
   *
   * - String vazia ("Nenhum"): só atualiza o editForm, NÃO limpa o textarea
   *   (preserva as edições manuais do gestor).
   * - ID válido: busca as secções/items em GET /api/gestor/checklists/:id e
   *   concatena todos os items (um por linha) no textarea.
   */
  async function handleModeloChecklistChange(id: string) {
    // Atualiza o editForm com o ID selecionado imediatamente.
    setEditForm((f) => ({ ...f, modelo_checklist_id: id }));

    // "Nenhum" → não faz fetch nem limpa o textarea.
    if (!id) return;

    try {
      const data = await adminGet<{ modelo: ModeloChecklistDTO }>(
        `/api/gestor/checklists/${id}`
      );
      const modelo = data.modelo;
      if (!modelo?.seccoes) return;

      // Concatena todos os items de todas as secções (um item por linha).
      // Preserva a ordem das secções e dos items dentro de cada secção.
      const items: string[] = [];
      for (const seccao of modelo.seccoes) {
        if (!Array.isArray(seccao.items)) continue;
        for (const item of seccao.items) {
          if (typeof item === "string" && item.trim()) {
            items.push(item);
          }
        }
      }

      // Só substitui o textarea se houver items válidos (evita apagar
      // edições manuais se o modelo estiver vazio).
      if (items.length > 0) {
        setEditForm((f) => ({ ...f, checklist: items.join("\n") }));
      }
    } catch {
      // Silencioso — o utilizador pode preencher o textarea manualmente.
      // O ID do modelo continua guardado no editForm (será enviado ao gravar).
    }
  }

  /** Submete a edição da propriedade. */
  async function handleEditar(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    setEditErro(null);

    if (!editForm.nome.trim() || (!editForm.morada.trim() && !editForm.morada_rua.trim())) {
      setEditErro("Nome e Morada são obrigatórios.");
      return;
    }

    const tempo = Number(editForm.tempo_limpeza_minutos);
    if (Number.isNaN(tempo) || tempo < 0) {
      setEditErro("Tempo de Limpeza deve ser um número maior ou igual a 0.");
      return;
    }

    for (const { id, rotulo } of TIPOS_CONFIG) {
      const t = editForm.tipos[id].tempo.trim();
      if (t !== "" && (!/^\d{1,3}$/.test(t) || Number(t) < 1 || Number(t) > 480)) {
        setEditErro(`Tempo da limpeza ${rotulo.toLowerCase()}: entre 1 e 480 minutos (ou deixa vazio para usar o tempo da casa).`);
        return;
      }
    }

    // Prompt 126 — Confirmação de morada inválida no modal de edição.
    if (editMoradaWarning && !editMoradaConfirmada) {
      setEditMoradaConfirmada(true);
      return;
    }

    setEditSubmitting(true);
    try {
      // Prompt 114 — Captura warning de geocoding (nova morada não georreferenciada).
      // Prompt 126 — Envia flag forcar_morada para o backend saber que o
      // utilizador confirmou a morada inválida.
      const res = await adminPut<{ propriedade: PropriedadeDTO; warning?: string; limpezas?: { atualizadas: number; sem_equipa: number; em_segundo_plano?: boolean } }>(
        `/api/gestor/propriedades/${editando._id}`,
        {
          nome: editForm.nome.trim(),
          // FIX (morada estruturada) — Se rua foi preenchida, envia morada_estruturada.
          // Senão, envia morada (string única) para retrocompatibilidade.
          ...(editForm.morada_rua.trim()
            ? {
                morada_estruturada: {
                  rua: editForm.morada_rua.trim(),
                  codigo_postal: editForm.morada_codigo_postal.trim(),
                  cidade: editForm.morada_cidade.trim(),
                },
              }
            : { morada: editForm.morada.trim() }),
          tempo_limpeza_minutos: tempo,
          checklist: editForm.checklist
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          // Tipos de limpeza: vazio = usa o tempo / a checklist da casa.
          tempos_limpeza_por_tipo: Object.fromEntries(
            TIPOS_CONFIG.map(({ id }) => [id, editForm.tipos[id].tempo.trim() === "" ? null : Number(editForm.tipos[id].tempo)])
          ),
          checklists_por_tipo: Object.fromEntries(
            TIPOS_CONFIG.map(({ id }) => [
              id,
              editForm.tipos[id].checklist.split("\n").map((x) => x.trim()).filter((x) => x.length > 0),
            ])
          ),
          // FIX (cartão redundante removido) — funcionario_preferencial_id
          // já não é enviado (cartão removido da UI). O backend mantém o
          // campo para retrocompatibilidade mas não é editável.
          // Prompt 134 — Modelo de Checklist associado. String vazia → null
          // (sem modelo / usa checklist flat antigo).
          modelo_checklist_id:
            editForm.modelo_checklist_id.trim() || null,
          // FIX (equipas preferenciais) — Array de IDs de staff preferencial.
          // Envia sempre o array (vazio = sem equipa preferencial). O backend
          // (quando atualizado para suportar este campo) substitui a lista.
          equipa_preferencial: editForm.equipa_preferencial,
          // FIX (equipas preferenciais) — Nº de staff necessário (1-10).
          staff_necessario: Math.max(
            1,
            Math.min(10, Number(editForm.staff_necessario) || 1)
          ),
          tipologia: editForm.tipologia === "" ? null : Number(editForm.tipologia),
          cliente_particular: editForm.cliente_particular,
          // FIX (parceiro associado) — observacoes (notas internas).
          observacoes: editForm.observacoes.trim(),
          // FIX (parceiro associado relacional) — ID do parceiro B2B.
          // String vazia → null no backend (remove associação).
          ...(editForm.parceiro_id.trim()
            ? { parceiro_id: editForm.parceiro_id.trim() }
            : { parceiro_id: null }),
          // FIX (restrição lavandaria) — Fornecedor (lavandaria) atribuído.
          // String vazia → null no backend (remove associação).
          ...(editForm.fornecedor_id.trim()
            ? { fornecedor_id: editForm.fornecedor_id.trim() }
            : { fornecedor_id: null }),
          // FIX (lotação máxima) — capacidade_hospedes (lotação da casa).
          // String vazia → null no backend (limpa o valor).
          ...(editForm.capacidade_hospedes.trim()
            ? { capacidade_hospedes: Number(editForm.capacidade_hospedes) }
            : { capacidade_hospedes: null }),
          dias_fixos_limpeza: editForm.dias_fixos_limpeza,
          forcar_morada: editMoradaConfirmada || undefined,
        }
      );
      // Prompt 117 — Aviso de geocoding INLINE no modal de edição.
      // Prompt 126 — Se voltar a haver warning, mantém o modal aberto.
      if (res.warning) {
        setEditMoradaWarning("Morada guardada, mas não encontrada no GPS. Simplifica-a (ex: remova R/C, Esq).");
        setEditMoradaConfirmada(false);
        // Atualiza a linha na tabela mas não fecha o modal.
        setPropriedades((prev) =>
          prev.map((x) => (x._id === editando._id ? res.propriedade : x))
        );
        return;
      }
      setEditMoradaWarning(null);
      setEditMoradaConfirmada(false);
      // Atualiza a linha na tabela.
      setPropriedades((prev) =>
        prev.map((x) => (x._id === editando._id ? res.propriedade : x))
      );
      setEditando(null);
      // Limpezas por começar que seguiram o novo tempo / nº de pessoas.
      const l = res.limpezas;
      if (l?.em_segundo_plano) {
        setFeedbackOk("Propriedade guardada. As limpezas por começar estão a ser atualizadas.");
      } else if (l && l.atualizadas > 0) {
        setFeedbackOk(
          `Propriedade guardada. ${l.atualizadas} ${l.atualizadas === 1 ? "limpeza por começar foi atualizada" : "limpezas por começar foram atualizadas"}` +
            (l.sem_equipa > 0 ? `; ${l.sem_equipa} ${l.sem_equipa === 1 ? "ficou" : "ficaram"} sem equipa (vê o calendário).` : ".")
        );
      }
    } catch (e) {
      setEditErro(e instanceof Error ? e.message : "Erro ao editar propriedade.");
    } finally {
      setEditSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">Propriedades</h1>
          <p className="text-sm text-muted-foreground">
            Alojamentos sincronizados com o Smoobu.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* FIX (filtros default) — Select de Estado com "Ativos" pré-selecionado. */}
          <select
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value as "todos" | "ativos" | "inativos")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filtrar por estado"
          >
            <option value="todos">Estado: Todos</option>
            <option value="ativos">Estado: Ativos</option>
            <option value="inativos">Estado: Inativos</option>
          </select>
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {/* FIX (relocação do botão Smoobu) — Botão "Importar do Smoobu"
              removido desta página. A funcionalidade foi migrada para a página
              /gestor/configuracoes/integracoes (secção "Ações Manuais de
              Emergência"). Aqui mantém-se apenas o "Checklist Padrão" e o
              "Adicionar" manual. */}
          {/* Prompt 113 — Aplicar checklist padrão a todas as propriedades */}
          <Button
            variant="outline"
            onClick={() => setConfirmarChecklistAberto(true)}
            disabled={checklistLoading || propriedades.length === 0}
            title="Aplica um checklist padrão (6 itens) a todas as propriedades. Substitui o existente."
          >
            {checklistLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ListChecks className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {checklistLoading ? "A aplicar…" : "Checklist Padrão"}
            </span>
          </Button>
          {/* Confirmação da ação destrutiva em massa (substitui o confirm() nativo). */}
          <Dialog open={confirmarChecklistAberto} onOpenChange={setConfirmarChecklistAberto}>
            <DialogHeader>
              <DialogTitle>Substituir o checklist de todas as propriedades?</DialogTitle>
              <DialogDescription>
                Esta ação substitui o checklist de TODAS as propriedades pelo padrão e não pode ser desfeita.
              </DialogDescription>
            </DialogHeader>
            <DialogContent>
              <p className="text-sm text-muted-foreground">
                Checklist padrão: Esvaziar lixo, Trocar roupa da cama, Trocar toalhas, Limpar chão, Limpar vidros, Limpar pó.
              </p>
            </DialogContent>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmarChecklistAberto(false)}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={handleAplicarChecklistPadrao}>
                Substituir tudo
              </Button>
            </DialogFooter>
          </Dialog>
          {/* HF23 — Botão "Nova Propriedade" (Smoobu) removido.
              Mantém-se apenas o "Adicionar Manual". */}
          <Button
            onClick={() => {
              setManualOpen(true);
              setManualErro(null);
              setManualForm({ nome: "", morada: "", tempo_limpeza_minutos: "45", staff_necessario: "1", tipologia: "", cliente_particular: false, dias_fixos_limpeza: [], observacoes: "", morada_rua: "", morada_codigo_postal: "", morada_cidade: "", parceiro_id: "", fornecedor_id: "", capacidade_hospedes: "" });
            }}
          >
            <Plus className="h-4 w-4" />
            Adicionar
          </Button>
        </div>
      </div>

      {/* Formulário inline de criação */}
      {mostrarForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5 text-brand-text" />
              Nova propriedade
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmeter} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <label htmlFor="nome" className="text-sm font-medium">
                    Nome
                  </label>
                  <Input
                    id="nome"
                    value={form.nome}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, nome: e.target.value }))
                    }
                    placeholder="Ex.: Apartamento Maré Alta"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="smoobu_id" className="text-sm font-medium">
                    Apartamento do Smoobu
                  </label>
                  {smoobuLoading ? (
                    <div className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      A carregar do Smoobu…
                    </div>
                  ) : smoobuErro ? (
                    <>
                      <Input
                        id="smoobu_id"
                        value={form.smoobu_id}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, smoobu_id: e.target.value }))
                        }
                        placeholder="Ex.: 67890 (fallback manual)"
                        required
                      />
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {smoobuErro} Podes inserir o ID manualmente.
                      </p>
                    </>
                  ) : (
                    <select
                      id="smoobu_id"
                      value={form.smoobu_id}
                      onChange={(e) => {
                        const idEscolhido = e.target.value;
                        // Encontra o apartamento escolhido para preencher o nome.
                        const apto = propriedadesSmoobu.find(
                          (p) => String(p.id) === idEscolhido
                        );
                        setForm((f) => ({
                          ...f,
                          smoobu_id: idEscolhido,
                          // Preenche o nome automaticamente se o utilizador ainda
                          // não o tiver editado (poupa tempo). Se já escreveu algo
                          // custom, respeita — mas o comportamento padrão é usar o
                          // nome do Smoobu.
                          nome: apto?.name ?? f.nome,
                        }));
                      }}
                      required
                      className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">Seleciona um apartamento…</option>
                      {propriedadesSmoobu.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name} (ID: {p.id})
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Lista carregada do Smoobu. Ao escolher, o nome é preenchido automaticamente.
                  </p>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label htmlFor="morada" className="text-sm font-medium">
                    Morada completa
                  </label>
                  <Input
                    id="morada"
                    value={form.morada}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, morada: e.target.value }));
                      setMoradaWarning(null);
                      // Prompt 126 — Reset da confirmação quando a morada muda.
                      setMoradaConfirmada(false);
                    }}
                    placeholder="Ex.: Rua das Flores 12, Lisboa"
                    required
                  />
                  {/* Prompt 117 — Aviso de geocoding INLINE (não toast global) */}
                  {moradaWarning && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{moradaWarning}</span>
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="tempo_limpeza_minutos"
                    className="text-sm font-medium"
                  >
                    Tempo de Limpeza (min)
                  </label>
                  <Input
                    id="tempo_limpeza_minutos"
                    type="number"
                    min={0}
                    value={form.tempo_limpeza_minutos}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        tempo_limpeza_minutos: e.target.value,
                      }))
                    }
                    placeholder="45"
                  />
                </div>
              </div>

              {/* Checklist de Limpeza */}
              <div className="space-y-1.5">
                <label htmlFor="checklist" className="text-sm font-medium">
                  Checklist de Limpeza (um item por linha)
                </label>
                <textarea
                  id="checklist"
                  value={form.checklist}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, checklist: e.target.value }))
                  }
                  rows={4}
                  placeholder={"Verificar toalhas\nEsvaziar lixo\nTrocar roupa de cama"}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  O staff verá estes itens ao concluir a tarefa de limpeza desta propriedade.
                </p>
              </div>

              {formErro && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {formErro}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  disabled={submitting}
                  variant={moradaWarning ? "outline" : "default"}
                  className={moradaWarning ? "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/50 dark:hover:bg-amber-500/10" : ""}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      A guardar…
                    </>
                  ) : moradaWarning ? (
                    "Confirmar Morada Inválida"
                  ) : (
                    "Guardar Propriedade"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setMostrarForm(false);
                    setFormErro(null);
                    setMoradaWarning(null);
                    setMoradaConfirmada(false);
                    setForm({ nome: "", smoobu_id: "", morada: "", tempo_limpeza_minutos: "45", checklist: "" });
                  }}
                  disabled={submitting}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Erro de carregamento */}
      {erro && !loading && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Não foi possível carregar as propriedades.</p>
              <p className="text-xs opacity-80">{erro}</p>
            </div>
            <Button variant="outline" size="sm" onClick={carregar}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Sucesso da sincronização Smoobu */}
      {/* FIX — Banner de feedback de sucesso (toggle de estado, checklist padrão). */}
      {feedbackOk && (
        <Card className="border-emerald-500/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span>{feedbackOk}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFeedbackOk(null)}
              className="ml-auto"
            >
              Fechar
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tabela de propriedades */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar propriedades…
            </div>
          ) : propriedades.filter((p) =>
            filtroEstado === "todos" ? true : filtroEstado === "ativos" ? p.ativo : !p.ativo
          ).length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Building2 className="h-10 w-10 opacity-40" />
              <p className="text-sm">{filtroEstado === "ativos" ? "Sem propriedades ativas." : "Ainda não há propriedades."}</p>
              <p className="text-xs">
                {filtroEstado === "ativos"
                  ? "Muda o filtro para “Todos” para ver propriedades inativas, ou adiciona uma nova."
                  : "Clica em “Adicionar” para adicionar a primeira."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="rt w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">Smoobu ID</th>
                    <th className="px-4 py-3 font-medium">Tempo de Limpeza</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {propriedades
                    .filter((p) =>
                      filtroEstado === "todos" ? true : filtroEstado === "ativos" ? p.ativo : !p.ativo
                    )
                    .map((p) => (
                    <tr key={p._id} className={`hover:bg-muted/30 ${!p.ativo ? "opacity-60" : ""}`}>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{p.nome}</span>
                          {/* v1.61.0 (Prompt 84) — Capacidade de hóspedes */}
                          {p.capacidade_hospedes != null && p.capacidade_hospedes > 0 && (
                            <Badge variant="outline" className="gap-1 text-xs" title="Capacidade de hóspedes">
                              👥 {p.capacidade_hospedes}
                            </Badge>
                          )}
                          {/* FIX (parceiro associado relacional) — Badge do
                              parceiro associado. Usa parceiro_id populado pelo
                              backend (novo campo relacional). Se não houver,
                              mostra "All2gether". */}
                          <Badge
                            variant="secondary"
                            className="text-xs"
                            title={
                              p.parceiro_id && typeof p.parceiro_id === "object"
                                ? `Proprietário associado: ${p.parceiro_id.nome}`
                                : "Propriedade All2gether"
                            }
                          >
                            {(() => {
                              // FIX (parceiro associado relacional) — Se
                              // parceiro_id estiver populado (objeto), usa o nome.
                              // Senão, fallback para "All2gether".
                              if (p.parceiro_id && typeof p.parceiro_id === "object") {
                                return p.parceiro_id.nome || "All2gether";
                              }
                              return "All2gether";
                            })()}
                          </Badge>
                          {/* FIX (morada estruturada) — Badge "Morada por definir"
                              só aparece se NÃO houver morada estruturada NEM
                              morada string válida. Antes verificava apenas
                              p.morada === "A definir", o que mostrava o badge
                              mesmo quando a morada estruturada estava preenchida. */}
                          {(!p.morada_estruturada?.rua &&
                            (!p.morada || p.morada === "A definir" || p.morada === "")) && (
                            <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 hover:bg-amber-500/20">
                              ⚠️ Morada por definir
                            </Badge>
                          )}
                          {/* Sem coordenadas o tempo de viagem é estimado em 30 min (não há Google Maps). */}
                          {(p.coordenadas?.lat == null || p.coordenadas?.lng == null) && (
                            <Badge
                              className="bg-amber-500/15 text-amber-700 border-amber-500/30 hover:bg-amber-500/20"
                              title="Sem coordenadas: a viagem até esta casa é estimada em 30 min. Edita a morada para a localizar."
                            >
                              Sem localização
                            </Badge>
                          )}
                        </div>
                        {/* FIX (morada estruturada) — Mostra morada estruturada
                            se existir, senão usa moradaCompleta (virtual do
                            backend), senão fallback para morada (string legada).
                            FIX (google maps integration) — Botão "Abrir no Google
                            Maps" que usa coordenadas (se existirem) ou a morada. */}
                        {(() => {
                          const me = p.morada_estruturada;
                          // FIX (morada estruturada) — Prioridade de display:
                          // 1. morada_estruturada concatenada (Rua, CP, Cidade)
                          // 2. moradaCompleta (virtual do backend — já concatenada)
                          // 3. morada (string legada)
                          // 4. null se vazia ou "A definir"
                          let moradaDisplay = '';
                          if (me?.rua) {
                            moradaDisplay = [me.rua, me.codigo_postal, me.cidade].filter(Boolean).join(", ");
                          } else if (p.moradaCompleta) {
                            moradaDisplay = p.moradaCompleta;
                          } else {
                            moradaDisplay = p.morada || '';
                          }
                          if (!moradaDisplay || moradaDisplay === "A definir") return null;
                          // FIX (google maps integration) — Usa coordenadas se
                          // existirem (mais preciso), senão usa a morada string.
                          const coords = p.coordenadas;
                          const gmapsUrl = googleMapsUrl(
                            coords?.lat != null && coords?.lng != null
                              ? { lat: coords.lat, lng: coords.lng }
                              : moradaDisplay
                          );
                          return (
                            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                              <span>{moradaDisplay}</span>
                              {gmapsUrl && (
                                <a
                                  href={gmapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 text-brand-text hover:underline"
                                  title="Abrir no Google Maps"
                                >
                                  <Navigation className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {p.smoobu_id}
                      </td>
                      <td className="px-4 py-3">{p.tempo_limpeza_minutos} min</td>
                      <td className="px-4 py-3">
                        <Badge variant={p.ativo ? "success" : "secondary"}>
                          {p.ativo ? "Ativo" : "Inativo"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => abrirEdicao(p)}
                            aria-label={`Editar ${p.nome}`}
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleToggleAtivo(p)}
                            aria-label={p.ativo ? "Desativar" : "Ativar"}
                            title={p.ativo ? "Desativar" : "Ativar"}
                          >
                            <Power className="h-4 w-4" />
                          </Button>
                          {/* FIX (hard-delete para admin) — Botão "Eliminar
                              Definitivamente" visível EXCLUSIVAMENTE para
                              role === 'admin'. Faz hard-delete (?hard=true). */}
                          {userRole === "admin" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setEliminandoProp(p)}
                              aria-label={`Eliminar definitivamente ${p.nome}`}
                              title="Eliminar Definitivamente (admin)"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* HF18 — Modal "Adicionar Propriedade Manual" */}
      <Dialog
        open={manualOpen}
        onOpenChange={(o) => {
          if (!manualSubmitting) setManualOpen(o);
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-brand-text" />
              Adicionar propriedade manual
            </DialogTitle>
            <DialogDescription>
              Cria uma propriedade que não está sincronizada com o Smoobu
              (origem: manual). Útil para casas geridas diretamente pelo
              gestor ou por proprietários.
            </DialogDescription>
          </div>
          <DialogClose
            onClick={() => {
              if (!manualSubmitting) setManualOpen(false);
            }}
          />
        </DialogHeader>
        <form onSubmit={handleSubmeterManual}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="manual-nome" className="text-sm font-medium">
                Nome <span className="text-destructive">*</span>
              </label>
              <Input
                id="manual-nome"
                value={manualForm.nome}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, nome: e.target.value }))
                }
                placeholder="Ex.: Apartamento Maré Alta"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="manual-morada" className="text-sm font-medium">
                Morada <span className="text-destructive">*</span>
              </label>
              <Input
                id="manual-morada"
                value={manualForm.morada}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, morada: e.target.value }))
                }
                placeholder="Ex.: Rua das Flores 12, Lisboa"
                required
              />
              <p className="text-xs text-muted-foreground">
                As coordenadas são calculadas automaticamente via Nominatim
                (best-effort). Se a morada não for encontrada, a propriedade é
                criada na mesma (sem coordenadas).
              </p>
            </div>
            {/* FIX (morada estruturada) — Campos estruturados opcionais.
                Se preencheres a Rua, o backend usa os 3 campos para geocoding
                e ignora a "Morada" (string única) acima. */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Morada Estruturada (opcional — substitui &quot;Morada&quot; se preenchida)
              </label>
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  placeholder="Rua, número, andar"
                  value={manualForm.morada_rua}
                  onChange={(e) =>
                    setManualForm((f) => ({ ...f, morada_rua: e.target.value }))
                  }
                />
                <Input
                  placeholder="Código Postal (ex: 1200-001)"
                  value={manualForm.morada_codigo_postal}
                  onChange={(e) =>
                    setManualForm((f) => ({ ...f, morada_codigo_postal: e.target.value }))
                  }
                />
                <Input
                  placeholder="Cidade (ex: Lisboa)"
                  value={manualForm.morada_cidade}
                  onChange={(e) =>
                    setManualForm((f) => ({ ...f, morada_cidade: e.target.value }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Preferencial em relação à &quot;Morada&quot; única. Usado para geocoding
                mais preciso e para mostrar a morada de forma estruturada.
              </p>
            </div>
            {/* FIX (parceiro associado) — Observações (notas internas). */}
            <div className="space-y-1.5">
              <label htmlFor="manual-observacoes" className="text-sm font-medium">
                Observações (opcional)
              </label>
              <textarea
                id="manual-observacoes"
                value={manualForm.observacoes}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, observacoes: e.target.value }))
                }
                rows={2}
                placeholder="Notas internas (ex: Proprietário Associado: Particulares, frequência, etc.)"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Notas livres do gestor (ex: frequência, instruções especiais).
              </p>
            </div>
            {/* FIX (parceiro associado relacional) — Select de parceiro B2B. */}
            <div className="space-y-1.5">
              <label htmlFor="manual-parceiro" className="text-sm font-medium">
                Proprietário associado (opcional)
              </label>
              <select
                id="manual-parceiro"
                value={manualForm.parceiro_id}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, parceiro_id: e.target.value }))
                }
                className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Nenhum (propriedade All2gether)</option>
                {parceirosList.map((p) => (
                  <option key={p._id} value={p._id}>{p.nome}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Associa esta propriedade a um proprietário. O nome aparece no Badge da listagem.
              </p>
            </div>
            {/* FIX (restrição lavandaria) — Select de lavandaria atribuída. */}
            <div className="space-y-1.5">
              <label htmlFor="manual-fornecedor" className="text-sm font-medium">
                Lavandaria Atribuída (opcional)
              </label>
              <select
                id="manual-fornecedor"
                value={manualForm.fornecedor_id}
                onChange={(e) =>
                  setManualForm((f) => ({ ...f, fornecedor_id: e.target.value }))
                }
                className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Nenhuma (sem lavandaria)</option>
                {fornecedoresList.map((f) => (
                  <option key={f._id} value={f._id}>{f.nome}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Atribui uma lavandaria a esta propriedade. O fornecedor só vê as
                tarefas das propriedades que lhe estão atribuídas.
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="manual-tempo"
                className="text-sm font-medium"
              >
                Tempo de Limpeza (minutos)
              </label>
              <Input
                id="manual-tempo"
                type="number"
                min={0}
                value={manualForm.tempo_limpeza_minutos}
                onChange={(e) =>
                  setManualForm((f) => ({
                    ...f,
                    tempo_limpeza_minutos: e.target.value,
                  }))
                }
                placeholder="45"
              />
            </div>

            {/* Tipologia e cliente particular: definem as pessoas por defeito (particular ou T2+ = 2). */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="manual-tipologia" className="text-sm font-medium">Tipologia</label>
                <select
                  id="manual-tipologia"
                  value={manualForm.tipologia}
                  onChange={(e) => setManualForm((f) => comRegraPessoas(f, { tipologia: e.target.value }))}
                  className="flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {TIPOLOGIAS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 self-end text-sm md:min-h-9">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={manualForm.cliente_particular}
                  onChange={(e) => setManualForm((f) => comRegraPessoas(f, { cliente_particular: e.target.checked }))}
                />
                Cliente particular
              </label>
            </div>

            {/* HF21 — Staff Necessário */}
            <div className="space-y-1.5">
              <label
                htmlFor="manual-staff"
                className="text-sm font-medium leading-none"
              >
                Nº de Staff Necessário
              </label>
              <Input
                id="manual-staff"
                type="number"
                min={1}
                max={10}
                value={manualForm.staff_necessario}
                onChange={(e) =>
                  setManualForm((f) => ({
                    ...f,
                    staff_necessario: e.target.value,
                  }))
                }
                placeholder="1"
              />
              <p className="text-xs text-muted-foreground">
                Cliente particular ou T2 ou maior: 2 por defeito. Se &gt; 1, o sistema atribui uma equipa a esta propriedade.
              </p>
            </div>

            {/* FIX (lotação máxima) — Capacidade Máxima / Lotação da casa. */}
            <div className="space-y-1.5">
              <label
                htmlFor="manual-capacidade"
                className="text-sm font-medium leading-none"
              >
                Capacidade Máxima / Lotação
              </label>
              <Input
                id="manual-capacidade"
                type="number"
                min={0}
                value={manualForm.capacidade_hospedes}
                onChange={(e) =>
                  setManualForm((f) => ({
                    ...f,
                    capacidade_hospedes: e.target.value,
                  }))
                }
                placeholder="Ex.: 4"
              />
              <p className="text-xs text-muted-foreground">
                Nº máximo de hóspedes da casa. Usado como fallback quando o
                Smoobu não envia o nº de hóspedes da reserva.
              </p>
            </div>

            {/* HF22 — Dias Fixos de Limpeza (checkboxes) */}
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">
                Dias Fixos de Limpeza (opcional)
              </label>
              <p className="text-xs text-muted-foreground">
                Seleciona os dias da semana em que esta propriedade deve ser
                limpa automaticamente. O sistema cria as tarefas de madrugada.
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  { dia: 1, label: "Seg" },
                  { dia: 2, label: "Ter" },
                  { dia: 3, label: "Qua" },
                  { dia: 4, label: "Qui" },
                  { dia: 5, label: "Sex" },
                  { dia: 6, label: "Sáb" },
                  { dia: 0, label: "Dom" },
                ].map(({ dia, label }) => {
                  const checked = manualForm.dias_fixos_limpeza.includes(dia);
                  return (
                    <label
                      key={dia}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        checked
                          ? "border-primary bg-primary/10 text-brand-text"
                          : "border-input text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setManualForm((f) => ({
                            ...f,
                            dias_fixos_limpeza: e.target.checked
                              ? [...f.dias_fixos_limpeza, dia].sort()
                              : f.dias_fixos_limpeza.filter((d) => d !== dia),
                          }));
                        }}
                        className="h-3.5 w-3.5"
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            </div>

            {manualErro && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {manualErro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setManualOpen(false)}
              disabled={manualSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={manualSubmitting}>
              {manualSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A criar…
                </>
              ) : (
                <>
                  <Building2 className="mr-2 h-4 w-4" />
                  Criar
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Modal de Edição (componente próprio: separadores Essencial / Operação / Limpezas) */}
      <EditarPropriedadeDialog
        aberto={editando !== null}
        nomeAtual={editando?.nome ?? ""}
        ativa={editando?.ativo !== false}
        localizada={
          editando?.coordenadas && editando.coordenadas.lat != null && editando.coordenadas.lng != null
            ? { lat: editando.coordenadas.lat, lng: editando.coordenadas.lng }
            : null
        }
        form={editForm}
        setForm={setEditForm as unknown as (fn: (f: EditarPropriedadeForm) => EditarPropriedadeForm) => void}
        parceiros={parceirosList}
        fornecedores={fornecedoresList}
        staff={staffList}
        modelos={modelosChecklist}
        modelosA={modelosChecklistLoading}
        onModeloChange={handleModeloChecklistChange}
        tiposConfig={TIPOS_CONFIG}
        moradaAviso={editMoradaWarning}
        onMoradaMudou={() => {
          setEditMoradaWarning(null);
          setEditMoradaConfirmada(false);
        }}
        erro={editErro}
        a={editSubmitting}
        onSubmit={handleEditar}
        onClose={() => {
          setEditando(null);
          setEditMoradaWarning(null);
          setEditMoradaConfirmada(false);
        }}
      />

      {/* FIX (hard-delete para admin) — Dialog de confirmação de hard-delete. */}
      <Dialog open={eliminandoProp !== null} onOpenChange={(o) => !o && setEliminandoProp(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Eliminar definitivamente
          </DialogTitle>
          <DialogDescription>
            Tens a certeza que queres eliminar definitivamente a propriedade{" "}
            <strong>{eliminandoProp?.nome}</strong>?
          </DialogDescription>
          <DialogClose onClick={() => setEliminandoProp(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">⚠️ Ação irreversível!</p>
            <p className="mt-1 text-muted-foreground">
              Esta operação apaga permanentemente a propriedade da base de dados
              e <strong>todas as tarefas futuras</strong> a ela associadas
              (não concluídas/canceladas). As tarefas concluídas e canceladas
              são preservadas para auditoria.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Se só quiseres desativar a propriedade (preservando os dados),
              usa o botão &quot;Desativar&quot; (Power) em vez deste.
            </p>
          </div>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setEliminandoProp(null)}
            disabled={eliminandoSubmitting}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleEliminarDefinitivamente}
            disabled={eliminandoSubmitting}
          >
            {eliminandoSubmitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A eliminar…</>
            ) : (
              <><Trash2 className="mr-2 h-4 w-4" />Sim, eliminar definitivamente</>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
