import { ManagerSidebar } from "@/components/manager/manager-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";

/**
 * Layout da Área do Responsável de Limpezas (manager).
 * Sidebar fixa (desktop) / overlay (mobile) + área de conteúdo.
 *
 * Protegido por RouteGuard (role "gestor") — camada client-side complementar
 * ao middleware.ts. Sem token válido (ou role errado) → redireciona para /login.
 */
export default function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="gestor">
      <div className="flex min-h-screen flex-col bg-muted/30 lg:flex-row">
        <ManagerSidebar />
        <main className="flex-1 lg:overflow-x-hidden">{children}</main>
      </div>
    </RouteGuard>
  );
}
