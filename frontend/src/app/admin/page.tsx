"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  Loader2,
  RefreshCw,
  LogIn,
  Building2,
  AlertCircle,
  CheckCircle2,
  Users,
  Power,
  Plus,
  UserPlus,
  Settings,
  Trash2,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import { formatarDataSegura } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface EmpresaDTO {
  _id: string;
  nome: string;
  nif?: string;
  plano_ativo: boolean;
  // Prompt 116 — campo ativa (controlo operacional SaaS).
  ativa?: boolean;
  // Prompt 122 — soft delete (lixeira).
  apagada?: boolean;
  createdAt: string;
  gestor: { id: string; nome: string; email: string } | null;
  num_propriedades?: number;
  num_tarefas?: number;
}

/** Prompt 101 — Utilizador de uma empresa terceira (lista no modal). */
interface UtilizadorEmpresaDTO {
  _id: string;
  nome: string;
  email: string;
  role: "admin" | "gestor" | "staff";
  ativo: boolean;
  createdAt?: string;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function SuperAdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<UtilizadorAuth | null>(null);
  const [empresas, setEmpresas] = useState<EmpresaDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [impersonando, setImpersonando] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

  // Prompt 101 — Modal "Gerir Utilizadores" de uma empresa.
  const [empresaModal, setEmpresaModal] = useState<EmpresaDTO | null>(null);
  const [utilizadoresModal, setUtilizadoresModal] = useState<UtilizadorEmpresaDTO[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalErro, setModalErro] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Prompt 101 — Formulário de criar gestor (dentro do modal).
  const [mostrarFormGestor, setMostrarFormGestor] = useState(false);
  const [formGestor, setFormGestor] = useState({ nome: "", email: "", password: "" });
  const [criandoGestor, setCriandoGestor] = useState(false);
  const [formGestorErro, setFormGestorErro] = useState<string | null>(null);

  // Prompt 111 — Criar Nova Empresa.
  const [showCriarEmpresa, setShowCriarEmpresa] = useState(false);
  const [novaEmpresaNome, setNovaEmpresaNome] = useState("");
  const [criandoEmpresa, setCriandoEmpresa] = useState(false);

