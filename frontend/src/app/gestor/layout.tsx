import { GestorSidebar } from "@/components/gestor/gestor-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";
import { ImpersonationBanner } from "@/components/gestor/impersonation-banner";
import { AutoImpersonarEmpresa } from "@/components/gestor/auto-impersonar-empresa";

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
 * Protegido por RouteGuard (role "gestor" OU "admin" — ver route-guard.tsx).
 *
 * Prompt 110.3 / 113 — Banner de impersonação: se o admin impersonou um
 * gestor, mostra um botão VERMELHO "Voltar a Admin" no topo.
 *
 * Rebrand SSO (satélite single-tenant): o Super Admin (role 'admin') entra
 * diretamente no /gestor. Como é cross-tenant (empresa_id = empresa-sistema),
 * o <AutoImpersonarEmpresa/> assume automaticamente a empresa principal do
 * satélite antes de renderizar o programa operacional. Para gestores/staff
 * reais, o componente não faz nada (deteta role !== 'admin' e passa à frente).
 */
export default function GestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="gestor">
      <AutoImpersonarEmpresa />
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
