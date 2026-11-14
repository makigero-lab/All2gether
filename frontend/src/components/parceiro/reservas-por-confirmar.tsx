"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CalendarClock, Check, Loader2, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmarDialog } from "@/components/ui/confirmar-dialog";
import { adminGet, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { nomesDistintos } from "@/components/gestor/integracoes/tipos";
import { emCurso, hojeLisboaISO, OPCOES_CHEGADA, ordenarPorChegada, passaFiltroChegada, periodoComAno, textoConfirmarBloqueio, type FiltroChegada } from "@/lib/reservas-externas";

export interface ReservaExternaDTO {
  _id: string;
  propriedade: { _id: string; nome: string; morada_curta?: string | null; morada_rua?: string | null; morada_localidade?: string | null };
  canal: string;
  canal_texto: string;
  check_in: string;
  check_out: string;
  noites: number;
  motivo: "sobreposicao" | "periodo_longo" | "reapareceu" | null;
  estado: string;
}

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
  const [filtro, setFiltro] = useState<FiltroChegada>("todas");
  const [aConfirmarBloqueio, setAConfirmarBloqueio] = useState<ReservaExternaDTO[] | null>(null);

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
  // Por chegada (a mais próxima primeiro) e, se o proprietário quiser, só as desta semana ou dos próximos 7 dias.
  const hoje = hojeLisboaISO();
  const visiveis = ordenarPorChegada(lista).filter((x) => passaFiltroChegada(x, filtro, hoje));
  const normais = visiveis.filter((x) => x.motivo !== "periodo_longo");
  const longos = visiveis.filter((x) => x.motivo === "periodo_longo");
  // Casas com o mesmo nome distinguem-se pela morada curta.
  const nomes = nomesDistintos([...new Map(lista.map((x) => [x.propriedade._id, x.propriedade])).values()]);
  const nomeDe = (x: ReservaExternaDTO) => nomes.get(x.propriedade._id) ?? x.propriedade.nome;
  const bloqueioT = aConfirmarBloqueio ? textoConfirmarBloqueio(aConfirmarBloqueio.length, aConfirmarBloqueio.map(nomeDe)) : null;
  // Marcar vários como bloqueio age já e não se desfaz: pede confirmação (um só decide-se logo).
  const pedirBloqueioTodos = (itens: ReservaExternaDTO[]) => { if (itens.length > 1) setAConfirmarBloqueio(itens); else void bloquearTodos(itens); };

  const linha = (x: ReservaExternaDTO) => (
    <li key={x._id} className="flex flex-col gap-2 rounded-md border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          {nomeDe(x)} · {periodoComAno(x)}{" "}
          <span className="font-normal text-muted-foreground">({plural(x.noites, "noite")})</span>
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="rounded border px-1.5 py-0.5 text-foreground" data-plataforma>{x.canal_texto}</span>
          {emCurso(x, hoje) && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-foreground" data-em-curso>Em curso</span>}
          {x.motivo === "sobreposicao" && " · coincide com outra reserva"}
          {x.motivo === "reapareceu" && " · voltou a aparecer no calendário"}
          {" · É uma reserva?"}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" className="min-h-11 flex-1 gap-1 sm:min-h-9 sm:flex-none" disabled={!!aFazer[x._id]} onClick={() => decidir(x._id, "confirmar")} aria-label={`É uma reserva: ${nomeDe(x)}, ${periodoComAno(x)}, ${x.canal_texto}`}>
          {aFazer[x._id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar
        </Button>
        <Button size="sm" variant="outline" className="min-h-11 flex-1 gap-1 sm:min-h-9 sm:flex-none" disabled={!!aFazer[x._id]} onClick={() => decidir(x._id, "bloqueio")} aria-label={`É um bloqueio: ${nomeDe(x)}, ${periodoComAno(x)}, ${x.canal_texto}`}>
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
        {(lista.length > 4 || filtro !== "todas") && (
          <div role="group" aria-label="Filtrar por data de chegada" className="flex flex-wrap items-center gap-1.5" data-filtro-chegada>
            <span className="mr-1 text-xs text-muted-foreground">Chegada:</span>
            {OPCOES_CHEGADA.map((o) => (
              <button key={o.valor} type="button" aria-pressed={filtro === o.valor} title={o.dica} onClick={() => setFiltro(o.valor)}
                className={`min-h-11 rounded-md border px-3 text-sm font-medium sm:min-h-9 ${filtro === o.valor ? "border-primary bg-accent" : "border-input bg-background hover:bg-accent"}`}>
                {o.texto}
              </button>
            ))}
          </div>
        )}
        {visiveis.length === 0 && filtro !== "todas" && <p className="text-sm text-muted-foreground">Nenhum período chega neste intervalo. Escolhe «Todas» para veres os restantes.</p>}
        {normais.length > 0 && <ul className="space-y-2">{normais.map(linha)}</ul>}
        {longos.length > 0 && (
          <details className="rounded-md border bg-muted/30 p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium sm:min-h-9">
              {plural(longos.length, "período")} com mais de 30 noites (normalmente são fechos do calendário)
            </summary>
            <div className="space-y-2 pt-2">
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => pedirBloqueioTodos(longos)} disabled={Object.values(aFazer).some(Boolean)}>
                Marcar todos como bloqueio
              </Button>
              <ul className="space-y-2">{longos.map(linha)}</ul>
            </div>
          </details>
        )}
      </CardContent>
      {aConfirmarBloqueio && bloqueioT && (
        <ConfirmarDialog aberto destrutivo titulo={bloqueioT.titulo} descricao={bloqueioT.descricao} detalhe={bloqueioT.casas} textoConfirmar={bloqueioT.confirmar}
          aoCancelar={() => setAConfirmarBloqueio(null)} aoConfirmar={() => { const itens = aConfirmarBloqueio; setAConfirmarBloqueio(null); void bloquearTodos(itens); }} />
      )}
    </Card>
  );
}
