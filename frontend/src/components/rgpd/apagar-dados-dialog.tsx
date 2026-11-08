"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminPost } from "@/lib/api";

export interface PessoaApagar {
  _id: string;
  nome: string;
  email: string;
}

export const PALAVRA_CONFIRMACAO = "APAGAR";

/** A confirmação só vale com a palavra exata (sem espaços a mais nem minúsculas). */
export function confirmacaoValida(texto: string): boolean {
  return texto === PALAVRA_CONFIRMACAO;
}

/**
 * Diálogo destrutivo do RGPD «Apagar dados pessoais» de uma pessoa da equipa.
 * Pede para escrever APAGAR; o botão só fica ativo com a palavra certa.
 */
export function ApagarDadosDialog({
  pessoa,
  onFechar,
  onConcluido,
}: {
  pessoa: PessoaApagar | null;
  onFechar: () => void;
  onConcluido: (mensagem: string) => void;
}) {
  const [texto, setTexto] = useState("");
  const [a, setA] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (pessoa) {
      setTexto("");
      setErro(null);
      setA(false);
    }
  }, [pessoa]);

  async function apagar() {
    if (!pessoa || !confirmacaoValida(texto)) return;
    setA(true);
    setErro(null);
    try {
      const r = await adminPost<{ mensagem?: string }>(`/api/gestor/equipa/${pessoa._id}/apagar-dados-pessoais`, {
        confirmar: PALAVRA_CONFIRMACAO,
      });
      onConcluido(r.mensagem || "Dados pessoais apagados.");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível apagar os dados.");
    } finally {
      setA(false);
    }
  }

  return (
    <Dialog open={pessoa !== null} onOpenChange={(o) => !o && !a && onFechar()}>
      <DialogHeader>
        <div>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldX className="h-5 w-5" />
            Apagar dados pessoais
          </DialogTitle>
          <DialogDescription>Esta ação é permanente e não pode ser desfeita.</DialogDescription>
        </div>
        <DialogClose onClick={() => !a && onFechar()} />
      </DialogHeader>
      <DialogContent className="space-y-3">
        <p className="text-sm">
          Vais apagar os dados pessoais de <span className="break-words font-semibold">{pessoa?.nome}</span>{" "}
          <span className="break-all text-muted-foreground">({pessoa?.email})</span>.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>O nome passa a «Pessoa removida»; email, telemóvel, NIF e observações são apagados e a conta fica sem acesso.</li>
          <li>As notificações e as ausências desta pessoa são apagadas.</li>
          <li>As limpezas futuras que tinha voltam a ser distribuídas.</li>
          <li>As limpezas passadas ficam no histórico, sem identificação.</li>
        </ul>
        <p className="text-xs text-muted-foreground">
          Se a pessoa pediu os seus dados, usa primeiro «Exportar dados». Fica registado na auditoria que fizeste este pedido.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="confirmar-apagar" className="text-sm font-medium">
            Escreve <span className="font-mono font-bold">{PALAVRA_CONFIRMACAO}</span> para confirmar
          </label>
          <Input
            id="confirmar-apagar"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            disabled={a}
            placeholder={PALAVRA_CONFIRMACAO}
          />
        </div>
        {erro && (
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{erro}</span>
          </p>
        )}
      </DialogContent>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onFechar} disabled={a}>
          Cancelar
        </Button>
        <Button type="button" variant="destructive" onClick={apagar} disabled={a || !confirmacaoValida(texto)}>
          {a ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />A apagar…
            </>
          ) : (
            <>
              <ShieldX className="h-4 w-4" />
              Apagar dados pessoais
            </>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
