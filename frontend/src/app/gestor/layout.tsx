import { GestorSidebar } from "@/components/gestor/gestor-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";
import { ImpersonationBanner } from "@/components/gestor/impersonation-banner";

/**
 * Layout do Painel do Gestor de Operações.
 *
 * Prompt 114 — Isolamento ESTRITO do menu Admin:
 *   Este layout NÃO importa nem renderiza QUALQUER componente de Admin.
 *   Antes usava `AdminSidebar` (partilhado, com `mode="gestor"`) — agora
 *   usa o `GestorSidebar` dedicado, que só contém os items de operações.
 *
 *   O gestor vê apenas: Dashboard, Propriedades, Tarefas, Equipa, Ausências,
 *   Calendário, Relatórios, Webhooks, Configurações + Sino de Notificações.
 *
 * Protegido por RouteGuard (role "gestor").
 *
 * Prompt 110.3 / 113 — Banner de impersonação: se o admin impersonou um
 * gestor, mostra um botão VERMELHO "Voltar a Admin" no topo.
 */
export default function GestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="gestor">
      <div className="flex min-h-screen flex-col bg-muted/30 lg:flex-row">
        <GestorSidebar />
        <main className="flex-1 lg:overflow-x-hidden">
          <ImpersonationBanner />
          {children}
        </main>
      </div>
    </RouteGuard>
  );
}
