"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Building2,
  Users,
  CalendarRange,
  ClipboardList,
  BarChart3,
  CalendarOff,
  Menu,
  X,
  Sparkles,
  LogOut,
  Bell,
  ListChecks,
  Settings,
  Handshake,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fazerLogout, lerUtilizador, type Role } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Prompt 115 — Separação ABSOLUTA de menus.
 *
 * O array de links do Gestor contém APENAS:
 *   Dashboard, Calendário, Tarefas, Propriedades, Equipa, Ausências,
 *   Relatórios, Configurações.
 *
 * NÃO há nenhum link para 'Sistema', 'Empresas', 'Webhooks' ou 'Admin'.
 * Este ficheiro é dedicado ao Gestor e não partilha código com o Admin.
 */
/**
 * Prompt 117 — Limpeza do Layout do Gestor:
 *   Removido ESTRITAMENTE o item 'Configurações'. O Gestor não gere API keys
 *   nem webhooks (essas integrações pertencem à Gaveta do Admin em
 *   /admin/empresas/[id]). O Gestor apenas vê operações:
 *   Dashboard, Calendário, Tarefas, Propriedades, Equipa, Ausências, Relatórios.
 */
/**
 * FIX (acesso direto admin) — O item "Configurações" volta à sidebar, agora
 * visível para TODOS (admin e gestor). O item "Parceiros" é adicionado para
 * a nova página /gestor/parceiros (gestão de parceiros B2B isolada da Equipa).
 * O admin tem acesso a tudo (igual ao gestor) sem depender de impersonação.
 */
const gestorNavItems: NavItem[] = [
  { label: "Dashboard", href: "/gestor", icon: LayoutDashboard },
  { label: "Calendário", href: "/gestor/calendario", icon: CalendarRange },
  { label: "Limpezas", href: "/gestor/tarefas", icon: ClipboardList },
  { label: "Propriedades", href: "/gestor/propriedades", icon: Building2 },
  { label: "Equipa", href: "/gestor/equipa", icon: Users },
  { label: "Proprietários", href: "/gestor/parceiros", icon: Handshake },
  { label: "Ausências / Férias", href: "/gestor/ausencias", icon: CalendarOff },
  { label: "Relatórios", href: "/gestor/relatorios", icon: BarChart3 },
  { label: "Notificações", href: "/gestor/notificacoes", icon: Bell },
  // FIX (checklists página própria) — Movido de /gestor/configuracoes/checklists
  // para /gestor/checklists (página/menu próprio, não escondido nas configs).
  { label: "Checklists", href: "/gestor/checklists", icon: ListChecks },
  // FIX (acesso direto admin) — Configurações da empresa (integracoes,
  // gerais) voltam a estar acessíveis na sidebar para admin E gestor.
  { label: "Configurações", href: "/gestor/configuracoes", icon: Settings },
  // HF13 — Item "Integrações" removido (sistema agora usa webhooks exclusivamente;
  // a página /gestor/configuracoes/integracoes mantém-se acessível via URL direta
  // para gestão da API key, mas não é exposta na navegação principal).
];

/**
 * Barra lateral do Painel do Gestor de Operações.
 *
 * Prompt 115 — Separação ABSOLUTA: este componente NÃO importa nem renderiza
 * NADA de admin. Antes, o `gestor/layout.tsx` usava `AdminSidebar` (partilhado)
 * com `mode="gestor"` — agora há um componente dedicado e isolado.
 */
/**
 * FIX (perfil admin dinâmico) — Determina o label do role dinamicamente:
 * 'Admin' para role 'admin', 'Gestor' para role 'gestor'. Antes era
 * hardcoded 'Gestor'. Agora usa lerUtilizador() para buscar o role real.
 */
function useRoleLabel(): string {
  const [label, setLabel] = useState("Gestor");
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (cancelado) return;
      if (user?.role === "admin") setLabel("Admin");
      else if (user?.role === "gestor") setLabel("Gestor");
    })();
    return () => { cancelado = true; };
  }, []);
  return label;
}

