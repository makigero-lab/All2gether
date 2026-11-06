"use client";

import { useState } from "react";
import { Loader2, Play, OctagonAlert } from "lucide-react";

import { adminPatch, adminPost } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";

/** Motivos fixos de «Não consegui começar» (os mesmos valores que o backend aceita). */
export const MOTIVOS_NAO_CONSEGUI = [
  { valor: "hospede_na_casa", texto: "Hóspede ainda na casa" },
  { valor: "sem_acesso", texto: "Sem acesso à casa" },
  { valor: "casa_diferente", texto: "A casa não está como esperado" },
] as const;

type Props = {
  tarefaId: string;
  /** Chamado depois de gravar com sucesso (para recarregar o cartão/detalhe). */
  onFeito: () => void;
  className?: string;
};

/** Botão «Comecei»: grava o início (PATCH /api/staff/tarefas/:id/iniciar). */
export function BotaoComecei({ tarefaId, onFeito, className }: Props) {
  const [a, setA] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function comecar() {
    setA(true);
    setErro(null);
    try {
      await adminPatch(`/api/staff/tarefas/${tarefaId}/iniciar`);
      onFeito();
    } catch (e) {
      setErro(mensagemErro(e, "Não foi possível registar o início."));
    } finally {
      setA(false);
    }
  }

  return (
    <div className={cn("space-y-1", className)}>
      <Button size="touch" className="w-full gap-2" onClick={comecar} disabled={a}>
        {a ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Comecei
      </Button>
      {erro && (
        <p role="alert" className="text-xs text-destructive">
          {erro}
        </p>
      )}
    </div>
  );
}

/** «Não consegui começar»: motivo fixo + nota opcional; avisa o gestor. */
export function BotaoNaoConsegui({ tarefaId, onFeito, className }: Props) {
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState<string>("");
  const [nota, setNota] = useState("");
  const [a, setA] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar() {
    if (!motivo) return;
    setA(true);
    setErro(null);
    try {
      await adminPost(`/api/staff/tarefas/${tarefaId}/nao-consegui`, { motivo, nota: nota.trim() || undefined });
      setAberto(false);
      setMotivo("");
      setNota("");
      onFeito();
    } catch (e) {
      setErro(mensagemErro(e, "Não foi possível avisar o gestor."));
    } finally {
      setA(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className={cn("w-full gap-2 text-muted-foreground", className)}
        onClick={() => {
          setErro(null);
          setAberto(true);
        }}
      >
        <OctagonAlert className="h-4 w-4" />
        Não consegui começar
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogHeader>
          <div>
            <DialogTitle>Não consegui começar</DialogTitle>
            <DialogDescription>O gestor é avisado de imediato. Escolhe o motivo.</DialogDescription>
          </div>
          <DialogClose onClick={() => setAberto(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="sr-only">Motivo</legend>
            {MOTIVOS_NAO_CONSEGUI.map((m) => (
              <label
                key={m.valor}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm",
                  motivo === m.valor ? "border-primary bg-primary/5 font-medium" : "border-input"
                )}
              >
                <input
                  type="radio"
                  name={`motivo-${tarefaId}`}
                  value={m.valor}
                  checked={motivo === m.valor}
                  onChange={() => setMotivo(m.valor)}
                  className="h-4 w-4"
                />
                {m.texto}
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <label htmlFor={`nota-${tarefaId}`} className="text-sm font-medium">
              Nota <span className="font-normal text-muted-foreground">(opcional)</span>
            </label>
            <Textarea
              id={`nota-${tarefaId}`}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Ex.: o hóspede disse que sai às 12h"
            />
          </div>
          {erro && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {erro}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button size="touch" type="button" variant="outline" onClick={() => setAberto(false)} disabled={a}>
            Cancelar
          </Button>
          <Button size="touch" type="button" onClick={enviar} disabled={!motivo || a}>
            {a ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Avisar o gestor
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** «HH:mm» (Lisboa) de um ISO, ou null. */
export function horaCurta(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });
}
