"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";

import { adminPatch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Estados em que o dia ainda se pode mudar (em curso, concluída e cancelada ficam de fora). */
export function podeMudarDia(t: { estado: string; tipo?: string | null }): boolean {
  return ["por_atribuir", "nao_atribuida", "atribuida"].includes(t.estado);
}

const diaLocal = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/**
 * «Mudar dia» (PATCH /api/gestor/tarefas/:id/data): o sistema propõe o dia, o gestor ajusta. O servidor
 * recalcula hora e pessoa (tenta outra se a atual não couber; se ninguém couber fica por atribuir, com
 * o motivo), avisa o proprietário e quem sai/entra, e deixa o dia marcado como ajustado.
 */
export function MudarDiaDialog({
  tarefa,
  open,
  onOpenChange,
  onFeito,
}: {
  tarefa: { _id: string; data: string; propriedade_id?: { nome: string } | null } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Depois de gravar (para a lista recarregar); `aviso` traz «ficou por atribuir» etc. */
  onFeito: (aviso: string | null) => void;
}) {
  const [dia, setDia] = useState("");
  const [hora, setHora] = useState("");
  const [a, setA] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (open && tarefa) {
      setDia(diaLocal(tarefa.data));
      setHora("");
      setErro(null);
    }
  }, [open, tarefa]);

  async function gravar() {
    if (!tarefa || !dia) return;
    setA(true);
    setErro(null);
    try {
      const r = await adminPatch<{ aviso: string | null }>(`/api/gestor/tarefas/${tarefa._id}/data`, {
        data: dia,
        ...(hora ? { hora } : {}),
      });
      onOpenChange(false);
      onFeito(r.aviso ?? null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível mudar o dia.");
    } finally {
      setA(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !a && onOpenChange(o)}>
      <DialogHeader>
        <div>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-brand-text" aria-hidden="true" />
            Mudar dia
          </DialogTitle>
          <DialogDescription>
            {tarefa?.propriedade_id?.nome ?? "Limpeza"}: a hora e a pessoa são recalculadas para o dia novo.
            O proprietário e a equipa são avisados.
          </DialogDescription>
        </div>
        <DialogClose onClick={() => !a && onOpenChange(false)} />
      </DialogHeader>
      <DialogContent className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="mudar-dia" className="text-sm font-medium">Dia novo</label>
          <Input id="mudar-dia" type="date" value={dia} onChange={(e) => setDia(e.target.value)} disabled={a} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="mudar-hora" className="text-sm font-medium">
            Hora <span className="font-normal text-muted-foreground">(opcional: sem hora, o sistema escolhe a mais cedo que couber)</span>
          </label>
          <Input id="mudar-hora" type="time" value={hora} onChange={(e) => setHora(e.target.value)} disabled={a} />
        </div>
        {erro && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {erro}
          </p>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={a}>Cancelar</Button>
        <Button onClick={gravar} disabled={!dia || a}>
          {a ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Mudar dia
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
