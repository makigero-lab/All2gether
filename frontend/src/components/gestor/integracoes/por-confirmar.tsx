"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Ban, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { adminGet, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { msgErro } from "./tipos";

interface Externa {
  _id: string;
  parceiro: { _id: string; nome: string } | null;
  propriedade: { _id: string; nome: string };
  canal_texto: string;
  check_in: string;
  check_out: string;
  noites: number;
  motivo: "sobreposicao" | "periodo_longo" | "reapareceu" | null;
}

const fmt = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

/** Agrupa por proprietário e depois por casa (função pura). */
export function agrupar(lista: Externa[]): { parceiro: string; parceiroId: string; casas: { casa: string; itens: Externa[] }[] }[] {
  const mapa = new Map<string, { parceiro: string; parceiroId: string; casas: Map<string, Externa[]> }>();
  for (const x of lista) {
    const pid = x.parceiro?._id ?? "?";
    if (!mapa.has(pid)) mapa.set(pid, { parceiro: x.parceiro?.nome ?? "Sem proprietário", parceiroId: pid, casas: new Map() });
    const g = mapa.get(pid)!;
    if (!g.casas.has(x.propriedade.nome)) g.casas.set(x.propriedade.nome, []);
    g.casas.get(x.propriedade.nome)!.push(x);
  }
  return [...mapa.values()].sort((a, b) => a.parceiro.localeCompare(b.parceiro, "pt")).map((g) => ({
    parceiro: g.parceiro, parceiroId: g.parceiroId, casas: [...g.casas.entries()].map(([casa, itens]) => ({ casa, itens })),
  }));
}

/**
 * Separador «Reservas por confirmar»: a lista única da empresa, agrupada por proprietário e casa, com ações em lote
 * (Confirmar / É um bloqueio). Os períodos com mais de 30 noites (normalmente fechos do calendário) ficam agrupados e fechados.
 */
export function ReservasPorConfirmarGestor({ proprietariosComErro, disponivel, aoMudar }: { proprietariosComErro: Set<string>; disponivel: boolean; aoMudar: () => void }) {
  const [lista, setLista] = useState<Externa[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [escolhidos, setEscolhidos] = useState<Set<string>>(new Set());
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await adminGet<{ reservas_externas: Externa[] }>("/api/gestor/reservas-externas?estado=por_confirmar");
      setLista(r.reservas_externas ?? []); setErro(null);
    } catch (e) { setErro(msgErro(e, "Não foi possível carregar os períodos por confirmar.")); }
  }, []);
  useEffect(() => { void carregar(); }, [carregar]);

  const normais = useMemo(() => (lista ?? []).filter((x) => x.motivo !== "periodo_longo"), [lista]);
  const longos = useMemo(() => (lista ?? []).filter((x) => x.motivo === "periodo_longo"), [lista]);

  const alternar = (ids: string[], ligar: boolean) => setEscolhidos((s) => { const n = new Set(s); ids.forEach((i) => (ligar ? n.add(i) : n.delete(i))); return n; });

  const decidir = async (ids: string[], acao: "confirmar" | "bloqueio") => {
    if (ids.length === 0) return;
    setOcupado(true); setErro(null); setResultado(null);
    try {
      const r = await adminPost<{ ok: number; falhas: number }>("/api/gestor/reservas-externas/lote", { ids, acao });
      setResultado(`${acao === "confirmar" ? "Confirmados" : "Marcados como bloqueio"}: ${r.ok}${r.falhas ? ` · ${plural(r.falhas, "não foi possível tratar", "não foi possível tratar")}` : ""}.`);
      setEscolhidos(new Set()); await carregar(); aoMudar();
    } catch (e) { setErro(msgErro(e, "Não foi possível guardar a decisão.")); await carregar(); }
    finally { setOcupado(false); }
  };

  const linha = (x: Externa) => (
    <li key={x._id} className="flex items-center gap-3 py-2">
      <Checkbox checked={escolhidos.has(x._id)} onCheckedChange={(v) => alternar([x._id], v)} aria-label={`Escolher ${x.propriedade.nome}, ${fmt(x.check_in)} a ${fmt(x.check_out)}`} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{fmt(x.check_in)} a {fmt(x.check_out)} <span className="font-normal text-muted-foreground">({plural(x.noites, "noite")})</span></p>
        <p className="text-xs text-muted-foreground">{x.canal_texto}{x.motivo === "sobreposicao" && " · coincide com outra reserva"}{x.motivo === "reapareceu" && " · voltou a aparecer no calendário"}</p>
      </div>
    </li>
  );

  if (!lista && !erro) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>;
  const grupos = agrupar(normais);

  return (
    <div className="space-y-4">
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {resultado && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{resultado}</p>}
      {lista && lista.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Não há períodos por confirmar. O Airbnb confirma-se sozinho; aqui aparecem os fechos do Booking.com.</p>}
      {lista && lista.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background p-2" role="toolbar" aria-label="Ações em lote">
          <span className="text-sm">{escolhidos.size ? plural(escolhidos.size, "escolhido", "escolhidos") : `${lista.length} por confirmar`}</span>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={ocupado || !lista.length} onClick={() => setEscolhidos(new Set(normais.map((x) => x._id)))}>Escolher todos</Button>
          <Button size="sm" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || !disponivel || escolhidos.size === 0} onClick={() => decidir([...escolhidos], "confirmar")}>{ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar</Button>
          <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || escolhidos.size === 0} onClick={() => decidir([...escolhidos], "bloqueio")}><Ban className="h-4 w-4" /> É um bloqueio</Button>
        </div>
      )}
      {grupos.map((g) => (
        <section key={g.parceiroId} className="space-y-2" aria-label={g.parceiro}>
          <h2 className="text-base font-semibold">{g.parceiro}</h2>
          {proprietariosComErro.has(g.parceiroId) && <p className="flex items-center gap-1.5 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" aria-hidden /> A ligação deste proprietário tem um erro: podem faltar períodos. Vê o separador «Por proprietário».</p>}
          {g.casas.map((c) => {
            const ids = c.itens.map((x) => x._id);
            return (
              <div key={c.casa} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{c.casa} <span className="font-normal text-muted-foreground">· {c.itens.length}</span></h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} onClick={() => alternar(ids, !ids.every((i) => escolhidos.has(i)))}>{ids.every((i) => escolhidos.has(i)) ? "Limpar" : "Escolher a casa"}</Button>
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} onClick={() => decidir(ids, "bloqueio")}>Todos bloqueio</Button>
                  </div>
                </div>
                <ul className="mt-1 divide-y">{c.itens.map(linha)}</ul>
              </div>
            );
          })}
        </section>
      ))}
      {longos.length > 0 && (
        <details className="rounded-md border bg-muted/30 p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium sm:min-h-9">{plural(longos.length, "período")} com mais de 30 noites (normalmente são fechos do calendário)</summary>
          <div className="space-y-2 pt-2">
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={ocupado} onClick={() => decidir(longos.map((x) => x._id), "bloqueio")}>Marcar todos como bloqueio</Button>
            {agrupar(longos).map((g) => (
              <div key={g.parceiroId}>
                <p className="text-sm font-medium">{g.parceiro}</p>
                {g.casas.map((c) => (<div key={c.casa}><p className="text-xs text-muted-foreground">{c.casa}</p><ul className="divide-y">{c.itens.map(linha)}</ul></div>))}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
