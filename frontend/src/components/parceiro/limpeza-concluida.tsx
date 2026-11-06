"use client";

import { useState } from "react";
import { Camera, CheckCircle2, Loader2 } from "lucide-react";

import { adminGet } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";

interface LimpezaDTO {
  casa: string | null;
  data: string;
  estado: string;
  hora_conclusao: string | null;
  fotos: string[];
  fotos_expiradas: boolean;
}

/** «HH:mm» (Lisboa) de um ISO, ou null. */
export function horaDe(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });
}

/**
 * Na linha da reserva: «Concluída às 11:42» e um botão que abre o detalhe da limpeza
 * (hora e fotos, enquanto existirem — ficam guardadas 7 dias). O parceiro não vê mais nada.
 */
export function LimpezaConcluida({
  reservaId,
  hora,
  casa,
  compacto = false,
}: {
  reservaId: string;
  hora: string | null;
  casa: string;
  compacto?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const [dados, setDados] = useState<LimpezaDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [a, setA] = useState(false);
  const [ampliada, setAmpliada] = useState<string | null>(null);

  async function abrir() {
    setAberto(true);
    setErro(null);
    setA(true);
    try {
      setDados(await adminGet<LimpezaDTO>(`/api/parceiro/reservas/${reservaId}/limpeza`));
    } catch (e) {
      setErro(mensagemErro(e, "Não foi possível carregar a limpeza."));
    } finally {
      setA(false);
    }
  }

  const h = horaDe(hora);
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1 rounded bg-status-conc-bg px-1.5 py-0.5 text-xs font-medium text-status-conc">
          <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          {h ? `Concluída às ${h}` : "Concluída"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={compacto ? "h-11 px-2" : "h-8 px-2"}
          onClick={abrir}
          aria-label={`Ver a limpeza concluída de ${casa}`}
        >
          <Camera className="h-4 w-4" />
          <span className="ml-1 text-xs">Ver</span>
        </Button>
      </span>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogHeader>
          <div>
            <DialogTitle>Limpeza concluída</DialogTitle>
            <DialogDescription>{casa}</DialogDescription>
          </div>
          <DialogClose onClick={() => setAberto(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          {a && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
            </p>
          )}
          {erro && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {erro}
            </p>
          )}
          {dados && (
            <>
              <p className="text-sm">
                <strong>Concluída às {horaDe(dados.hora_conclusao) ?? "—"}</strong>
              </p>
              {dados.fotos.length > 0 ? (
                <ul className="grid grid-cols-2 gap-2">
                  {dados.fotos.map((f, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => setAmpliada(f)} className="block w-full overflow-hidden rounded-md border" aria-label={`Ampliar foto ${i + 1}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f} alt={`Foto ${i + 1} da limpeza`} className="h-28 w-full object-cover" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                  {dados.fotos_expiradas
                    ? "As fotos já não estão disponíveis: ficam guardadas durante 7 dias após a limpeza."
                    : "Esta limpeza não tem fotos."}
                </p>
              )}
              {ampliada && (
                <div className="space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ampliada} alt="Foto ampliada da limpeza" className="max-h-[60vh] w-full rounded-md object-contain" />
                  <Button variant="outline" size="sm" onClick={() => setAmpliada(null)}>
                    Fechar foto
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
        <DialogFooter>
          <Button size="touch" variant="outline" onClick={() => setAberto(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
