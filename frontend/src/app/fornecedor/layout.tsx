"use client";

import { RouteGuard } from "@/components/auth/route-guard";

/**
 * /fornecedor/layout.tsx — Layout do Portal da Lavandaria (Fornecedor).
 *
 * FIX (portal lavandaria) — Novo portal para o role 'fornecedor' (lavandaria).
 * O fornecedor vê as tarefas dos próximos 7 dias e marca roupa_entregue.
 */
export default function FornecedorLayout({ children }: { children: React.ReactNode }) {
  return <RouteGuard role="fornecedor">{children}</RouteGuard>;
}
