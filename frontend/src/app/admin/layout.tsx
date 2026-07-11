import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";

/**
 * Layout do Painel do Super Admin.
 *
 * Prompt 115 — Separação ABSOLUTA:
 *   Importa e usa EXCLUSIVAMENTE o <AdminSidebar/>. Não há nenhuma lógica
 *   que importe o menu do gestor. O AdminSidebar é um componente dedicado
 *   (sem `mode` prop) que só contém links de admin (Empresas, Sistema).
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
        <AdminSidebar />
        <main className="flex-1 lg:overflow-x-hidden">{children}</main>
      </div>
    </RouteGuard>
  );
}
