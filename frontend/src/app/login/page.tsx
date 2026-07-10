"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { rotaPorRole, limparCacheAuth } from "@/lib/auth";
import type { LoginResponse } from "@/lib/api";

/**
 * Página de Login — Autocell
 *
 * Ecrã minimalista centrado, com o design premium (dourado + sharp).
 * Ao submeter:
 *   1. POST /api/auth/login (proxy same-origin que encaminha para o backend
 *      e guarda o token num cookie httpOnly no servidor).
 *   2. Em caso de sucesso, redireciona para o painel correto
 *      (admin→/admin, gestor→/gestor, staff→/staff) ou para ?from= se
 *      vier de uma rota protegida.
 *
 * Prompt 113 (iteração 3) — Removido o fetch a /api/auth/me no mount.
 *
 * Antes, esta página chamava `lerUtilizador()` no mount para detetar sessão
 * existente e redirecionar. Mas isso gerava 1 pedido 401 no console de
 * qualquer visitante sem sessão.
 *
 * O `middleware.ts` (Edge) JÁ faz essa verificação via cookie httpOnly:
 *   - Se autenticado em `/login` → redirect para o painel do role.
 *   - Se NÃO autenticado em `/login` → deixa passar (mostra o formulário).
 *
 * Logo, se a LoginPage renderiza, é porque o utilizador NÃO está autenticado.
 * Não há nada a verificar — mostrar o formulário de login diretamente.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <LoginConteudo />
    </Suspense>
  );
}

function LoginConteudo() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);

    if (!email.trim() || !password) {
      setErro("Introduz o email e a password.");
      return;
    }

    setLoading(true);
    try {
      // POST para o proxy same-origin (que define o cookie httpOnly).
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
        cache: "no-store",
      });

      if (!res.ok) {
        let mensagem = `${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data?.erro) mensagem = data.erro;
        } catch {
          /* mantém mensagem padrão */
        }
        throw new Error(mensagem);
      }

      const data = (await res.json()) as LoginResponse;

      // O proxy já definiu o cookie httpOnly. Limpa o cache de auth (que
      // pode ter um null cached de antes do login) para que o RouteGuard
      // no painel de destino vá ao backend buscar o user real.
      limparCacheAuth();

      // Redireciona conforme o role.
      const destino = from || rotaPorRole(data.utilizador.role);
      router.push(destino);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao iniciar sessão.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-12">
      {/* Padrão de fundo subtil (igual à landing) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,hsl(var(--foreground)/0.04)_1px,transparent_1px)] [background-size:24px_24px]"
      />

      {/* Voltar para a landing */}
      <Link
        href="/"
        prefetch
        className="relative z-10 mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Voltar
      </Link>

      <div className="relative z-10 w-full max-w-sm">
        {/* Marca */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/20">
            <span className="text-lg font-bold tracking-tight">A</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Iniciar sessão
          </h1>
          <p className="mt-1.5 text-sm font-light text-muted-foreground">
            Autocell · Gestão de Alojamento Local
          </p>
        </div>

        <Card className="border-border/60 shadow-sm">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-base font-semibold tracking-tight">
              Bem-vindo de volta
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="o.teu@email.pt"
                  required
                  disabled={loading}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="text-sm font-medium">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={loading}
                />
              </div>

              {erro && (
                <p className="flex items-start gap-2 rounded-md bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{erro}</span>
                </p>
              )}

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    A entrar…
                  </>
                ) : (
                  "Entrar"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs font-light text-muted-foreground">
          Sem acesso? Contacta o administrador da tua empresa.
        </p>
      </div>
    </main>
  );
}
