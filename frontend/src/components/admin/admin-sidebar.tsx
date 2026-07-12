"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Building2,
  Menu,
  X,
  ShieldCheck,
  LogOut,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fazerLogout } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Prompt 122 — Limpeza do Menu Global.
 *
 * O menu lateral do Admin global tem APENAS 'Empresas' (e Logout).
 * Removidos ESTRITAMENTE os links para 'Sistema' (/admin/sistema) e
 * 'Webhooks' (/admin/webhooks). A gestão de webhooks e sistema global
 * foi consolidada na Gaveta da Empresa (/admin/empresas/[id]).
 */
const adminNavItems: NavItem[] = [
  { label: "Empresas", href: "/admin", icon: Building2 },
];

/**
 * Barra lateral do Painel do Super Admin.
 *
 * Prompt 115 — Separação ABSOLUTA: este componente NÃO importa nem renderiza
 * NADA do gestor. Antes era um componente partilhado com `mode` prop; agora
 * é dedicado ao Admin.
 */
export function AdminSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const basePath = "/admin";

  const isActive = (href: string) =>
    href === basePath ? pathname === href : pathname.startsWith(href);

  const NavLinks = () => (
    <nav className="flex flex-col gap-1 px-3 py-4">
      {adminNavItems.map((item) => {
        const active = isActive(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const Brand = () => (
    <div className="flex h-16 items-center gap-2 border-b px-6">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <ShieldCheck className="h-5 w-5" />
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-sm font-bold">Autocell</span>
        <span className="text-[11px] text-muted-foreground">Super Admin</span>
      </div>
    </div>
  );

  return (
    <>
      {/* Botão de menu — apenas mobile */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Abrir menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="text-sm font-semibold">Autocell — Super Admin</span>
      </header>

      {/* Sidebar — desktop */}
      <aside className="hidden w-64 shrink-0 border-r bg-card lg:flex lg:flex-col">
        <Brand />
        <NavLinks />
        <div className="mt-auto space-y-2 border-t p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Tema</span>
            <ThemeToggle />
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-sm text-muted-foreground hover:text-destructive"
            onClick={() => fazerLogout()}
          >
            <LogOut className="h-4 w-4" />
            Terminar Sessão
          </Button>
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Autocell
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
          <div className="absolute left-0 top-0 flex h-full w-72 max-w-[80%] flex-col bg-card shadow-xl">
            <div className="flex h-16 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <span className="text-sm font-bold">Autocell</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label="Fechar menu"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <NavLinks />
          </div>
        </div>
      )}
    </>
  );
}
