import { Wrench } from "lucide-react";
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

/**
 * Tipo de limpeza com FORMA e cor (nunca só a cor): círculo normal, anel intermédia,
 * quadrado profunda, losango preparação (ver `.tipo-marca` em globals.css) + o nome.
 */
export function TipoMarca({ tipo, soMarca = false, className = "" }: { tipo?: string | null; soMarca?: boolean; className?: string }) {
  const t = tipoOuNormal(tipo);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm ${className}`} title={`Tipo de limpeza: ${ROTULO_TIPO[t]}`}>
      <span className="tipo-marca" data-tipo={t} aria-hidden="true" />
      {soMarca ? <span className="sr-only">{ROTULO_TIPO[t]}</span> : ROTULO_TIPO[t]}
    </span>
  );
}

/** Etiqueta das tarefas de manutenção (ícone de ferramenta + texto, nunca só a cor). */
export function EtiquetaManutencao({ className = "" }: { className?: string }) {
  return (
    <Badge variant="outline" className={`shrink-0 gap-1 whitespace-nowrap px-1.5 py-0 text-xs ${className}`} title="Tarefa de manutenção">
      <Wrench className="h-3 w-3" aria-hidden="true" />
      Manutenção
    </Badge>
  );
}
