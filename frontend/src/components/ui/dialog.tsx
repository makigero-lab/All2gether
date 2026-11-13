"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Modal/Dialog simples (sem Radix) com backdrop, fecho ao clicar fora / Esc.
 * Estilo shadcn New York (radius 0.25rem, shadow-sm, border hairline).
 */

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** No telemóvel o painel ocupa o ecrã inteiro (formulários longos). */
  ecraInteiroNoTelemovel?: boolean;
}

/** Liga o DialogTitle ao painel (aria-labelledby). */
const DialogTitleIdContext = React.createContext<string | undefined>(undefined);

/** Pilha de diálogos abertos: só o do topo reage ao Esc / prende o foco. */
const pilhaDialogs: string[] = [];

const FOCAVEIS =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onOpenChange, children, ecraInteiroNoTelemovel = false }: DialogProps) {
  const id = React.useId();
  const titleId = `${id}-titulo`;
  const painelRef = React.useRef<HTMLDivElement>(null);
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // Esc (só no diálogo do topo), focus-trap (Tab) e devolução do foco ao fechar.
  React.useEffect(() => {
    if (!open) return;
    const anterior = document.activeElement as HTMLElement | null;
    pilhaDialogs.push(id);

    // Foca o painel (ou o 1.º elemento focável) ao abrir.
    const painel = painelRef.current;
    if (painel && !painel.contains(document.activeElement)) {
      painel.focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (pilhaDialogs[pilhaDialogs.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChangeRef.current(false);
        return;
      }
      if (e.key === "Tab" && painelRef.current) {
        const itens = Array.from(
          painelRef.current.querySelectorAll<HTMLElement>(FOCAVEIS)
        ).filter((el) => el.offsetParent !== null);
        if (itens.length === 0) {
          e.preventDefault();
          painelRef.current.focus();
          return;
        }
        const primeiro = itens[0];
        const ultimo = itens[itens.length - 1];
        const ativo = document.activeElement;
        if (e.shiftKey && (ativo === primeiro || ativo === painelRef.current)) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && ativo === ultimo) {
          e.preventDefault();
          primeiro.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const i = pilhaDialogs.lastIndexOf(id);
      if (i >= 0) pilhaDialogs.splice(i, 1);
      anterior?.focus?.();
    };
  }, [open, id]);

  // Bloqueia scroll do body quando aberto.
  React.useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  // Em portal no body: dentro de um pai com transform (ex.: cartão com active:scale) o
  // "fixed" deixava de ser relativo ao ecrã e o diálogo saltava ao carregar nele.
  return createPortal(
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center p-4", ecraInteiroNoTelemovel && "max-sm:p-0")}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      {/* Painel */}
      <div
        ref={painelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex w-full max-w-[min(32rem,calc(100vw-2rem))] max-h-[90vh] flex-col overflow-y-auto rounded-md border border-border/60 bg-card shadow-lg outline-none",
          ecraInteiroNoTelemovel && "sm:max-w-3xl max-sm:h-full max-sm:max-h-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        )}
      >
        <DialogTitleIdContext.Provider value={titleId}>
          {children}
        </DialogTitleIdContext.Provider>
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("relative flex shrink-0 items-center justify-between border-b py-4 pl-6 pr-16", className)}>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function DialogTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const titleId = React.useContext(DialogTitleIdContext);
  return (
    <h2 id={titleId} className={cn("text-base font-semibold tracking-tight", className)}>
      {children}
    </h2>
  );
}

export function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p className={cn("mt-1 text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function DialogClose({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Fechar diálogo"
      className={cn(
        "absolute right-2 top-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        className
      )}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

export function DialogContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  // Corpo com scroll próprio: o cabeçalho e o rodapé ficam sempre visíveis (ver DialogFooter).
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-4", className)}>{children}</div>;
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-card px-4 py-4 sm:px-6",
        className
      )}
    >
      {children}
    </div>
  );
}
