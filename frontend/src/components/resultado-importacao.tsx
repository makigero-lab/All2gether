"use client";

/**
 * Resultado de uma importação de Excel: resumo + até 20 linhas com erro
 * (detalheErros devolvido pelo backend). Partilhado por gestor e parceiro.
 */
export function ResultadoImportacao({
  resumo,
  detalheErros,
}: {
  resumo: string;
  detalheErros?: string[];
}) {
  const linhas = (detalheErros ?? []).slice(0, 20);
  return (
    <div className="rounded-md bg-muted/50 p-3 text-sm" role="status">
      <span className="font-medium">Resultado: </span>
      {resumo}
      {linhas.length > 0 && (
        <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-destructive">
          {linhas.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Normaliza o campo detalheErros vindo da API para string[]. */
export function lerDetalheErros(valor: unknown): string[] {
  return Array.isArray(valor)
    ? valor.filter((v): v is string => typeof v === "string").slice(0, 20)
    : [];
}
