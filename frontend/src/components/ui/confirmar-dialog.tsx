"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Pedido de confirmação para ações que se fazem já e não se desfazem (usa o Dialog do projeto, nunca window.confirm).
 * O foco abre em «Cancelar»: Enter sem querer não executa a ação.
 */
export function ConfirmarDialog({
  aberto, titulo, descricao, textoConfirmar, aoConfirmar, aoCancelar, ocupado = false,
}: {
  aberto: boolean;
  titulo: string;
  descricao: string;
  textoConfirmar: string;
  aoConfirmar: () => void;
  aoCancelar: () => void;
  ocupado?: boolean;
}) {
  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o && !ocupado) aoCancelar(); }}>
      <DialogHeader>
        <DialogTitle>{titulo}</DialogTitle>
        <DialogDescription>{descricao}</DialogDescription>
        <DialogClose onClick={aoCancelar} />
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" className="min-h-11" data-autofocus disabled={ocupado} onClick={aoCancelar}>Cancelar</Button>
        <Button className="min-h-11" disabled={ocupado} onClick={aoConfirmar}>{ocupado && <Loader2 className="h-4 w-4 animate-spin" />} {textoConfirmar}</Button>
      </DialogFooter>
    </Dialog>
  );
}
