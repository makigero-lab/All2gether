"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Building2, Loader2, AlertCircle, RefreshCw, Power, Pencil, Download, CheckCircle2, ListChecks } from "lucide-react";

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
  adminGet,
  adminPost,
  adminPatch,
  adminPut,
  type PropriedadeDTO,
  type UtilizadorDTO,
  type ModeloChecklistDTO,
} from "@/lib/api";

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
    setSincronizacaoOk(null);
    try {
      const res = await adminPatch<{
        ativo: boolean;
        tarefasDesatribuidas?: number;
      }>(`/api/gestor/propriedades/${p._id}/estado`);

      // Feedback (Prompt 97): se a propriedade foi desativada e houve
      // tarefas futuras desatribuídas (passaram a 'por_atribuir'), informa.
      if (!novoEstado && typeof res?.tarefasDesatribuidas === "number") {
        const n = res.tarefasDesatribuidas;
        setSincronizacaoOk(
          n > 0
            ? `Propriedade desativada. ${n} tarefa(s) futura(s) não concluída(s) foram desatribuída(s) (por atribuir).`
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

  // Estado da sincronização de propriedades do Smoobu (importação em massa).
  const [sincronizando, setSincronizando] = useState(false);
  const [sincronizacaoOk, setSincronizacaoOk] = useState<string | null>(null);
  // Prompt 117 — Aviso de geocoding INLINE (junto ao campo morada, não toast global).
  // String preenchida quando o Nominatim falha ao georreferenciar a morada.
  const [moradaWarning, setMoradaWarning] = useState<string | null>(null);
  // Aviso inline do modal de edição (morada editada não georreferenciada).
  const [editMoradaWarning, setEditMoradaWarning] = useState<string | null>(null);
  // Prompt 126 — Confirmação explícita de morada inválida (GPS não encontrado).
  // Depois do 1º submit com warning, o botão muda para "Confirmar Morada Inválida"
  // e é necessário um 2º clique para confirmar.
  const [moradaConfirmada, setMoradaConfirmada] = useState(false);
  const [editMoradaConfirmada, setEditMoradaConfirmada] = useState(false);

  /**
   * Importa/atualiza propriedades do Smoobu (scoped por empresa).
   * Cria as novas e atualiza SEMPRE a morada + capacidade das existentes
   * (alinhado com sincronizarPropriedades do Prompt 92).
   */
  async function handleImportarPropriedades() {
    setSincronizando(true);
    setSincronizacaoOk(null);
    setErro(null);
    try {
      const res = await adminPost<{
        totalRecebidas: number;
        criadas: number;
        existentes: number;
        erros: number;
      }>("/api/gestor/smoobu/propriedades", {});

      let msg = `${res.criadas} propriedade(s) importada(s) com sucesso!`;
      if (res.existentes > 0) msg += ` ${res.existentes} já existiam.`;
      if (res.erros > 0) msg += ` ${res.erros} com erro.`;
      setSincronizacaoOk(msg);

      await carregar();
    } catch (e) {
      setErro(
        e instanceof Error
          ? `Importação falhou: ${e.message}`
          : "Erro ao importar propriedades do Smoobu."
      );
    } finally {
      setSincronizando(false);
    }
  }

  // Estado do modal de edição
  const [editando, setEditando] = useState<PropriedadeDTO | null>(null);
  const [editForm, setEditForm] = useState({
    nome: "",
    smoobu_id: "",
    morada: "",
    tempo_limpeza_minutos: "45",
    checklist: "",
    funcionario_preferencial_id: "",
    modelo_checklist_id: "",
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

  async function handleAplicarChecklistPadrao() {
    if (!confirm(
      "Isto vai SUBSTITUIR o checklist de TODAS as propriedades pelo padrão " +
      "(Esvaziar lixo, Trocar roupa da cama, Trocar Toalhas, Limpar chão, " +
      "Limpar vidros, Limpar pó). Continuar?"
    )) {
      return;
    }
    setChecklistLoading(true);
    setErro(null);
    setSincronizacaoOk(null);
    try {
      const res = await adminPost<{ message: string; modificadas: number }>(
        "/api/gestor/propriedades/default-checklist",
        {}
      );
      setSincronizacaoOk(res.message || `Checklist aplicada a ${res.modificadas} propriedade(s).`);
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
  useEffect(() => {
    (async () => {
      try {
        const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
          "/api/gestor/equipa"
        );
        // Só interessa staff ativo (o backend valida isto ao gravar).
        setStaffList(
          (data.utilizadores ?? []).filter(
            (u) => u.role === "staff" && u.ativo
          )
        );
      } catch {
        // Silencioso — o select aparece vazio mas não bloqueia a edição.
      }
    })();
  }, []);

  /** Abre o modal de edição com os dados atuais da propriedade. */
  function abrirEdicao(p: PropriedadeDTO) {
    setEditando(p);
    setEditForm({
      nome: p.nome,
      smoobu_id: p.smoobu_id,
      morada: p.morada ?? "",
      tempo_limpeza_minutos: String(p.tempo_limpeza_minutos ?? 45),
      checklist: (p.checklist ?? []).join("\n"),
      funcionario_preferencial_id: p.funcionario_preferencial_id ?? "",
      // Prompt 134 — Modelo de Checklist associado (string vazia = Nenhum).
      modelo_checklist_id: p.modelo_checklist_id ?? "",
    });
    setEditErro(null);
    // Prompt 126 — Reset dos avisos de morada ao abrir o modal.
    setEditMoradaWarning(null);
    setEditMoradaConfirmada(false);
    // Prompt 134 — Carrega os modelos de checklist para o select.
    carregarModelosChecklist();
  }

  /** Submete a edição da propriedade. */
  async function handleEditar(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    setEditErro(null);

    if (!editForm.nome.trim() || !editForm.morada.trim()) {
      setEditErro("Nome e Morada são obrigatórios.");
      return;
    }

    const tempo = Number(editForm.tempo_limpeza_minutos);
    if (Number.isNaN(tempo) || tempo < 0) {
      setEditErro("Tempo de Limpeza deve ser um número maior ou igual a 0.");
      return;
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
      const res = await adminPut<{ propriedade: PropriedadeDTO; warning?: string }>(
        `/api/gestor/propriedades/${editando._id}`,
        {
          nome: editForm.nome.trim(),
          morada: editForm.morada.trim(),
          tempo_limpeza_minutos: tempo,
          checklist: editForm.checklist
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          // Prompt 95 — Funcionário preferencial (Algoritmo VIP). String vazia
          // → null no backend (remove o preferencial).
          funcionario_preferencial_id:
            editForm.funcionario_preferencial_id.trim() || null,
          // Prompt 134 — Modelo de Checklist associado. String vazia → null
          // (sem modelo / usa checklist flat antigo).
          modelo_checklist_id:
            editForm.modelo_checklist_id.trim() || null,
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

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="outline"
            onClick={handleImportarPropriedades}
            disabled={sincronizando}
            title="Importa apartamentos do Smoobu para a tua empresa. Morada fica 'A definir' para preencher depois."
          >
            {sincronizando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {sincronizando ? "A importar…" : "Importar do Smoobu"}
            </span>
          </Button>
          {/* Prompt 113 — Aplicar checklist padrão a todas as propriedades */}
          <Button
            variant="outline"
            onClick={handleAplicarChecklistPadrao}
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
          <Button onClick={() => {
            setMostrarForm((v) => !v);
            setMoradaWarning(null);
            setMoradaConfirmada(false);
          }}>
            <Plus className="h-4 w-4" />
            Nova Propriedade
          </Button>
        </div>
      </div>

      {/* Formulário inline de criação */}
      {mostrarForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5 text-primary" />
              Nova Propriedade
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
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                    Morada Completa
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
      {sincronizacaoOk && (
        <Card className="border-emerald-500/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span>{sincronizacaoOk}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSincronizacaoOk(null)}
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
          ) : propriedades.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Building2 className="h-10 w-10 opacity-40" />
              <p className="text-sm">Ainda não há propriedades.</p>
              <p className="text-xs">
                Clica em “Nova Propriedade” para adicionar a primeira.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
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
                  {propriedades.map((p) => (
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
                          {p.morada === "A definir" && (
                            <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 hover:bg-amber-500/20">
                              ⚠️ Morada por definir
                            </Badge>
                          )}
                        </div>
                        {p.morada && p.morada !== "A definir" && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {p.morada}
                          </div>
                        )}
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

      {/* Modal de Edição */}
      <Dialog
        open={editando !== null}
        onOpenChange={(o) => !o && setEditando(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle>Editar Propriedade</DialogTitle>
            <DialogDescription>
              Atualiza os dados da propriedade. Se mudares a morada, as
              coordenadas são re-calculadas automaticamente (para o load
              balancer de rotas).
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setEditando(null)} />
        </DialogHeader>
        <form onSubmit={handleEditar}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="edit-nome" className="text-sm font-medium">
                Nome
              </label>
              <Input
                id="edit-nome"
                value={editForm.nome}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, nome: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-smoobu" className="text-sm font-medium">
                Smoobu ID
              </label>
              <Input
                id="edit-smoobu"
                value={editForm.smoobu_id}
                readOnly
                tabIndex={-1}
                className="font-mono text-xs bg-muted/50 text-muted-foreground cursor-not-allowed"
              />
              <p className="text-xs text-muted-foreground">
                O Smoobu ID não é editável (é o identificador do apartamento no Smoobu).
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-morada" className="text-sm font-medium">
                Morada
              </label>
              <Input
                id="edit-morada"
                value={editForm.morada}
                onChange={(e) => {
                  setEditForm((f) => ({ ...f, morada: e.target.value }));
                  setEditMoradaWarning(null);
                  // Prompt 126 — Reset da confirmação quando a morada muda.
                  setEditMoradaConfirmada(false);
                }}
                required
              />
              {/* Prompt 117 — Aviso de geocoding INLINE no modal de edição */}
              {editMoradaWarning && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{editMoradaWarning}</span>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="edit-tempo"
                className="text-sm font-medium"
              >
                Tempo de Limpeza (minutos)
              </label>
              <Input
                id="edit-tempo"
                type="number"
                min={0}
                value={editForm.tempo_limpeza_minutos}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    tempo_limpeza_minutos: e.target.value,
                  }))
                }
                required
              />
            </div>

            {/* Checklist de Limpeza (edição) */}
            <div className="space-y-1.5">
              <label htmlFor="edit-checklist" className="text-sm font-medium">
                Checklist de Limpeza (um item por linha)
              </label>
              <textarea
                id="edit-checklist"
                value={editForm.checklist}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, checklist: e.target.value }))
                }
                rows={4}
                placeholder={"Verificar toalhas\nEsvaziar lixo\nTrocar roupa de cama"}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                O staff verá estes itens ao concluir a tarefa de limpeza desta propriedade.
              </p>
            </div>

            {/* Prompt 95 — Funcionário Preferencial (Algoritmo VIP) */}
            <div className="space-y-1.5">
              <label
                htmlFor="edit-preferencial"
                className="text-sm font-medium"
              >
                Funcionário Preferencial
              </label>
              <select
                id="edit-preferencial"
                value={editForm.funcionario_preferencial_id}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    funcionario_preferencial_id: e.target.value,
                  }))
                }
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Nenhum (usar load balancer geral)</option>
                {staffList.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.nome}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Quando definido, o motor de atribuição dá prioridade a este
                funcionário para limpezas desta propriedade (se estiver
                disponível e dentro do limite de 8h/dia).
              </p>
            </div>

            {/* Prompt 134 — Modelo de Checklist (template dinâmico) */}
            <div className="space-y-1.5">
              <label
                htmlFor="edit-modelo-checklist"
                className="text-sm font-medium"
              >
                Modelo de Checklist
              </label>
              <select
                id="edit-modelo-checklist"
                value={editForm.modelo_checklist_id}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    modelo_checklist_id: e.target.value,
                  }))
                }
                disabled={modelosChecklistLoading}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              >
                <option value="">Nenhum (usar checklist simples abaixo)</option>
                {modelosChecklist.map((m) => (
                  <option key={m._id} value={m._id}>
                    {m.nome}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {modelosChecklistLoading
                  ? "A carregar modelos…"
                  : "Quando definido, as novas tarefas de limpeza usam as secções e itens do modelo (snapshot). Gerir modelos em Checklists."}
              </p>
            </div>

            {editErro && (
              <p className="text-sm text-destructive">{editErro}</p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditando(null);
                setEditMoradaWarning(null);
                setEditMoradaConfirmada(false);
              }}
              disabled={editSubmitting}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={editSubmitting}
              variant={editMoradaWarning ? "outline" : "default"}
              className={editMoradaWarning ? "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/50 dark:hover:bg-amber-500/10" : ""}
            >
              {editSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A guardar…
                </>
              ) : editMoradaWarning ? (
                "Confirmar Morada Inválida"
              ) : (
                "Guardar alterações"
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
