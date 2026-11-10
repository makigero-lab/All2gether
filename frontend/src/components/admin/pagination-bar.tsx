"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PaginationBarProps {
  page: number; // 1-based
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  label?: string; // ex: "membros" / "tarefas"
}

/**
 * Barra de paginação client-side.
 *
 * Mostra: < 1 2 3 ... > | itens por página | total.
 * Quando há apenas 1 página, não renderiza nada (mas mostra a contagem).
 */
export function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50],
  label = "itens",
}: PaginationBarProps) {
  if (total === 0) return null;

  const inicio = (page - 1) * pageSize + 1;
  const fim = Math.min(page * pageSize, total);

  const irPara = (p: number) => {
    const alvo = Math.max(1, Math.min(p, totalPages));
    onPageChange(alvo);
  };

  // Gera os números de página a mostrar (máx 5 à volta da atual + extremos).
  const paginas: (number | "...")[] = [];
  const margem = 1;
  const primeira = 1;
  const ultima = totalPages;
  paginas.push(primeira);
  for (let p = page - margem; p <= page + margem; p++) {
    if (p > primeira && p < ultima) paginas.push(p);
  }
  if (ultima > primeira) paginas.push(ultima);
  // Insere reticências onde há saltos.
  const comReticencias: (number | "...")[] = [];
  for (let i = 0; i < paginas.length; i++) {
    if (i > 0 && typeof paginas[i] === "number" && typeof paginas[i - 1] === "number") {
      if ((paginas[i] as number) - (paginas[i - 1] as number) > 1) {
        comReticencias.push("...");
      }
    }
    comReticencias.push(paginas[i]);
  }

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t px-4 py-3 sm:flex-row">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          A mostrar <strong className="text-foreground">{inicio}–{fim}</strong> de{" "}
          <strong className="text-foreground">{total}</strong> {label}
        </span>
        {onPageSizeChange && (
          <span className="flex items-center gap-1.5">
            <span className="hidden sm:inline">|</span>
            <select
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              aria-label="Itens por página"
              className={cn(
                "h-11 rounded-md border border-input bg-background px-2 text-xs sm:h-7",
                "focus:outline-none focus:ring-2 focus:ring-ring"
              )}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={String(n)}>
                  {n}/pág
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => irPara(1)}
            disabled={page === 1}
            aria-label="Primeira página"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => irPara(page - 1)}
            disabled={page === 1}
            aria-label="Página anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {comReticencias.map((p, i) =>
            p === "..." ? (
              <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
                …
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon"
                className="h-11 w-11 text-xs sm:h-8 sm:w-8"
                onClick={() => irPara(p)}
                aria-label={`Página ${p}`}
                aria-current={p === page ? "page" : undefined}
              >
                {p}
              </Button>
            )
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => irPara(page + 1)}
            disabled={page === totalPages}
            aria-label="Página seguinte"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => irPara(totalPages)}
            disabled={page === totalPages}
            aria-label="Última página"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
