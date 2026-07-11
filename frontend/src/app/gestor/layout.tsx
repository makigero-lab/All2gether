import { GestorSidebar } from "@/components/gestor/gestor-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";
import { ImpersonationBanner } from "@/components/gestor/impersonation-banner";

/**
 * Layout do Painel do Gestor de Operações.
 *
 * Prompt 115 — Separação ABSOLUTA:
 *   Importa e usa EXCLUSIVAMENTE o <GestorSidebar/>. Não há nenhuma lógica
 *   que importe o menu de admin. O GestorSidebar é um componente dedicado
 *   (sem `mode` prop) que só contém links de operações do gestor.
 *
 *   O gestor vê apenas: Dashboard, Calendário, Tarefas, Propriedades,
 *   Equipa, Ausências, Relatórios, Configurações + Sino de Notificações.
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
