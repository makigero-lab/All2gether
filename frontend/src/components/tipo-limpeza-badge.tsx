import { Badge } from "@/components/ui/badge";
import { ROTULO_TIPO, tipoOuNormal } from "@/lib/rascunho-reservas";

/** Rótulo do tipo de limpeza; sem o campo (tarefas antigas, Smoobu) = Normal. */
export function rotuloTipoLimpeza(tipo?: string | null): string {
  return ROTULO_TIPO[tipoOuNormal(tipo)];
}

/**
 * Etiqueta do tipo de limpeza. Por omissão só aparece nos tipos especiais
 * (intermédia, profunda, preparação); `sempre` mostra também «Normal».
 * O tipo não muda preços nem faturação.
 */
export function TipoLimpezaBadge({
  tipo,
  sempre = false,
  className,
}: {
  tipo?: string | null;
  sempre?: boolean;
  className?: string;
}) {
  const t = tipoOuNormal(tipo);
  if (t === "normal" && !sempre) return null;
  return (
    <Badge
      variant={t === "normal" ? "outline" : "secondary"}
      className={`shrink-0 whitespace-nowrap px-1.5 py-0 text-xs ${className ?? ""}`}
      title={`Tipo de limpeza: ${ROTULO_TIPO[t]}`}
    >
      Limpeza {ROTULO_TIPO[t].toLowerCase()}
    </Badge>
  );
}
