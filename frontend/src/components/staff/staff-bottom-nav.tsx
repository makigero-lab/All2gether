"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, CalendarDays, CalendarOff, ClipboardList } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Barra de navegação inferior fixa da área da Equipa (mobile-first).
 * Os destinos principais ficam sempre à mão e as tarefas ficam logo no topo.
 */
const ITENS = [
  { href: "/staff", label: "Tarefas", icon: ClipboardList, exato: true },
  { href: "/staff/calendario", label: "Agenda", icon: CalendarDays },
  { href: "/staff/ausencias", label: "Ausências", icon: CalendarOff },
  { href: "/staff/notificacoes", label: "Avisos", icon: Bell },
] as const;

export function StaffBottomNav() {
  const pathname = usePathname() || "";

  return (
    <nav
      aria-label="Navegação principal da equipa"
      className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur"
    >
      <ul className="mx-auto flex w-full max-w-md items-stretch justify-around pb-[env(safe-area-inset-bottom)]">
        {ITENS.map(({ href, label, icon: Icon, ...resto }) => {
          const ativo =
            "exato" in resto && resto.exato
              ? pathname === href
              : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                prefetch
                aria-current={ativo ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 py-2 text-xs font-medium transition-colors",
                  ativo
                    ? "text-gold-text"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