/**
 * FIX (configs restritas a admin) — Hook que devolve o role do utilizador
 * atual. Usado para filtrar itens da sidebar que são exclusivos do admin
 * (ex: "Configurações"). O gestor não vê nem acede a /gestor/configuracoes.
 */
function useUserRole(): Role | null {
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (cancelado) return;
      setRole(user?.role ?? null);
    })();
    return () => { cancelado = true; };
  }, []);
  return role;
}

export function GestorSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const roleLabel = useRoleLabel();
  const userRole = useUserRole();

  const basePath = "/gestor";

  const isActive = (href: string) =>
    href === basePath ? pathname === href : pathname.startsWith(href);

  const NavLinks = () => (
    <nav aria-label="Menu do gestor" className="flex flex-col gap-0.5 px-3 py-2">
      {/* FIX (configs restritas a admin) — Filtra itens exclusivos do admin.
          "Configurações" só aparece para role === 'admin'. O gestor não vê
          nem acede a /gestor/configuracoes (exclusivo do Super Admin). */}
      {gestorNavItems
        .filter((item) => {
          // "Configurações" é exclusivo do admin.
          if (item.href === "/gestor/configuracoes" && userRole !== "admin") {
            return false;
          }
          return true;
        })
        .map((item) => {
        const active = isActive(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            onClick={() => setOpen(false)}
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-side-active text-side-active-foreground"
                : "text-side-foreground hover:bg-side-active/60"
            )}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const Brand = () => (
    <div className="flex h-16 items-center gap-2.5 px-5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="h-5 w-5" />
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-sm font-bold">All2gether</span>
        {/* FIX (perfil admin dinâmico) — label reflete o role real do utilizador */}
        <span className="text-xs text-side-muted">{roleLabel}</span>
      </div>
    </div>
  );

  return (
    <>
      {/* Cabeçalho mobile com sino de notificações */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:hidden">
        <Button
          variant="ghost"
          size="icon" className="h-11 w-11 sm:h-9 sm:w-9"
          onClick={() => setOpen(true)}
          aria-label="Abrir menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        {/* FIX (perfil admin dinâmico) — saudação reflete o role real */}
        <span className="flex-1 text-sm font-semibold">All2gether — {roleLabel}</span>
        <NotificationBell />
      </header>

      {/* Sidebar — desktop */}
      <aside className="hidden w-56 shrink-0 border-r bg-side text-side-foreground lg:flex lg:flex-col">
        <Brand />
        <NavLinks />
        <div className="mt-auto space-y-2 border-t p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-side-muted">Notificações</span>
            <NotificationBell paraCima />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-side-muted">Tema</span>
            <ThemeToggle />
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-sm text-side-muted hover:text-destructive"
            onClick={() => fazerLogout()}
          >
            <LogOut className="h-4 w-4" />
            Terminar sessão
          </Button>
          <p className="text-xs text-side-muted">
            © {new Date().getFullYear()} All2gether
          </p>
        </div>
      </aside>

      {/* Sidebar — mobile (overlay) */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 top-0 flex h-full w-72 max-w-[80%] flex-col bg-side text-side-foreground shadow-xl">
            <div className="flex h-16 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Sparkles className="h-5 w-5" />
                </div>
                <span className="text-sm font-bold">All2gether</span>
              </div>
              <Button
                variant="ghost"
                size="icon" className="h-11 w-11 sm:h-9 sm:w-9"
                onClick={() => setOpen(false)}
                aria-label="Fechar menu"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <NavLinks />
            {/* HF15 — Footer do menu mobile com notificações, tema e logout.
                Antes o overlay mobile só tinha Brand + NavLinks — o logout
                ficava inacessível em telemóveis/tablets. */}
            <div className="mt-auto space-y-2 border-t p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-side-muted">Notificações</span>
                <NotificationBell />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-side-muted">Tema</span>
                <ThemeToggle />
              </div>
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-sm text-side-muted hover:text-destructive"
                onClick={() => fazerLogout()}
              >
                <LogOut className="h-4 w-4" />
                Terminar sessão
              </Button>
              <p className="text-xs text-side-muted">
                © {new Date().getFullYear()} All2gether
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
