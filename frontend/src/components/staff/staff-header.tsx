"use client";

/**
 * StaffHeader — Cabeçalho partilhado do Staff (HF15)
 *
 * Garante que o botão "Terminar Sessão" está sempre visível em TODAS as
 * páginas do staff (dashboard, calendário, ausências, notificações), mesmo
 * em ecrãs mobile. Antes o logout só existia no header de /staff/page.tsx —
 * nas outras páginas ficava inacessível.
 *
 * Props:
 *   - title: título da página (ex: "Calendário", "Ausências")
 *   - showBack: se true, mostra botão "Voltar" para /staff
 *   - userName: nome do utilizador (opcional — se não vier, não mostra avatar)
 */

import Link from "next/link";
import { ArrowLeft, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fazerLogout } from "@/lib/auth";
import { NotificationBell } from "@/components/notification-bell";

interface StaffHeaderProps {
  title?: string;
  showBack?: boolean;
  userName?: string;
}

export function StaffHeader({ title, showBack = false, userName }: StaffHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 px-5 pb-4 pt-6 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {showBack && (
            <Link
              href="/staff"
              prefetch
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Voltar</span>
            </Link>
          )}
          {title && (
            <span className="text-lg font-semibold leading-tight">
              {title}
            </span>
          )}
          {userName && !title && (
            <>
              <span className="text-xs text-muted-foreground">Bem-vindo,</span>
              <span className="text-lg font-semibold leading-tight">
                {userName}
              </span>
            </>
          )}
        </div>
        {/* Sino de Notificações + Botão logout — sempre visíveis */}
        <div className="flex items-center gap-1">
          <NotificationBell />
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => fazerLogout()}
            aria-label="Terminar sessão"
            title="Terminar sessão"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