  // Prompt 117 — Suspender/Ativar + Apagar empresa.
  const [togglingEmpresaId, setTogglingEmpresaId] = useState<string | null>(null);
  const [apagarEmpresaId, setApagarEmpresaId] = useState<string | null>(null);
  const [apagarLoading, setApagarLoading] = useState(false);
  // Prompt 122 — Restaurar empresa (soft delete undo).
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      // O admin usa o proxy /api/gestor/[...path] com o seu token.
      // Mas /api/admin/empresas é uma rota separada — precisa de ir direto
      // ao proxy ou a um fetch com credentials.
      const res = await fetch("/api/admin/empresas", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.erro || `Erro ${res.status}`);
      }
      const data = await res.json();
      setEmpresas(data.empresas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar empresas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Flag para evitar chamar carregar() depois de um redirect já disparado.
    let redirecionado = false;

    lerUtilizador()
      .then((u) => {
        // Sem sessão (token inexistente/expirado) → redirect para /login.
        // Mantém loading=true até que o redirect aconteça, para evitar
        // flimmer do conteúdo e pedidos 401 em loop (carregar() seria
        // rejeitado pelo backend e faria o efeito voltar a correr).
        if (u === null) {
          redirecionado = true;
          router.replace("/login");
          return;
        }
        setUser(u);
        // Só carrega as empresas depois de confirmar que o user é válido.
        return carregar();
      })
      .catch(() => {
        if (!redirecionado) {
          router.replace("/login");
        }
      });
  }, [carregar, router]);

  // Auto-esconde o toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Impersona o gestor de uma empresa e redireciona para /gestor. */
  async function handleImpersonar(emp: EmpresaDTO) {
    setImpersonando(emp._id);
    setErro(null);
    try {
      const res = await fetch(`/api/admin/impersonar/${emp._id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.erro || `Erro ${res.status}`);
      }

      // O proxy já substituiu o cookie httpOnly pelo novo token do gestor.
      // Marca a sessão como impersonação para mostrar o banner "Voltar a Admin".
      sessionStorage.setItem("autocell_impersonating", "true");

      // Redirecionamento forçado para /gestor.
      setToast({
        tipo: "sucesso",
        msg: `A entrar como ${data.utilizador.nome} (${emp.nome})…`,
      });

      // Pequeno delay para o toast ser visível antes do redirect.
      setTimeout(() => {
        window.location.href = "/gestor";
      }, 800);
    } catch (e) {
      setToast({
        tipo: "erro",
        msg: e instanceof Error ? `Erro: ${e.message}` : "Erro ao impersonar.",
      });
    } finally {
      setImpersonando(null);
    }
  }

  /** Prompt 117 — Suspender/Ativar empresa (toggle do campo ativa). */
  async function handleToggleStatus(emp: EmpresaDTO) {
    setTogglingEmpresaId(emp._id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/empresas/${emp._id}/toggle-status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativa: !emp.ativa }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setToast({ tipo: "sucesso", msg: data.message || "Estado alterado." });
      await carregar();
    } catch (e) {
      setToast({ tipo: "erro", msg: e instanceof Error ? e.message : "Erro ao alterar estado." });
    } finally {
      setTogglingEmpresaId(null);
    }
  }

  /** Prompt 117 — Apagar empresa (hard delete — irreversível). */
  async function handleApagarEmpresa() {
    if (!apagarEmpresaId) return;
    setApagarLoading(true);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/empresas/${apagarEmpresaId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setToast({ tipo: "sucesso", msg: data.message || "Empresa eliminada." });
      setApagarEmpresaId(null);
      await carregar();
    } catch (e) {
      setToast({ tipo: "erro", msg: e instanceof Error ? e.message : "Erro ao eliminar empresa." });
    } finally {
      setApagarLoading(false);
    }
  }

  /** Prompt 122 — Restaurar empresa da reciclagem (soft delete undo). */
  async function handleRestaurar(emp: EmpresaDTO) {
    setRestaurandoId(emp._id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/empresas/${emp._id}/restaurar`, {
        method: "PATCH",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setToast({ tipo: "sucesso", msg: data.message || "Empresa restaurada." });
      await carregar();
    } catch (e) {
      setToast({ tipo: "erro", msg: e instanceof Error ? e.message : "Erro ao restaurar empresa." });
    } finally {
      setRestaurandoId(null);
    }
  }

  /** Prompt 101 — Abre o modal "Gerir Utilizadores" de uma empresa. */
  async function abrirModalUtilizadores(emp: EmpresaDTO) {
    setEmpresaModal(emp);
    setUtilizadoresModal([]);
    setModalErro(null);
    setMostrarFormGestor(false);
    setFormGestor({ nome: "", email: "", password: "" });
    setFormGestorErro(null);
    setModalLoading(true);
    try {
      const res = await fetch(`/api/admin/empresas/${emp._id}/utilizadores`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setUtilizadoresModal(data.utilizadores ?? []);
    } catch (e) {
      setModalErro(e instanceof Error ? e.message : "Erro ao carregar utilizadores.");
    } finally {
      setModalLoading(false);
    }
  }

  /** Prompt 101 — Alterna ativo/inativo de um utilizador da empresa do modal. */
  async function toggleEstadoUtilizador(u: UtilizadorEmpresaDTO) {
    if (!empresaModal) return;
    setTogglingId(u._id);
    try {
      const res = await fetch(
        `/api/admin/empresas/${empresaModal._id}/utilizadores/${u._id}/estado`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ativo: !u.ativo }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      // Atualiza a lista localmente.
      setUtilizadoresModal((prev) =>
        prev.map((x) => (x._id === u._id ? { ...x, ativo: data.ativo } : x))
      );
      // Atualiza também a lista de empresas (o gestor pode ter mudado de estado).
      await carregar();
    } catch (e) {
      setModalErro(e instanceof Error ? e.message : "Erro ao alterar estado.");
    } finally {
      setTogglingId(null);
    }
  }

  /** Prompt 101 — Cria um novo gestor para a empresa do modal. */
  async function criarGestor(e: React.FormEvent) {
    e.preventDefault();
    if (!empresaModal) return;
    setFormGestorErro(null);
    if (!formGestor.nome.trim() || !formGestor.email.trim() || !formGestor.password) {
      setFormGestorErro("Nome, email e password são obrigatórios.");
      return;
    }
    if (formGestor.password.length < 6) {
      setFormGestorErro("A password deve ter pelo menos 6 caracteres.");
      return;
    }
    setCriandoGestor(true);
    try {
      const res = await fetch(`/api/admin/empresas/${empresaModal._id}/utilizadores`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: formGestor.nome.trim(),
          email: formGestor.email.trim(),
          password: formGestor.password,
          role: "gestor",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      // Adiciona à lista local + atualiza empresas (agora tem gestor).
      setUtilizadoresModal((prev) => [...prev, data.utilizador]);
      setMostrarFormGestor(false);
      setFormGestor({ nome: "", email: "", password: "" });
      setToast({
        tipo: "sucesso",
        msg: `Gestor "${data.utilizador.nome}" criado em "${empresaModal.nome}".`,
      });
      await carregar();
    } catch (e) {
      setFormGestorErro(e instanceof Error ? e.message : "Erro ao criar gestor.");
    } finally {
      setCriandoGestor(false);
    }
  }

  /** Prompt 111 — Criar Nova Empresa. */
  async function handleCriarEmpresa(e: React.FormEvent) {
    e.preventDefault();
    if (!novaEmpresaNome.trim()) return;
    setCriandoEmpresa(true);
    try {
      const res = await fetch("/api/admin/empresas", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: novaEmpresaNome.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setShowCriarEmpresa(false);
      setNovaEmpresaNome("");
      setToast({ tipo: "sucesso", msg: `Empresa "${data.empresa.nome}" criada com sucesso.` });
      await carregar();
    } catch (e) {
      setToast({ tipo: "erro", msg: e instanceof Error ? e.message : "Erro ao criar empresa." });
    } finally {
      setCriandoEmpresa(false);
    }
  }

  // Prompt 122 — Separa as empresas em Ativas e Reciclagem (soft delete).
  const empresasAtivas = empresas.filter((e) => !e.apagada);
  const empresasApagadas = empresas.filter((e) => e.apagada === true);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Empresas</h1>
            <p className="text-sm text-muted-foreground">
              {user?.nome ?? "Admin"} · Gestão de empresas e impersonation
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setShowCriarEmpresa(true)}
            className="gap-2"
            disabled={loading}
          >
            <Plus className="h-4 w-4" />
            Criar Nova Empresa
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <Card
          className={
            toast.tipo === "sucesso"
              ? "border-emerald-500/50"
              : "border-destructive/50"
          }
        >
          <CardContent
            className={`flex items-center gap-3 p-4 text-sm ${
              toast.tipo === "sucesso"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive"
            }`}
          >
            {toast.tipo === "sucesso" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" />
            )}
            <span className="flex-1">{toast.msg}</span>
          </CardContent>
        </Card>
      )}

      {/* Erro */}
      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{erro}</span>
            <Button variant="outline" size="sm" onClick={carregar} className="ml-auto">
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Prompt 122 — Lista de empresas com Tabs (Ativas / Reciclagem) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Empresas Registadas
            <Badge variant="secondary" className="ml-1">
              {empresas.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar empresas…
            </div>
          ) : (
            <Tabs defaultValue="ativas" className="w-full">
              <TabsList className="mx-4 mt-2">
                <TabsTrigger value="ativas">
                  Ativas / Suspensas ({empresasAtivas.length})
                </TabsTrigger>
                <TabsTrigger value="reciclagem">
                  Reciclagem ({empresasApagadas.length})
                </TabsTrigger>
              </TabsList>

              {/* ABA: Ativas / Suspensas */}
              <TabsContent value="ativas" className="mt-0">
                {empresasAtivas.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                    <Building2 className="h-10 w-10 opacity-40" />
                    <p className="text-sm">Sem empresas ativas.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Agência</th>
                    <th className="px-4 py-3 font-medium">Gestor</th>
                    <th className="px-4 py-3 text-center font-medium">Propriedades</th>
                    <th className="px-4 py-3 text-center font-medium">Tarefas</th>
                    <th className="px-4 py-3 font-medium">Registo</th>
                    <th className="px-4 py-3 font-medium">Plano</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {empresasAtivas.map((emp) => (
                    <tr key={emp._id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{emp.nome}</div>
                        {emp.nif && (
                          <div className="text-xs text-muted-foreground">
                            NIF: {emp.nif}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {emp.gestor ? (
                          <div>
                            <div className="font-medium">{emp.gestor.nome}</div>
                            <div className="text-xs text-muted-foreground">
                              {emp.gestor.email}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Sem gestor
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-medium">{emp.num_propriedades ?? 0}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-medium">{emp.num_tarefas ?? 0}</span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {emp.createdAt
                          ? formatarDataSegura(
                              emp.createdAt,
                              (d) => format(d, "d MMM yyyy", { locale: pt }),
                              "—"
                            )
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <Badge variant={emp.plano_ativo ? "default" : "secondary"}>
                            {emp.plano_ativo ? "Ativo" : "Inativo"}
                          </Badge>
                          {emp.ativa === false && (
                            <Badge variant="destructive">Suspensa</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {/* Prompt 117 — Gerir Configurações (gaveta da empresa) */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => router.push(`/admin/empresas/${emp._id}`)}
                            title={`Gerir configurações de ${emp.nome}`}
                          >
                            <Settings className="mr-1.5 h-3.5 w-3.5" />
                            Gerir Configurações
                          </Button>
                          {/* Prompt 101 — Gerir Utilizadores da empresa */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => abrirModalUtilizadores(emp)}
                            title={`Gerir utilizadores de ${emp.nome}`}
                          >
                            <Users className="mr-1.5 h-3.5 w-3.5" />
                            Utilizadores
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleImpersonar(emp)}
                            disabled={
                              impersonando !== null || !emp.gestor
                            }
                            title={
                              !emp.gestor
                                ? "Esta empresa não tem gestor"
                                : `Entrar como ${emp.gestor.nome}`
                            }
                          >
                            {impersonando === emp._id ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <LogIn className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Entrar
                          </Button>
                          {/* Prompt 117 — Suspender/Ativar */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleToggleStatus(emp)}
                            disabled={togglingEmpresaId === emp._id}
                            title={emp.ativa === false ? "Reativar empresa" : "Suspender empresa (bloqueia logins e webhooks)"}
                            className={
                              emp.ativa === false
                                ? "text-emerald-600 border-emerald-400 hover:bg-emerald-50"
                                : "text-amber-600 border-amber-400 hover:bg-amber-50"
                            }
                          >
                            {togglingEmpresaId === emp._id ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Power className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {emp.ativa === false ? "Ativar" : "Suspender"}
                          </Button>
                          {/* Prompt 117 — Apagar (irreversível) */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setApagarEmpresaId(emp._id)}
                            title="Apagar empresa (irreversível)"
                            className="text-destructive border-destructive/40 hover:bg-destructive/10"
                          >
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            Apagar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
                )}
              </TabsContent>

              {/* ABA: Reciclagem (empresas apagadas) */}
              <TabsContent value="reciclagem" className="mt-0">
                {empresasApagadas.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                    <RotateCcw className="h-10 w-10 opacity-40" />
                    <p className="text-sm">A reciclagem está vazia.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left">
                          <th className="px-4 py-3 font-medium">Agência</th>
                          <th className="px-4 py-3 font-medium">Gestor</th>
                          <th className="px-4 py-3 text-center font-medium">Propriedades</th>
                          <th className="px-4 py-3 text-center font-medium">Tarefas</th>
                          <th className="px-4 py-3 text-right font-medium">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {empresasApagadas.map((emp) => (
                          <tr key={emp._id} className="opacity-70 hover:bg-muted/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span className="font-medium line-through">{emp.nome}</span>
                                <Badge variant="destructive">Apagada</Badge>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {emp.gestor?.nome ?? "—"}
                            </td>
                            <td className="px-4 py-3 text-center text-muted-foreground">
                              {emp.num_propriedades ?? 0}
                            </td>
                            <td className="px-4 py-3 text-center text-muted-foreground">
                              {emp.num_tarefas ?? 0}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleRestaurar(emp)}
                                disabled={restaurandoId === emp._id}
                                title="Restaurar empresa (move de volta para Ativas)"
                                className="text-emerald-600 border-emerald-400 hover:bg-emerald-50"
                              >
                                {restaurandoId === emp._id ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                Restaurar
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      {/* Nota de impersonation */}
      <p className="text-center text-xs text-muted-foreground">
        💡 Ao &ldquo;Entrar como Gestor&rdquo;, assumes a identidade do gestor da empresa.
        Para voltar a ser Super Admin, clica em &ldquo;Terminar Sessão&rdquo; e faz login
        novamente com as tuas credenciais de dono.
      </p>

      {/* Prompt 101 — Modal "Gerir Utilizadores" */}
      <Dialog
        open={empresaModal !== null}
        onOpenChange={(o) => !o && setEmpresaModal(null)}
      >
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Gerir Utilizadores — {empresaModal?.nome}
            </DialogTitle>
            <DialogDescription>
              Lista de gestores e staff desta empresa. Podes ativar/desativar
              utilizadores ou criar um novo gestor.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setEmpresaModal(null)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {/* Erro do modal */}
          {modalErro && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {modalErro}
            </div>
          )}

          {/* Lista de utilizadores */}
          {modalLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              A carregar utilizadores…
            </div>
          ) : utilizadoresModal.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Users className="h-8 w-8 opacity-40" />
              <p className="text-sm">Sem utilizadores nesta empresa.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Nome</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Estado</th>
                    <th className="px-3 py-2 text-right font-medium">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {utilizadoresModal.map((u) => (
                    <tr key={u._id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{u.nome}</td>
                      <td className="px-3 py-2 text-muted-foreground">{u.email}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={u.role === "gestor" ? "default" : "secondary"}
                        >
                          {u.role === "gestor" ? "Gestor" : u.role === "staff" ? "Staff" : u.role}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={u.ativo ? "success" : "outline"}>
                          {u.ativo ? "Ativo" : "Inativo"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5"
                          onClick={() => toggleEstadoUtilizador(u)}
                          disabled={togglingId === u._id || u.role === "admin"}
                          title={
                            u.role === "admin"
                              ? "Não é possível modificar um administrador"
                              : u.ativo
                              ? "Desativar"
                              : "Ativar"
                          }
                        >
                          {togglingId === u._id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Power className="h-3.5 w-3.5" />
                          )}
                          {u.ativo ? "Desativar" : "Ativar"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Formulário de criar gestor (toggle) */}
          {mostrarFormGestor ? (
            <form onSubmit={criarGestor} className="space-y-3 rounded-md border bg-muted/20 p-4">
              <h4 className="text-sm font-semibold">Criar Novo Gestor</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">Nome</label>
                  <Input
                    value={formGestor.nome}
                    onChange={(e) => setFormGestor((f) => ({ ...f, nome: e.target.value }))}
                    required
                    placeholder="Nome do gestor"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Email</label>
                  <Input
                    type="email"
                    value={formGestor.email}
                    onChange={(e) => setFormGestor((f) => ({ ...f, email: e.target.value }))}
                    required
                    placeholder="email@exemplo.pt"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Password</label>
                  <Input
                    type="password"
                    value={formGestor.password}
                    onChange={(e) => setFormGestor((f) => ({ ...f, password: e.target.value }))}
                    required
                    placeholder="Mín. 6 caracteres"
                    minLength={6}
                  />
                </div>
              </div>
              {formGestorErro && (
                <p className="text-sm text-destructive">{formGestorErro}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMostrarFormGestor(false);
                    setFormGestorErro(null);
                  }}
                  disabled={criandoGestor}
                >
                  Cancelar
                </Button>
                <Button type="submit" size="sm" disabled={criandoGestor}>
                  {criandoGestor ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      A criar…
                    </>
                  ) : (
                    <>
                      <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                      Criar Gestor
                    </>
                  )}
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => setMostrarFormGestor(true)}
            >
              <UserPlus className="h-4 w-4" />
              Criar Novo Gestor
            </Button>
          )}
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEmpresaModal(null)}>
            Fechar
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 111 — Modal Criar Nova Empresa */}
      <Dialog open={showCriarEmpresa} onOpenChange={(o) => !o && setShowCriarEmpresa(false)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              Criar Nova Empresa
            </DialogTitle>
            <DialogDescription>
              Regista uma nova empresa no sistema. Poderás configurar a API Key do Smoobu depois.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setShowCriarEmpresa(false)} />
        </DialogHeader>
        <form onSubmit={handleCriarEmpresa}>
          <DialogContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nova-empresa-nome">
                Nome da Empresa
              </label>
              <Input
                id="nova-empresa-nome"
                value={novaEmpresaNome}
                onChange={(e) => setNovaEmpresaNome(e.target.value)}
                placeholder="Ex: Hotel Lisboa"
                required
                autoFocus
              />
            </div>
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowCriarEmpresa(false)} disabled={criandoEmpresa}>
              Cancelar
            </Button>
            <Button type="submit" disabled={criandoEmpresa || !novaEmpresaNome.trim()}>
              {criandoEmpresa ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A criar…</>
              ) : (
                <><Plus className="mr-2 h-4 w-4" />Criar Empresa</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Prompt 117 — Modal Apagar Empresa (irreversível) */}
      <Dialog open={apagarEmpresaId !== null} onOpenChange={(o) => !o && setApagarEmpresaId(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Apagar Empresa
            </DialogTitle>
            <DialogDescription>
              Esta ação é <strong>irreversível</strong>. A empresa e todos os
              seus dados (propriedades, tarefas, utilizadores, ausências) serão
              permanentemente eliminados. Escreve <strong>APAGAR</strong> para confirmar.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setApagarEmpresaId(null)} />
        </DialogHeader>
        <DialogContent>
          <ApagarConfirmInput
            onConfirm={handleApagarEmpresa}
            onCancel={() => setApagarEmpresaId(null)}
            loading={apagarLoading}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Input de confirmação para apagar empresa (escrever "APAGAR"). */
function ApagarConfirmInput({
  onConfirm,
  onCancel,
  loading,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [texto, setTexto] = useState("");
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="apagar-text">Escreve &ldquo;APAGAR&rdquo;:</label>
        <Input
          id="apagar-text"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="APAGAR"
          className="font-mono"
          autoComplete="off"
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          Cancelar
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm} disabled={texto !== "APAGAR" || loading}>
          {loading ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A apagar…</>
          ) : (
            <><Trash2 className="mr-2 h-4 w-4" />Apagar Definitivamente</>
          )}
        </Button>
      </DialogFooter>
    </div>
  );
}
