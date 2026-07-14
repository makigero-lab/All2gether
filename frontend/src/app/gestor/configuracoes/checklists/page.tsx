"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ListChecks,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  RefreshCw,
  X,
  GripVertical,
  FileText,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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
  adminPut,
  adminDelete,
  type ModeloChecklistDTO,
} from "@/lib/api";

/**
 * Prompt 134 — Página de Modelos de Checklist (gestor).
 *
 * Lista todos os modelos da empresa (GET /api/gestor/checklists) e permite
 * criar/editar/apagar via Dialog. Cada modelo tem nome + descrição + secções
 * (cada secção tem nome + items de texto).
 *
 * Os modelos são depois associados às Propriedades (campo modelo_checklist_id)
 * e quando uma tarefa de limpeza é criada o backend copia (snapshot) as
 * secções/items para `checklist_dinamica` da tarefa.
 */

interface SeccaoForm {
  nome: string;
  items: string[];
}

interface ModeloFormState {
  nome: string;
  descricao: string;
  seccoes: SeccaoForm[];
}

const FORM_VAZIO: ModeloFormState = {
  nome: "",
  descricao: "",
  seccoes: [{ nome: "", items: [""] }],
};

export default function ChecklistsPage() {
  const [modelos, setModelos] = useState<ModeloChecklistDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Estado do Dialog (criar/editar)
  const [dialogAberto, setDialogAberto] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState<ModeloFormState>(FORM_VAZIO);
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);

  // Estado do Dialog de confirmação de apagar
  const [apagarId, setApagarId] = useState<string | null>(null);
  const [apagarNome, setApagarNome] = useState<string>("");
  const [apagando, setApagando] = useState(false);

  /** Carrega os modelos da empresa. */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const data = await adminGet<{ modelos: ModeloChecklistDTO[] }>(
        "/api/gestor/checklists"
      );
      setModelos(data.modelos ?? []);
    } catch (e) {
      setErro(
        e instanceof Error ? e.message : "Erro ao carregar modelos de checklist."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Abre o Dialog para criar um novo modelo. */
  function abrirNovo() {
    setEditandoId(null);
    setForm(FORM_VAZIO);
    setFormErro(null);
    setDialogAberto(true);
  }

  /** Abre o Dialog para editar um modelo existente (pré-preenchido). */
  function abrirEditar(m: ModeloChecklistDTO) {
    setEditandoId(m._id);
    setForm({
      nome: m.nome ?? "",
      descricao: m.descricao ?? "",
      // Garante que há pelo menos uma secção com um item vazio para edição.
      seccoes:
        m.seccoes && m.seccoes.length > 0
          ? m.seccoes.map((s) => ({
              nome: s.nome ?? "",
              items: s.items && s.items.length > 0 ? [...s.items] : [""],
            }))
          : [{ nome: "", items: [""] }],
    });
    setFormErro(null);
    setDialogAberto(true);
  }

  /** Adiciona uma nova secção ao formulário. */
  function adicionarSeccao() {
    setForm((f) => ({
      ...f,
      seccoes: [...f.seccoes, { nome: "", items: [""] }],
    }));
  }

  /** Remove uma secção do formulário. */
  function removerSeccao(idx: number) {
    setForm((f) => ({
      ...f,
      seccoes: f.seccoes.filter((_, i) => i !== idx),
    }));
  }

  /** Atualiza o nome de uma secção. */
  function atualizarNomeSeccao(idx: number, nome: string) {
    setForm((f) => ({
      ...f,
      seccoes: f.seccoes.map((s, i) => (i === idx ? { ...s, nome } : s)),
    }));
  }

  /** Adiciona um item a uma secção. */
  function adicionarItem(secIdx: number) {
    setForm((f) => ({
      ...f,
      seccoes: f.seccoes.map((s, i) =>
        i === secIdx ? { ...s, items: [...s.items, ""] } : s
      ),
    }));
  }

  /** Remove um item de uma secção. */
  function removerItem(secIdx: number, itemIdx: number) {
    setForm((f) => ({
      ...f,
      seccoes: f.seccoes.map((s, i) =>
        i === secIdx
          ? { ...s, items: s.items.filter((_, j) => j !== itemIdx) }
          : s
      ),
    }));
  }

  /** Atualiza o texto de um item. */
  function atualizarItem(secIdx: number, itemIdx: number, texto: string) {
    setForm((f) => ({
      ...f,
      seccoes: f.seccoes.map((s, i) =>
        i === secIdx
          ? {
              ...s,
              items: s.items.map((it, j) => (j === itemIdx ? texto : it)),
            }
          : s
      ),
    }));
  }

  /** Submete o formulário (POST para criar, PUT para atualizar). */
  async function handleSubmeter(e: React.FormEvent) {
    e.preventDefault();
    setFormErro(null);

    if (!form.nome.trim()) {
      setFormErro("O Nome é obrigatório.");
      return;
    }

    // Limpa espaços e filtra secções/items vazios.
    const seccoesLimpar = form.seccoes
      .map((s) => ({
        nome: s.nome.trim(),
        items: s.items.map((i) => i.trim()).filter(Boolean),
      }))
      .filter((s) => s.nome.length > 0 || s.items.length > 0);

    // Validação: cada secção deve ter nome e pelo menos um item.
    for (const s of seccoesLimpar) {
      if (!s.nome) {
        setFormErro("Todas as secções precisam de um nome.");
        return;
      }
      if (s.items.length === 0) {
        setFormErro(`A secção "${s.nome}" precisa de pelo menos um item.`);
        return;
      }
    }

    if (seccoesLimpar.length === 0) {
      setFormErro("Adiciona pelo menos uma secção com itens.");
      return;
    }

    setSubmitting(true);
    try {
      const body = {
        nome: form.nome.trim(),
        descricao: form.descricao.trim(),
        seccoes: seccoesLimpar,
      };
      if (editandoId) {
        await adminPut<{ modelo: ModeloChecklistDTO }>(
          `/api/gestor/checklists/${editandoId}`,
          body
        );
      } else {
        await adminPost<{ modelo: ModeloChecklistDTO }>(
          "/api/gestor/checklists",
          body
        );
      }
      setDialogAberto(false);
      setEditandoId(null);
      setForm(FORM_VAZIO);
      await carregar();
    } catch (e) {
      setFormErro(
        e instanceof Error ? e.message : "Erro ao guardar o modelo."
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** Abre o dialog de confirmação de apagar. */
  function abrirApagar(m: ModeloChecklistDTO) {
    setApagarId(m._id);
    setApagarNome(m.nome);
  }

  /** Confirma o apagar. */
  async function handleApagar() {
    if (!apagarId) return;
    setApagando(true);
    try {
      await adminDelete(`/api/gestor/checklists/${apagarId}`);
      setApagarId(null);
      setApagarNome("");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao apagar modelo.");
    } finally {
      setApagando(false);
    }
  }

  /** Conta o total de itens de um modelo (para o Badge). */
  function contarItens(m: ModeloChecklistDTO): number {
    return (m.seccoes ?? []).reduce(
      (acc, s) => acc + (s.items?.length ?? 0),
      0
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ListChecks className="h-6 w-6 text-primary" />
            Modelos de Checklist
          </h1>
          <p className="text-sm text-muted-foreground">
            Cria templates de checklists dinâmicas com secções e itens. Associa
            a cada propriedade o modelo adequado (ex.: Limpeza T2, Limpeza T0).
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
          <Button onClick={abrirNovo}>
            <Plus className="h-4 w-4" />
            Novo Modelo
          </Button>
        </div>
      </div>

      {/* Erro de carregamento */}
      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Não foi possível carregar os modelos.</p>
              <p className="text-xs opacity-80">{erro}</p>
            </div>
            <Button variant="outline" size="sm" onClick={carregar}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Lista de modelos */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar modelos…
        </div>
      ) : modelos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <ListChecks className="h-12 w-12 opacity-40" />
            <div>
              <p className="text-sm font-medium">Ainda não há modelos de checklist.</p>
              <p className="text-xs">
                Cria o primeiro modelo para o poder associar às propriedades.
              </p>
            </div>
            <Button onClick={abrirNovo} size="sm">
              <Plus className="h-4 w-4" />
              Criar primeiro modelo
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {modelos.map((m) => {
            const totalItens = contarItens(m);
            const totalSecoes = m.seccoes?.length ?? 0;
            return (
              <Card key={m._id} className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <FileText className="h-4 w-4 shrink-0 text-primary" />
                        <span className="truncate">{m.nome}</span>
                      </CardTitle>
                      {m.descricao && (
                        <CardDescription className="mt-1 line-clamp-2">
                          {m.descricao}
                        </CardDescription>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="text-[10px]">
                      {totalSecoes} secç{totalSecoes === 1 ? "ão" : "ões"}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {totalItens} item{totalItens === 1 ? "" : "ns"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-2">
                  {(m.seccoes ?? []).slice(0, 3).map((s, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-border/60 bg-muted/30 p-2"
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {s.nome}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {(s.items ?? []).join(" · ")}
                      </p>
                    </div>
                  ))}
                  {(m.seccoes?.length ?? 0) > 3 && (
                    <p className="text-[11px] text-muted-foreground">
                      +{(m.seccoes?.length ?? 0) - 3} secç
                      {((m.seccoes?.length ?? 0) - 3) === 1 ? "ão" : "ões"}…
                    </p>
                  )}

                  <div className="flex items-center justify-end gap-1 pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => abrirEditar(m)}
                      className="h-8 gap-1.5"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => abrirApagar(m)}
                      className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Apagar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Dialog Criar/Editar Modelo */}
      <Dialog
        open={dialogAberto}
        onOpenChange={(o) => {
          setDialogAberto(o);
          if (!o) {
            setEditandoId(null);
            setFormErro(null);
          }
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="h-5 w-5 text-primary" />
              {editandoId ? "Editar Modelo de Checklist" : "Novo Modelo de Checklist"}
            </DialogTitle>
            <DialogDescription>
              Define as secções e os itens que o staff verá ao concluir a
              tarefa de limpeza.
            </DialogDescription>
          </div>
          <DialogClose
            onClick={() => {
              setDialogAberto(false);
              setEditandoId(null);
            }}
          />
        </DialogHeader>
        <form onSubmit={handleSubmeter}>
          <DialogContent className="max-h-[80vh] space-y-4 overflow-y-auto">
            {/* Nome + Descrição */}
            <div className="space-y-1.5">
              <label htmlFor="modelo-nome" className="text-sm font-medium">
                Nome
              </label>
              <Input
                id="modelo-nome"
                value={form.nome}
                onChange={(e) =>
                  setForm((f) => ({ ...f, nome: e.target.value }))
                }
                placeholder="Ex.: Limpeza T2"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="modelo-descricao" className="text-sm font-medium">
                Descrição <span className="text-muted-foreground">(opcional)</span>
              </label>
              <Input
                id="modelo-descricao"
                value={form.descricao}
                onChange={(e) =>
                  setForm((f) => ({ ...f, descricao: e.target.value }))
                }
                placeholder="Ex.: Modelo standard para apartamentos T2"
              />
            </div>

            {/* Secções dinâmicas */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Secções</span>
                <Badge variant="outline" className="text-[10px]">
                  {form.seccoes.length} secç{form.seccoes.length === 1 ? "ão" : "ões"}
                </Badge>
              </div>

              {form.seccoes.map((sec, secIdx) => (
                <div
                  key={secIdx}
                  className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3"
                >
                  <div className="flex items-center gap-2">
                    <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                    <Input
                      value={sec.nome}
                      onChange={(e) =>
                        atualizarNomeSeccao(secIdx, e.target.value)
                      }
                      placeholder="Nome da secção (ex.: Quartos)"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => removerSeccao(secIdx)}
                      disabled={form.seccoes.length === 1}
                      aria-label="Remover secção"
                      title="Remover Secção"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Items da secção */}
                  <div className="space-y-1.5 pl-6">
                    {sec.items.map((item, itemIdx) => (
                      <div key={itemIdx} className="flex items-center gap-2">
                        <Input
                          value={item}
                          onChange={(e) =>
                            atualizarItem(secIdx, itemIdx, e.target.value)
                          }
                          placeholder={`Item ${itemIdx + 1} (ex.: Mudar lençóis)`}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removerItem(secIdx, itemIdx)}
                          disabled={sec.items.length === 1}
                          aria-label="Remover item"
                          title="Remover Item"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => adicionarItem(secIdx)}
                      className="h-7 gap-1 text-xs"
                    >
                      <Plus className="h-3 w-3" />
                      Adicionar Item
                    </Button>
                  </div>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={adicionarSeccao}
                className="gap-1.5"
              >
                <Plus className="h-4 w-4" />
                Adicionar Secção
              </Button>
            </div>

            {formErro && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {formErro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialogAberto(false);
                setEditandoId(null);
              }}
              disabled={submitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A guardar…
                </>
              ) : (
                "Guardar"
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Dialog Confirmação Apagar */}
      <Dialog
        open={apagarId !== null}
        onOpenChange={(o) => {
          if (!o) {
            setApagarId(null);
            setApagarNome("");
          }
        }}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Apagar Modelo
            </DialogTitle>
            <DialogDescription>
              Tens a certeza que queres apagar o modelo{" "}
              <strong>&quot;{apagarNome}&quot;</strong>?
              <br />
              Esta ação não pode ser desfeita. As propriedades associadas ficam
              sem modelo (mas as tarefas antigas mantêm o snapshot).
            </DialogDescription>
          </div>
          <DialogClose
            onClick={() => {
              setApagarId(null);
              setApagarNome("");
            }}
          />
        </DialogHeader>
        <DialogContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Confirma a eliminação permanente deste modelo.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setApagarId(null);
              setApagarNome("");
            }}
            disabled={apagando}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleApagar}
            disabled={apagando}
          >
            {apagando ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                A apagar…
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Apagar Modelo
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
