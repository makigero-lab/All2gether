"use client";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";

/**
 * Layout do Painel do Super Admin.
 *
 * Prompt 110 — Menu lateral exclusivo do Admin (Empresas, Sistema).
 * O Admin tem o seu próprio layout separado do Gestor.
 *
 * Protegido por RouteGuard (role "admin").
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="admin">
      <div className="flex min-h-screen flex-col bg-muted/30 lg:flex-row">
        <AdminSidebar mode="admin" />
        <main className="flex-1 lg:overflow-x-hidden">{children}</main>
      </div>
    </RouteGuard>
  );
}
