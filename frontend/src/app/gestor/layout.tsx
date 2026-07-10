import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { RouteGuard } from "@/components/auth/route-guard";

/**
 * Layout do Painel do Gestor de Operações.
 *
 * Prompt 110 — O gestor usa o sidebar em modo "gestor" (só operações:
 * Dashboard, Propriedades, Tarefas, Equipa, Ausências, Calendário,
 * Relatórios, Webhooks). NUNCA vê links de Admin.
 *
 * Protegido por RouteGuard (role "gestor").
 *
 * Prompt 110.3 — Banner de impersonação: se o admin impersonou um gestor,
 * mostra um botão "Voltar a Admin" no topo.
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
          {/* Banner de impersonação — só visível se o admin estiver
              impersonado (detectado via query param ou sessionStorage). */}
          <ImpersonationBanner />
          {children}
        </main>
      </div>
    </RouteGuard>
  );
}

/**
 * Banner que aparece no topo quando o admin está impersonado como gestor.
 * Mostra um botão "Voltar a Admin" que faz logout + redirect para /admin.
 */
function ImpersonationBanner() {
  // O proxy de impersonação substitui o cookie — não há forma de saber
  // client-side se é impersonação sem um marcador. Vamos usar sessionStorage.
  if (typeof window === "undefined") return null;
  const isImpersonating = sessionStorage.getItem("autocell_impersonating") === "true";

  if (!isImpersonating) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        ⚠️ Estás em modo de impersonação. As ações que fizeres serão registadas.
      </span>
      <button
        className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
        onClick={() => {
          sessionStorage.removeItem("autocell_impersonating");
          // Faz logout (limpa o cookie) e redireciona para /admin.
          fetch("/api/auth/logout", { method: "POST", credentials: "include" })
            .then(() => {
              window.location.href = "/login";
            })
            .catch(() => {
              window.location.href = "/login";
            });
        }}
      >
        Voltar a Admin
      </button>
    </div>
  );
}
