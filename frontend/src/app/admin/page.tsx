"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  LogOut,
  Loader2,
  RefreshCw,
  LogIn,
  Building2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fazerLogout, lerUtilizador } from "@/lib/auth";
import type { UtilizadorAuth } from "@/lib/auth";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface EmpresaDTO {
  _id: string;
  nome: string;
  nif?: string;
  plano_ativo: boolean;
  createdAt: string;
  gestor: { id: string; nome: string; email: string } | null;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function SuperAdminPage() {
  const [user, setUser] = useState<UtilizadorAuth | null>(null);
  const [empresas, setEmpresas] = useState<EmpresaDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [impersonando, setImpersonando] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

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
    lerUtilizador()
      .then((u) => setUser(u))
      .catch(() => {});
    carregar();
  }, [carregar]);

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

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Super Admin</h1>
            <p className="text-sm text-muted-foreground">
              {user?.nome ?? "Admin"} · Gestão de empresas e impersonation
            </p>
          </div>
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
            variant="ghost"
            className="text-sm text-muted-foreground hover:text-destructive"
            onClick={() => fazerLogout()}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Terminar Sessão
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

      {/* Lista de empresas */}
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
          ) : empresas.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Building2 className="h-10 w-10 opacity-40" />
              <p className="text-sm">Sem empresas registadas.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Agência</th>
                    <th className="px-4 py-3 font-medium">Gestor</th>
                    <th className="px-4 py-3 font-medium">Registo</th>
                    <th className="px-4 py-3 font-medium">Plano</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {empresas.map((emp) => (
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
                      <td className="px-4 py-3 text-muted-foreground">
                        {emp.createdAt
                          ? format(new Date(emp.createdAt), "d MMM yyyy", {
                              locale: pt,
                            })
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={emp.plano_ativo ? "default" : "secondary"}>
                          {emp.plano_ativo ? "Ativo" : "Inativo"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
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
                          Entrar como Gestor
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Nota de impersonation */}
      <p className="text-center text-xs text-muted-foreground">
        💡 Ao &ldquo;Entrar como Gestor&rdquo;, assumes a identidade do gestor da empresa.
        Para voltar a ser Super Admin, clica em &ldquo;Terminar Sessão&rdquo; e faz login
        novamente com as tuas credenciais de dono.
      </p>
    </div>
  );
}
