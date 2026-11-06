"use client";

/**
 * Resultado de uma importação de Excel: resumo (inclui quantas ficaram
 * atribuídas e por atribuir), até 20 linhas com erro (detalheErros) e, para o
 * gestor, até 50 linhas por atribuir com o motivo (detalheNaoAtribuidas).
 * Partilhado por gestor e parceiro.
 */
export function ResultadoImportacao({
  resumo,
  detalheErros,
  naoAtribuidas,
}: {
  resumo: string;
  detalheErros?: string[];
  naoAtribuidas?: string[];
}) {
  const linhas = (detalheErros ?? []).slice(0, 20);
  const porAtribuir = (naoAtribuidas ?? []).slice(0, 50);
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
      {porAtribuir.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="font-medium">Ficaram por atribuir:</p>
          <ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-amber-700 dark:text-amber-400">
            {porAtribuir.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Normaliza o campo detalheErros vindo da API para string[]. */
export function lerDetalheErros(valor: unknown, max = 20): string[] {
  return Array.isArray(valor)
    ? valor.filter((v): v is string => typeof v === "string").slice(0, max)
    : [];
}
