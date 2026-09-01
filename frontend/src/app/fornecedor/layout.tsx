"use client";

import { RouteGuard } from "@/components/auth/route-guard";
import { PortalHeader } from "@/components/portal/portal-header";

/**
 * /fornecedor/layout.tsx — Layout do Portal da Lavandaria (Fornecedor).
 *
 * FIX (portal lavandaria) — Novo portal para o role 'fornecedor' (lavandaria).
 * O fornecedor vê as tarefas dos próximos 7 dias e marca roupa_entregue.
 *
 * FIX (header fornecedor) — Adicionado PortalHeader com avatar/menu/logout.
 * O fornecedor agora tem acesso ao menu de utilizador (Perfil + Terminar
 * Sessão) igual ao portal do parceiro.
 */
export default function FornecedorLayout({ children }: { children: React.ReactNode }) {
  return (
    <RouteGuard role="fornecedor">
      <PortalHeader portalLabel="Lavandaria" />
      {children}
    </RouteGuard>
  );
}
