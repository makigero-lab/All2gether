import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";
import { ImpersonationBanner } from "@/components/gestor/impersonation-banner";

/**
 * Layout do Painel do Gestor de Operações.
 *
 * Prompt 110 — O gestor usa o sidebar em modo "gestor" (só operações:
 * Dashboard, Propriedades, Tarefas, Equipa, Ausências, Calendário,
 * Relatórios, Webhooks, Configurações). NUNCA vê links de Admin.
 *
 * Protegido por RouteGuard (role "gestor").
 *
 * Prompt 110.3 / 113 — Banner de impersonação: se o admin impersonou um
 * gestor, mostra um botão VERMELHO "Voltar a Admin" no topo (componente
 * cliente separado para evitar problemas de hidratação com sessionStorage).
 */
export default function GestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="gestor">
      <div className="flex min-h-screen flex-col bg-muted/30 lg:flex-row">
        <AdminSidebar mode="gestor" />
        <main className="flex-1 lg:overflow-x-hidden">
          <ImpersonationBanner />
          {children}
        </main>
      </div>
    </RouteGuard>
  );
}
