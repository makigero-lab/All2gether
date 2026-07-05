"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Building2, Loader2, AlertCircle, RefreshCw, Power, Pencil, Download, CheckCircle2 } from "lucide-react";

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

    setSubmitting(true);
    try {
      await adminPost("/api/gestor/propriedades", {
        nome: form.nome.trim(),
        smoobu_id: form.smoobu_id.trim(),
        morada: form.morada.trim(),
        tempo_limpeza_minutos: tempo,
        checklist: form.checklist
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      });
      // Limpa o formulário e atualiza a tabela automaticamente.
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
    // Otimismo: atualiza UI imediatamente.
    setPropriedades((prev) =>
      prev.map((x) => (x._id === p._id ? { ...x, ativo: !x.ativo } : x))
    );
    try {
      await adminPatch(`/api/gestor/propriedades/${p._id}/estado`);
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

  /** Importa em massa os apartamentos do Smoobu (upsert — não altera existentes). */
  async function handleSincronizarPropriedades() {
    setSincronizando(true);
    setSincronizacaoOk(null);
    setErro(null);
    try {
      const res = await adminPost<{
        totalRecebidas: number;
        criadas: number;
        existentes: number;
        erros: number;
      }>("/api/gestor/smoobu/sincronizar-propriedades", {});

      let msg = `Sincronização concluída! ${res.criadas} propriedade(s) importada(s)`;
      if (res.existentes > 0) msg += `, ${res.existentes} já existiam`;
      if (res.erros > 0) msg += `, ${res.erros} com erro`;
      msg += `.`;
      setSincronizacaoOk(msg);

      // Atualiza a tabela para mostrar as novas propriedades.
      await carregar();
    } catch (e) {
      setErro(
        e instanceof Error
          ? `Sincronização falhou: ${e.message}`
          : "Erro ao sincronizar propriedades com o Smoobu."
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
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErro, setEditErro] = useState<string | null>(null);

  /** Abre o modal de edição com os dados atuais da propriedade. */
  function abrirEdicao(p: PropriedadeDTO) {
    setEditando(p);
    setEditForm({
      nome: p.nome,
      smoobu_id: p.smoobu_id,
      morada: p.morada ?? "",
      tempo_limpeza_minutos: String(p.tempo_limpeza_minutos ?? 45),
      checklist: (p.checklist ?? []).join("\n"),
    });
    setEditErro(null);
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

    setEditSubmitting(true);
    try {
      const res = await adminPut<{ propriedade: PropriedadeDTO }>(
        `/api/gestor/propriedades/${editando._id}`,
        {
          nome: editForm.nome.trim(),
          morada: editForm.morada.trim(),
          tempo_limpeza_minutos: tempo,
          checklist: editForm.checklist
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      );
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
            onClick={handleSincronizarPropriedades}
            disabled={sincronizando}
            title="Importa todos os apartamentos do Smoobu de uma vez. Não altera as propriedades já existentes (preserva as tuas edições)."
          >
            {sincronizando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Sincronizar Smoobu</span>
          </Button>
          <Button onClick={() => setMostrarForm((v) => !v)}>
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
                    onChange={(e) =>
                      setForm((f) => ({ ...f, morada: e.target.value }))
                    }
                    placeholder="Ex.: Rua das Flores 12, Lisboa"
                    required
                  />
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
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      A guardar…
                    </>
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
                        <div className="font-medium">{p.nome}</div>
                        {p.morada && (
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
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, morada: e.target.value }))
                }
                required
              />
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

            {editErro && (
              <p className="text-sm text-destructive">{editErro}</p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditando(null)}
              disabled={editSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  A guardar…
                </>
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
