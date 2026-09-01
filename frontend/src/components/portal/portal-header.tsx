"use client";

import { useEffect, useRef, useState } from "react";
import { User, LogOut, ChevronDown } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { lerUtilizador, fazerLogout, type Role } from "@/lib/auth";

/**
 * UserMenu — Dropdown de utilizador partilhado (FIX: header parceiro/fornecedor).
 *
 * Barra de topo com o avatar e nome do utilizador. Ao clicar, abre um menu
 * dropdown com as opções "Perfil" e "Terminar Sessão".
 *
 * Implementado como dropdown nativo (sem Radix DropdownMenu) para não adicionar
 * dependências — segue o mesmo padrão do NotificationBell já existente.
 *
 * Usado nos layouts de /parceiro e /fornecedor (portais externos que não têm
 * a sidebar do gestor com o logout integrado).
 */
export function UserMenu() {
  const [user, setUser] = useState<{ nome: string; role: Role } | null>(null);
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const u = await lerUtilizador();
      if (!cancelado && u) {
        setUser({ nome: u.nome, role: u.role });
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  // Fecha o dropdown ao clicar fora.
  useEffect(() => {
    function handleClickFora(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setAberto(false);
      }
    }
    if (aberto) {
      document.addEventListener("mousedown", handleClickFora);
      return () => document.removeEventListener("mousedown", handleClickFora);
    }
  }, [aberto]);

  // Calcula as iniciais do nome (ex: "João Silva" → "JS").
  function iniciais(nome: string): string {
    const partes = nome.trim().split(/\s+/);
    if (partes.length === 0) return "?";
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-input bg-background px-2 py-1 text-sm transition-colors hover:bg-accent"
        aria-label="Menu do utilizador"
        aria-expanded={aberto}
      >
        <Avatar className="h-7 w-7">
          <AvatarFallback className="text-xs">
            {user ? iniciais(user.nome) : "··"}
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-[120px] truncate font-medium sm:inline">
          {user?.nome ?? "—"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {aberto && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-56 origin-top-right rounded-md border bg-popover p-1 shadow-md"
          role="menu"
        >
          {/* Cabeçalho do menu: nome + role */}
          <div className="border-b px-3 py-2">
            <p className="truncate text-sm font-semibold">{user?.nome ?? "—"}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {user?.role ?? "—"}
            </p>
          </div>

          {/* Perfil — link genérico (página de perfil pode não existir ainda) */}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setAberto(false);
              // FIX: placeholder — a página de perfil não existe ainda nos portais.
              // Quando existir (ex: /parceiro/perfil), redirecionar via router.push.
            }}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm transition-colors hover:bg-accent"
            role="menuitem"
          >
            <User className="h-4 w-4" />
            Perfil
          </a>

          {/* Terminar Sessão */}
          <button
            type="button"
            onClick={() => {
              setAberto(false);
              fazerLogout();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
            role="menuitem"
          >
            <LogOut className="h-4 w-4" />
            Terminar Sessão
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * PortalHeader — Barra de topo para portais externos (parceiro/fornecedor).
 *
 * Contém a marca "All2gether" à esquerda e o UserMenu (avatar + logout) à
 * direita. É sticky no topo para estar sempre visível em qualquer página.
 *
 * Props:
 *   - portalLabel: etiqueta curta do portal (ex: "Parceiro", "Lavandaria")
 */
export function PortalHeader({ portalLabel }: { portalLabel: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur">
      {/* Marca + etiqueta do portal */}
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <span className="text-xs font-bold">A2</span>
        </div>
        <span className="text-sm font-bold">All2gether</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          · {portalLabel}
        </span>
      </div>

      {/* Menu do utilizador (avatar + logout) */}
      <UserMenu />
    </header>
  );
}
