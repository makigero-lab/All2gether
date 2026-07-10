"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Landing page — ponto de entrada público.
 *
 * Estética premium: fundo limpo, marca minimalista, um único botão de ação.
 *
 * Prompt 113 (iteração 3) — Removido o fetch a /api/auth/me.
 *
 * Antes, esta página chamava `lerUtilizador()` no mount para detetar se o
 * utilizador já tinha sessão e redirecionar para o painel. Mas isso gerava
 * 1 pedido 401 no console de qualquer visitante sem sessão (a maioria).
 *
 * Ora, o `middleware.ts` (Edge) JÁ faz essa verificação via cookie httpOnly:
 *   - Se autenticado em `/` → redirect para o painel do role.
 *   - Se NÃO autenticado em `/` → deixa passar (mostra a landing).
 *
 * Logo, se a HomePage renderiza, é porque o utilizador NÃO está autenticado.
 * Não há nada a verificar — o fetch seria sempre 401 e desnecessário.
 * O botão "Entrar na Plataforma" leva a `/login` (que também não faz fetch).
 */
export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-6 py-16">
      {/* Padrão de fundo subtil (grid em pontos) — dá profundidade sem distrair */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,hsl(var(--foreground)/0.04)_1px,transparent_1px)] [background-size:24px_24px]"
      />

      <div className="relative z-10 flex flex-col items-center text-center">
        {/* Marca minimalista */}
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/20">
          <span className="text-lg font-bold tracking-tight">A</span>
        </div>

        <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Autocell
        </h1>
        <p className="mt-3 max-w-md text-base font-light leading-relaxed text-muted-foreground">
          A plataforma de gestão para Alojamento Local.
          <br className="hidden sm:block" />
          Atribuição inteligente de tarefas de limpeza.
        </p>

        {/* Separador discreto */}
        <div className="mt-6 h-px w-16 bg-border" />

        {/* Único botão de ação — grande e elegante */}
        <div className="mt-8">
          <Link href="/login" prefetch>
            <Button className="group h-12 px-10 text-base tracking-wide">
              Entrar na Plataforma
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Button>
          </Link>
        </div>
      </div>

      <p className="relative z-10 mt-12 text-xs font-light tracking-wide text-muted-foreground">
        Autocell · Gestão de Alojamento Local
      </p>
    </main>
  );
}
