"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CalendarClock, Check, Loader2, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { adminGet, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";

export interface ReservaExternaDTO {
  _id: string;
  propriedade: { _id: string; nome: string };
  canal: string;
  canal_texto: string;
  check_in: string;
  check_out: string;
  noites: number;
  motivo: "sobreposicao" | "periodo_longo" | "reapareceu" | null;
  estado: string;
}

const fmt = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

function mensagem(e: unknown, omissao: string): string {
  const m = (e as { message?: string })?.message;
  return m && m.length < 200 ? m : omissao;
}

/**
 * Períodos vindos de um calendário externo (Booking, outros) que o sistema não sabe se são reservas:
 * o proprietário (ou o gestor, em nome dele) diz «é uma reserva» (cria a limpeza) ou «é um bloqueio»
 * (fica ignorado e não volta a perguntar). Os períodos com mais de 30 noites aparecem agrupados e fechados.
 */
export function ReservasPorConfirmar({
  listaUrl,
  decisaoBase,
  aoMudar,
}: {
  /** GET que devolve { reservas_externas } (por confirmar). */
  listaUrl: string;
  /** Prefixo das decisões: `${decisaoBase}/${id}/confirmar|bloqueio`. */
  decisaoBase: string;
  /** Chamado depois de uma decisão (para recarregar a tabela). */
  aoMudar?: () => void;
}) {
  const [lista, setLista] = useState<ReservaExternaDTO[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aFazer, setAFazer] = useState<Record<string, boolean>>({});
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await adminGet<{ reservas_externas: ReservaExternaDTO[] }>(listaUrl);
      setLista(r.reservas_externas ?? []);
      setErro(null);
    } catch (e) {
      setErro(mensagem(e, "Não foi possível carregar os períodos por confirmar."));
    }
  }, [listaUrl]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const decidir = async (id: string, acao: "confirmar" | "bloqueio") => {
    setAFazer((s) => ({ ...s, [id]: true }));
    setErro(null);
    try {
      const r = await adminPost<{ aviso?: string }>(`${decisaoBase}/${id}/${acao}`, {});
      if (r?.aviso) setAviso(r.aviso);
      await carregar();
      aoMudar?.();
    } catch (e) {
      setErro(mensagem(e, "Não foi possível guardar a decisão."));
      await carregar();
    } finally {
      setAFazer((s) => ({ ...s, [id]: false }));
    }
  };

  const bloquearTodos = async (itens: ReservaExternaDTO[]) => {
    for (const x of itens) {
      // eslint-disable-next-line no-await-in-loop
      await decidir(x._id, "bloqueio");
    }
  };

  if (lista.length === 0 && !erro) return null;
  const normais = lista.filter((x) => x.motivo !== "periodo_longo");
  const longos = lista.filter((x) => x.motivo === "periodo_longo");

  const linha = (x: ReservaExternaDTO) => (
    <li key={x._id} className="flex flex-col gap-2 rounded-md border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          {x.propriedade.nome} · {fmt(x.check_in)} a {fmt(x.check_out)}{" "}
          <span className="font-normal text-muted-foreground">({plural(x.noites, "noite")})</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {x.canal_texto}
          {x.motivo === "sobreposicao" && " · coincide com outra reserva"}
          {x.motivo === "reapareceu" && " · voltou a aparecer no calendário"}
          {" · É uma reserva?"}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" className="min-h-11 flex-1 gap-1 sm:min-h-9 sm:flex-none" disabled={!!aFazer[x._id]} onClick={() => decidir(x._id, "confirmar")} aria-label={`É uma reserva: ${x.propriedade.nome}, ${fmt(x.check_in)} a ${fmt(x.check_out)}`}>
          {aFazer[x._id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar
        </Button>
        <Button size="sm" variant="outline" className="min-h-11 flex-1 gap-1 sm:min-h-9 sm:flex-none" disabled={!!aFazer[x._id]} onClick={() => decidir(x._id, "bloqueio")} aria-label={`É um bloqueio: ${x.propriedade.nome}, ${fmt(x.check_in)} a ${fmt(x.check_out)}`}>
          <Ban className="h-4 w-4" /> É um bloqueio
        </Button>
      </div>
    </li>
  );

  return (
    <Card className="border-amber-500/60" aria-label="Reservas por confirmar">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-2">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <h2 className="text-base font-semibold">Reservas por confirmar ({lista.length})</h2>
            <p className="text-sm text-muted-foreground">
              O Booking não diz se um período fechado é uma reserva ou um bloqueio. Só criamos a limpeza quando confirmas; se disseres que é um
              bloqueio, fica ignorado e não voltamos a perguntar.
            </p>
          </div>
        </div>
        {erro && (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {erro}
          </p>
        )}
        {aviso && <p role="status" className="text-sm text-muted-foreground">{aviso}</p>}
        {normais.length > 0 && <ul className="space-y-2">{normais.map(linha)}</ul>}
        {longos.length > 0 && (
          <details className="rounded-md border bg-muted/30 p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium sm:min-h-9">
              {plural(longos.length, "período")} com mais de 30 noites (normalmente são fechos do calendário)
            </summary>
            <div className="space-y-2 pt-2">
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => bloquearTodos(longos)} disabled={Object.values(aFazer).some(Boolean)}>
                Marcar todos como bloqueio
              </Button>
              <ul className="space-y-2">{longos.map(linha)}</ul>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
