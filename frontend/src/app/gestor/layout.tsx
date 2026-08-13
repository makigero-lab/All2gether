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
 * Protegido por RouteGuard (role "gestor" OU "admin" — ver route-guard.tsx).
 *
 * Prompt 110.3 / 113 — Banner de impersonação: se o admin impersonou um
 * gestor, mostra um botão VERMELHO "Voltar a Admin" no topo.
 *
 * Rebrand SSO (satélite single-tenant) — ACESSO DIRETO DO ADMIN:
 *   O Super Admin (role 'admin') tem agora `empresa_id` que aponta para a
 *   empresa operacional única ("All2gether", renomeada via rota
 *   /api/cleanup-final a partir de "All2gether (Sistema)"). Isto significa
 *   que as queries `req.user.empresa_id` devolvem dados reais SEM necessidade
 *   de impersonação. O componente <AutoImpersonarEmpresa/> foi REMOVIDO do
 *   layout — o admin aterra diretamente na vista operacional, sem o fluxo
 *   de auto-impersonação que antes era necessário (quando o admin era
 *   cross-tenant e o seu empresa_id apontava para a empresa-sistema).
 *
 *   O <ImpersonationBanner/> mantém-se no layout por segurança: se uma
 *   sessão antiga ainda tiver a flag `all2gether_impersonating` ativa no
 *   sessionStorage (de uma impersonação manual anterior), o banner permite
 *   sair dela. Para novas sessões, a flag nunca é definida e o banner não
 *   aparece — o admin trabalha diretamente como gestor da empresa "All2gether".
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
