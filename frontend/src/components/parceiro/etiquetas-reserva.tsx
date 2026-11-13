import { RefreshCw, Lock } from "lucide-react";

/** Campos das reservas que dizem de onde vêm (calendário externo, gestor). */
export interface OrigemReserva {
  origem?: "manual" | "ical" | null;
  sincronizada?: boolean;
  plataforma?: string | null;
  cancelada_em?: string | null;
  cancelada_motivo?: "canal" | "parceiro" | "ligacao_removida" | null;
  criada_pelo_gestor?: boolean;
}

const base = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium";

/**
 * Etiquetas discretas de uma reserva: vem do Airbnb/Booking (datas só de leitura), cancelada no canal,
 * ou marcada pela All2gether. Nunca dependem só da cor: levam sempre texto.
 */
export function EtiquetasReserva({ r }: { r?: OrigemReserva | null }) {
  if (!r) return null;
  const canal = r.plataforma || "calendário";
  const ical = r.origem === "ical";
  const cancelada = !!r.cancelada_em;
  return (
    <>
      {ical && !cancelada && (
        <span className={`${base} bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100`} title={`Vem do ${canal}: as datas só se alteram lá.`}>
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> {canal}
          {r.sincronizada && <Lock className="h-3 w-3" aria-label="Datas só de leitura" />}
        </span>
      )}
      {!ical && r.sincronizada && !cancelada && (
        <span className={`${base} bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100`} title={`Atualizada pelo ${canal}: as datas só se alteram lá.`}>
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Atualizada pelo {canal} <Lock className="h-3 w-3" aria-label="Datas só de leitura" />
        </span>
      )}
      {cancelada && (
        <span className={`${base} bg-muted text-muted-foreground`}>
          {r.cancelada_motivo === "canal" ? `Cancelada no ${canal}` : r.cancelada_motivo === "ligacao_removida" ? "Calendário desligado" : "Reserva cancelada"}
        </span>
      )}
      {r.criada_pelo_gestor && (
        <span className={`${base} border border-muted-foreground/30 text-muted-foreground`} title="Esta reserva foi marcada pela equipa da All2gether em teu nome.">
          Marcada pela All2gether
        </span>
      )}
    </>
  );
}
