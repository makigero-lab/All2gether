"use client";

import { useRef } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

/** Caixa de pesquisa das listas do gestor (filtra enquanto se escreve). */
export function CaixaPesquisa({
  valor,
  onChange,
  rotulo,
  placeholder,
}: {
  valor: string;
  onChange: (v: string) => void;
  rotulo: string;
  placeholder: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  /** Limpa e devolve o foco à caixa (o botão X desaparece e o foco não se perde). */
  const limpar = () => {
    onChange("");
    ref.current?.focus();
  };

  return (
    <div className="relative w-full sm:max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={ref}
        type="search"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && valor) {
            e.preventDefault();
            e.stopPropagation();
            limpar();
          }
        }}
        placeholder={placeholder}
        aria-label={rotulo}
        className="h-11 pl-9 pr-9 md:h-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {valor && (
        <button
          type="button"
          onClick={limpar}
          aria-label="Limpar pesquisa"
          className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
