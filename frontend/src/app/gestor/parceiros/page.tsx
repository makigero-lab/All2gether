"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Handshake,
  Loader2,
  AlertCircle,
  RefreshCw,
  Pencil,
  Power,
  Eye,
  EyeOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
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
  adminPatch,
  type UtilizadorDTO,
} from "@/lib/api";

/**
 * Página de Gestão de Parceiros B2B — /gestor/parceiros
 *
 * FIX (gestão de parceiros) — Página dedicada para listar, criar, editar e
 * ativar/desativar utilizadores com role 'parceiro'. Estes utilizadores são
 * externos à equipa de limpezas (têm o seu portal próprio em /parceiro) e
 * não aparecem na página /gestor/equipa (que agora lista apenas staff/gestor).
 *
 * Reutiliza os mesmos endpoints da Equipa (POST/PUT/PATCH /api/gestor/equipa)
 * porque os parceiros são utilizadores com role 'parceiro'. A listagem usa
 * o endpoint dedicado GET /api/gestor/parceiros (filtra por role).
 *
 * Campos extra (vs. Equipa): nif + observacoes (para faturação e notas).
 */

export default function ParceirosPage() {
  const [parceiros, setParceiros] = useState<UtilizadorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Modal de criação.
  const [criarOpen, setCriarOpen] = useState(false);
  const [criarForm, setCriarForm] = useState({
    nome: "",
    email: "",
    password: "",
    telefone: "",
    nif: "",
    observacoes: "",
  });
  const [criarSubmitting, setCriarSubmitting] = useState(false);
  const [criarErro, setCriarErro] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // Modal de edição.
  const [editando, setEditando] = useState<UtilizadorDTO | null>(null);
  const [editForm, setEditForm] = useState({
    nome: "",
    email: "",
    password: "",
    telefone: "",
    nif: "",
    observacoes: "",
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErro, setEditErro] = useState<string | null>(null);
  const [showEditPassword, setShowEditPassword] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const data = await adminGet<{ utilizadores: UtilizadorDTO[] }>(
        "/api/gestor/parceiros"
      );
      setParceiros(data.utilizadores ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar parceiros.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleCriar(e: React.FormEvent) {
    e.preventDefault();
    setCriarErro(null);
    if (!criarForm.nome.trim() || !criarForm.email.trim() || !criarForm.password) {
      setCriarErro("Nome, Email e Password são obrigatórios.");
      return;
    }
    if (criarForm.password.length < 6) {
      setCriarErro("A password deve ter pelo menos 6 caracteres.");
      return;
    }
    setCriarSubmitting(true);
    try {
      await adminPost("/api/gestor/equipa", {
        nome: criarForm.nome.trim(),
        email: criarForm.email.trim(),
        password: criarForm.password,
        role: "parceiro",
        telefone: criarForm.telefone.trim() || undefined,
        nif: criarForm.nif.trim() || undefined,
        observacoes: criarForm.observacoes.trim() || undefined,
      });
      setCriarForm({ nome: "", email: "", password: "", telefone: "", nif: "", observacoes: "" });
      setCriarOpen(false);
      await carregar();
    } catch (e) {
      setCriarErro(e instanceof Error ? e.message : "Erro ao criar parceiro.");
    } finally {
      setCriarSubmitting(false);
    }
  }

  function abrirEdicao(p: UtilizadorDTO) {
    setEditando(p);
    setEditForm({
      nome: p.nome,
      email: p.email,
      password: "",
      telefone: p.telefone ?? "",
      nif: p.nif ?? "",
      observacoes: p.observacoes ?? "",
    });
    setEditErro(null);
    setShowEditPassword(false);
  }

  async function handleEditar(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    setEditErro(null);
    if (!editForm.nome.trim() || !editForm.email.trim()) {
      setEditErro("Nome e Email são obrigatórios.");
      return;
    }
    if (editForm.password && editForm.password.length < 6) {
      setEditErro("A password deve ter pelo menos 6 caracteres.");
      return;
    }
    setEditSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        nome: editForm.nome.trim(),
        email: editForm.email.trim(),
        telefone: editForm.telefone.trim(),
        nif: editForm.nif.trim(),
        observacoes: editForm.observacoes.trim(),
      };
      if (editForm.password) body.password = editForm.password;
      await adminPut(`/api/gestor/equipa/${editando._id}`, body);
      setEditando(null);
      await carregar();
    } catch (e) {
      setEditErro(e instanceof Error ? e.message : "Erro ao editar parceiro.");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleToggleAtivo(p: UtilizadorDTO) {
    // Optimistic UI.
    setParceiros((prev) =>
      prev.map((x) => (x._id === p._id ? { ...x, ativo: !x.ativo } : x))
    );
    try {
      await adminPatch(`/api/gestor/equipa/${p._id}/estado`, { ativo: !p.ativo });
    } catch (e) {
      // Reverte em caso de erro.
      setParceiros((prev) =>
        prev.map((x) => (x._id === p._id ? { ...x, ativo: p.ativo } : x))
      );
      setErro(e instanceof Error ? e.message : "Erro ao alterar estado.");
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="hidden flex-col gap-1 lg:flex">
          <h1 className="text-2xl font-bold tracking-tight">Parceiros</h1>
          <p className="text-sm text-muted-foreground">
            Gestão de parceiros B2B externos (criam reservas no portal /parceiro).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button onClick={() => { setCriarOpen(true); setCriarErro(null); }}>
            <Plus className="h-4 w-4" />
            Novo Parceiro
          </Button>
        </div>
      </div>

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

      {/* Tabela */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />A carregar parceiros…
            </div>
          ) : parceiros.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Handshake className="h-10 w-10 opacity-40" />
              <p className="text-sm">Ainda não há parceiros.</p>
              <p className="text-xs">Clica em "Novo Parceiro" para adicionar o primeiro.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Telefone</th>
                    <th className="px-4 py-3 font-medium">NIF</th>
                    <th className="px-4 py-3 font-medium">Observações</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parceiros.map((p) => (
                    <tr key={p._id} className={`hover:bg-muted/30 ${!p.ativo ? "opacity-60" : ""}`}>
                      <td className="px-4 py-3 font-medium">{p.nome}</td>
                      <td className="px-4 py-3 text-muted-foreground">{p.email}</td>
                      <td className="px-4 py-3 text-muted-foreground">{p.telefone || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{p.nif || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground max-w-xs truncate" title={p.observacoes}>
                        {p.observacoes || "—"}
                      </td>
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

      {/* Dialog de Criação */}
      <Dialog open={criarOpen} onOpenChange={setCriarOpen}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Handshake className="h-5 w-5 text-primary" />
            Novo Parceiro
          </DialogTitle>
          <DialogDescription>
            Cria um parceiro B2B. Ele terá acesso ao portal /parceiro para criar reservas.
          </DialogDescription>
          <DialogClose onClick={() => setCriarOpen(false)} />
        </DialogHeader>
        <form onSubmit={handleCriar}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="criar-nome" className="text-sm font-medium">
                Nome <span className="text-destructive">*</span>
              </label>
              <Input
                id="criar-nome"
                value={criarForm.nome}
                onChange={(e) => setCriarForm((f) => ({ ...f, nome: e.target.value }))}
                placeholder="Ex.: Sweet Apartments"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="criar-email" className="text-sm font-medium">
                Email <span className="text-destructive">*</span>
              </label>
              <Input
                id="criar-email"
                type="email"
                value={criarForm.email}
                onChange={(e) => setCriarForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="parceiro@empresa.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="criar-password" className="text-sm font-medium">
                Password <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <Input
                  id="criar-password"
                  type={showPassword ? "text" : "password"}
                  value={criarForm.password}
                  onChange={(e) => setCriarForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Mín. 6 caracteres"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Ocultar password" : "Mostrar password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="criar-telefone" className="text-sm font-medium">Telefone</label>
                <Input
                  id="criar-telefone"
                  type="tel"
                  value={criarForm.telefone}
                  onChange={(e) => setCriarForm((f) => ({ ...f, telefone: e.target.value }))}
                  placeholder="+351 912 345 678"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="criar-nif" className="text-sm font-medium">NIF</label>
                <Input
                  id="criar-nif"
                  value={criarForm.nif}
                  onChange={(e) => setCriarForm((f) => ({ ...f, nif: e.target.value }))}
                  placeholder="500000000"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="criar-observacoes" className="text-sm font-medium">Observações</label>
              <textarea
                id="criar-observacoes"
                value={criarForm.observacoes}
                onChange={(e) => setCriarForm((f) => ({ ...f, observacoes: e.target.value }))}
                rows={2}
                placeholder="Notas internas (ex: Parceiro desde 2024, desconto 10%)"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {criarErro && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {criarErro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCriarOpen(false)} disabled={criarSubmitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={criarSubmitting}>
              {criarSubmitting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A criar…</>
              ) : (
                <><Handshake className="mr-2 h-4 w-4" />Criar Parceiro</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Dialog de Edição */}
      <Dialog open={editando !== null} onOpenChange={(o) => !o && setEditando(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            Editar Parceiro
          </DialogTitle>
          <DialogDescription>{editando?.email}</DialogDescription>
          <DialogClose onClick={() => setEditando(null)} />
        </DialogHeader>
        <form onSubmit={handleEditar}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="edit-nome" className="text-sm font-medium">Nome</label>
              <Input
                id="edit-nome"
                value={editForm.nome}
                onChange={(e) => setEditForm((f) => ({ ...f, nome: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-email" className="text-sm font-medium">Email</label>
              <Input
                id="edit-email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-password" className="text-sm font-medium">
                Nova Password (opcional)
              </label>
              <div className="relative">
                <Input
                  id="edit-password"
                  type={showEditPassword ? "text" : "password"}
                  value={editForm.password}
                  onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Deixar vazio para manter"
                />
                <button
                  type="button"
                  onClick={() => setShowEditPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showEditPassword ? "Ocultar password" : "Mostrar password"}
                >
                  {showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="edit-telefone" className="text-sm font-medium">Telefone</label>
                <Input
                  id="edit-telefone"
                  type="tel"
                  value={editForm.telefone}
                  onChange={(e) => setEditForm((f) => ({ ...f, telefone: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="edit-nif" className="text-sm font-medium">NIF</label>
                <Input
                  id="edit-nif"
                  value={editForm.nif}
                  onChange={(e) => setEditForm((f) => ({ ...f, nif: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-observacoes" className="text-sm font-medium">Observações</label>
              <textarea
                id="edit-observacoes"
                value={editForm.observacoes}
                onChange={(e) => setEditForm((f) => ({ ...f, observacoes: e.target.value }))}
                rows={2}
                placeholder="Notas internas"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {editErro && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {editErro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditando(null)} disabled={editSubmitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A guardar…</>
              ) : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
