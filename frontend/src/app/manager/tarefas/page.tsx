"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  ClipboardList,
  Loader2,
  AlertCircle,
  RefreshCw,
  UserCheck,
  SprayCan,
  Download,
  CheckCircle2,
} from "lucide-react";

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
  type PropriedadeDTO,
  type UtilizadorDTO,
} from "@/lib/api";
import { PaginationBar } from "@/components/admin/pagination-bar";

/**
 * Página de Tarefas — Painel do Gestor (/manager/tarefas).
 *
 * Consome a mesma API do admin (GET/POST/PATCH /api/gestor/tarefas).
 */
interface TarefaAdmin {
  _id: string;
  propriedade_id?: { nome: string } | null;
  utilizador_id?: { nome: string } | null;
  data: string;
  tipo: string;
  estado: string;
  tempo_limpeza_minutos: number;
}

const ESTADO_LABEL: Record<string, string> = {
  por_atribuir: "Por atribuir",
  atribuida: "Atribuída",
  em_curso: "Em curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

const ESTADO_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  por_atribuir: "warning",
  atribuida: "default",
  em_curso: "secondary",
  concluida: "success",
  cancelada: "outline",
};

function formatarData(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function ManagerTarefasPage() {
  const [tarefas, setTarefas] = useState<TarefaAdmin[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [staff, setStaff] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Paginação client-side.
  const [pagina, setPagina] = useState(1);
  const [tamPagina, setTamPagina] = useState(25);
  const totalPaginas = Math.max(1, Math.ceil(tarefas.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const tarefasPagina = tarefas.slice(
    (paginaSegura - 1) * tamPagina,
    paginaSegura * tamPagina
  );
  useEffect(() => {
    if (pagina > totalPaginas) setPagina(totalPaginas);
  }, [pagina, totalPaginas]);

  // Formulário de criação
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form, setForm] = useState({
    propriedade_id: "",
    utilizador_id: "",
    data: "",
    tempo_limpeza_minutos: "45",
    tipo: "limpeza",
  });
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);

  // Modal de atribuição
  const [atribuindo, setAtribuindo] = useState<TarefaAdmin | null>(null);
  const [atribuirUserId, setAtribuirUserId] = useState("");
  const [atribuirSubmitting, setAtribuirSubmitting] = useState(false);

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
        (equipaRes.utilizadores ?? []).filter(
          (u) => u.role === "staff" || u.role === "gestor"
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

    setSubmitting(true);
    try {
      await adminPost("/api/gestor/tarefas", {
        propriedade_id: form.propriedade_id,
        utilizador_id: form.utilizador_id || null,
        data: form.data,
        tempo_limpeza_minutos: Number(form.tempo_limpeza_minutos) || 45,
        tipo: form.tipo,
      });
      setForm({ propriedade_id: "", utilizador_id: "", data: "", tempo_limpeza_minutos: "45", tipo: "limpeza" });
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
      await adminPatch(`/api/gestor/tarefas/${atribuindo._id}/atribuir`, {
        utilizador_id: atribuirUserId,
      });
      setAtribuindo(null);
      setAtribuirUserId("");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao atribuir tarefa.");
    } finally {
      setAtribuirSubmitting(false);
    }
  }

  async function handleCancelar(t: TarefaAdmin) {
    try {
      await adminPatch(`/api/gestor/tarefas/${t._id}/estado`, { estado: "cancelada" });
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao cancelar tarefa.");
    }
  }

  // Estado da sincronização Smoobu (pull de reservas futuras via REST API).
  const [sincronizando, setSincronizando] = useState(false);
  const [sincronizacaoOk, setSincronizacaoOk] = useState<string | null>(null);

  /** Sincroniza reservas futuras do Smoobu e recarrega a grelha. */
  async function handleSincronizarSmoobu() {
    setSincronizando(true);
    setSincronizacaoOk(null);
    setErro(null);
    try {
      const res = await adminPost<{
        totalRecebidas: number;
        importadas: number;
        criadas: number;
        existentes: number;
        erros: number;
        detalheErros: { reservaId: string | null; erro: string }[];
      }>("/api/gestor/smoobu/sincronizar", {});

      let msg = `Sincronização concluída! ${res.criadas} tarefa(s) gerada(s)`;
      if (res.existentes > 0) msg += `, ${res.existentes} já existiam`;
      if (res.erros > 0) msg += `, ${res.erros} com erro`;
      msg += `.`;
      setSincronizacaoOk(msg);

      await carregar();
    } catch (e) {
      setErro(
        e instanceof Error
          ? `Sincronização falhou: ${e.message}`
          : "Erro ao sincronizar com o Smoobu."
      );
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">Tarefas</h1>
          <p className="text-sm text-muted-foreground">
            Gestão manual de tarefas de limpeza.
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
            onClick={handleSincronizarSmoobu}
            disabled={sincronizando}
            title="Vai buscar as reservas futuras ao Smoobu e cria as tarefas de limpeza. Idempotente — não cria duplicados."
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
            Nova Tarefa
          </Button>
        </div>
      </div>

      {/* Formulário de criação */}
      {mostrarForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SprayCan className="h-5 w-5 text-primary" />
              Nova Tarefa Manual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmeter} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                  <label className="text-sm font-medium">Funcionário (opcional)</label>
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
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Data</label>
                  <Input type="date" value={form.data} onChange={(e) => setForm((f) => ({ ...f, data: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Tempo (min)</label>
                  <Input type="number" min={0} value={form.tempo_limpeza_minutos} onChange={(e) => setForm((f) => ({ ...f, tempo_limpeza_minutos: e.target.value }))} />
                </div>
              </div>
              {formErro && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />{formErro}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />A guardar…</> : "Criar Tarefa"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setMostrarForm(false)} disabled={submitting}>Cancelar</Button>
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

      {/* Tabela */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />A carregar tarefas…
            </div>
          ) : tarefas.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <ClipboardList className="h-10 w-10 opacity-40" />
              <p className="text-sm">Sem tarefas.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Data</th>
                    <th className="px-4 py-3 font-medium">Propriedade</th>
                    <th className="px-4 py-3 font-medium">Funcionário</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tarefasPagina.map((t) => (
                    <tr key={t._id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">{formatarData(t.data)}</td>
                      <td className="px-4 py-3 font-medium">{t.propriedade_id?.nome ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{t.utilizador_id?.nome ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={ESTADO_VARIANT[t.estado] ?? "secondary"}>
                          {ESTADO_LABEL[t.estado] ?? t.estado}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {(t.estado === "por_atribuir" || t.estado === "atribuida") && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => { setAtribuindo(t); setAtribuirUserId(""); }}
                              aria-label="Atribuir"
                              title="Atribuir / Reatribuir"
                            >
                              <UserCheck className="h-4 w-4" />
                            </Button>
                          )}
                          {t.estado !== "cancelada" && t.estado !== "concluida" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => handleCancelar(t)}
                              aria-label="Cancelar tarefa"
                              title="Cancelar"
                            >
                              <AlertCircle className="h-4 w-4" />
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
          {/* Paginação */}
          {!loading && tarefas.length > 0 && (
            <PaginationBar
              page={paginaSegura}
              totalPages={totalPaginas}
              total={tarefas.length}
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
            <DialogTitle>Atribuir Tarefa</DialogTitle>
            <DialogDescription>
              {atribuindo?.propriedade_id?.nome} — {atribuindo ? formatarData(atribuindo.data) : ""}
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setAtribuindo(null)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Funcionário</label>
            <select
              value={atribuirUserId}
              onChange={(e) => setAtribuirUserId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Selecionar…</option>
              {staff.map((u) => (
                <option key={u._id} value={u._id}>{u.nome}</option>
              ))}
            </select>
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAtribuindo(null)} disabled={atribuirSubmitting}>Cancelar</Button>
          <Button onClick={handleAtribuir} disabled={!atribuirUserId || atribuirSubmitting}>
            {atribuirSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />A atribuir…</> : "Atribuir"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
