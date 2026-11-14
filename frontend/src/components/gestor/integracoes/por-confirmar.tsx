"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Ban, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { adminGet, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { agruparFalhas, enviarEmBlocos, msgErro, textoCorte, type RespostaLote } from "./tipos";

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

interface RespostaLista { reservas_externas: Externa[]; total?: number; limite?: number }
type Resultado = { texto: string; falhas: { texto: string; n: number }[]; erro: boolean };

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
 * Os lotes seguem em blocos de 25 com progresso e o resultado fica num aviso fixo, sempre visível.
 */
export function ReservasPorConfirmarGestor({ proprietariosComErro, disponivel, aoMudar }: { proprietariosComErro: Set<string>; disponivel: boolean; aoMudar: () => void }) {
  const [lista, setLista] = useState<Externa[] | null>(null);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const [escolhidos, setEscolhidos] = useState<Set<string>>(new Set());
  const [ocupado, setOcupado] = useState(false);
  const [aCarregarMais, setACarregarMais] = useState(false);
  const [progresso, setProgresso] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [proximosDias, setProximosDias] = useState("");

  const url = useCallback((pular = 0) => `/api/gestor/reservas-externas?estado=por_confirmar${proximosDias ? `&proximos_dias=${proximosDias}` : ""}${pular ? `&pular=${pular}` : ""}`, [proximosDias]);
  // Carregar nunca apaga uma mensagem de erro que acabou de aparecer; só mostra a sua, se falhar.
  const carregar = useCallback(async () => {
    try {
      const r = await adminGet<RespostaLista>(url());
      setLista(r.reservas_externas ?? []); setTotal(r.total ?? (r.reservas_externas ?? []).length);
    } catch (e) { setErro(msgErro(e, "Não foi possível carregar os períodos por confirmar.")); setLista((l) => l ?? []); }
  }, [url]);
  useEffect(() => { void carregar(); }, [carregar]);

  const carregarMais = async () => {
    if (!lista) return;
    setACarregarMais(true);
    try {
      const r = await adminGet<RespostaLista>(url(lista.length));
      setLista((l) => [...(l ?? []), ...(r.reservas_externas ?? [])]); setTotal(r.total ?? total);
    } catch (e) { setErro(msgErro(e, "Não foi possível carregar mais períodos.")); } finally { setACarregarMais(false); }
  };

  const normais = useMemo(() => (lista ?? []).filter((x) => x.motivo !== "periodo_longo"), [lista]);
  const longos = useMemo(() => (lista ?? []).filter((x) => x.motivo === "periodo_longo"), [lista]);

  const alternar = (ids: string[], ligar: boolean) => setEscolhidos((s) => { const n = new Set(s); ids.forEach((i) => (ligar ? n.add(i) : n.delete(i))); return n; });

  const decidir = async (ids: string[], acao: "confirmar" | "bloqueio") => {
    if (ids.length === 0) return;
    const verbo = acao === "confirmar" ? "confirmar" : "marcar como bloqueio";
    setOcupado(true); setErro(null); setResultado(null);
    setProgresso(`A ${verbo} ${ids.length}: 0/${ids.length}… isto pode demorar até 1 minuto.`);
    const r = await enviarEmBlocos(ids, acao, (corpo) => adminPost<RespostaLote>("/api/gestor/reservas-externas/lote", corpo), (feitos) => setProgresso(`A ${verbo} ${ids.length}: ${feitos}/${ids.length}… isto pode demorar até 1 minuto.`));
    setProgresso(null);
    const feitos = r.ok;
    const base = `${acao === "confirmar" ? "Confirmados" : "Marcados como bloqueio"}: ${feitos} de ${ids.length}.`;
    const naoFez = r.restantes.length > 0 ? ` Ficaram ${r.restantes.length} por tratar: ${r.erro ?? "tenta outra vez."}` : "";
    const comFalhas = r.falhas.length > 0 ? ` ${r.falhas.length === 1 ? "1 não foi tratado" : `${r.falhas.length} não foram tratados`}:` : "";
    setResultado({ texto: base + comFalhas + naoFez, falhas: agruparFalhas(r.falhas), erro: r.restantes.length > 0 || r.falhas.length > 0 });
    setEscolhidos(new Set(r.restantes));
    await carregar(); aoMudar();
    setOcupado(false);
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
  const corte = textoCorte(lista?.length ?? 0, total);

  return (
    <div className="space-y-4">
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {lista && lista.length === 0 && !resultado && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Não há períodos por confirmar{proximosDias ? " neste intervalo" : ""}. O Airbnb confirma-se sozinho; aqui aparecem os fechos do Booking.com.</p>}
      {(lista && lista.length > 0) || resultado || progresso ? (
        <div className="sticky top-0 z-10 space-y-2 rounded-md border bg-background p-2" data-barra-lote>
          {lista && lista.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Ações em lote">
              <span className="text-sm">{escolhidos.size ? plural(escolhidos.size, "escolhido", "escolhidos") : `${total} por confirmar`}</span>
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={ocupado || !lista.length} onClick={() => setEscolhidos(new Set(normais.map((x) => x._id)))}>Escolher todos</Button>
              <Button size="sm" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || !disponivel || escolhidos.size === 0} onClick={() => decidir([...escolhidos], "confirmar")}>{ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar</Button>
              <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || escolhidos.size === 0} onClick={() => decidir([...escolhidos], "bloqueio")}><Ban className="h-4 w-4" /> É um bloqueio</Button>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                Entram nos próximos
                <select value={proximosDias} onChange={(e) => { setProximosDias(e.target.value); setEscolhidos(new Set()); }} disabled={ocupado} aria-label="Filtrar por data de entrada" className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
                  <option value="">Todos os períodos</option>
                  <option value="7">7 dias</option>
                  <option value="30">30 dias</option>
                </select>
              </label>
            </div>
          )}
          {progresso && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {progresso}</p>}
          {resultado && !progresso && (
            <div role="status" className={`flex items-start gap-2 rounded-md p-2 text-sm ${resultado.erro ? "bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"}`} data-resultado-lote>
              <div className="min-w-0 flex-1">
                <p>{resultado.texto}</p>
                {resultado.falhas.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{resultado.falhas.map((f) => <li key={f.texto}>{f.n} × {f.texto}</li>)}</ul>}
              </div>
              <button type="button" onClick={() => setResultado(null)} aria-label="Fechar o resultado" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5"><X className="h-4 w-4" aria-hidden /></button>
            </div>
          )}
          {lista && lista.length > 0 && longos.length > 0 && <p className="text-xs text-muted-foreground">«Escolher todos» não inclui os {longos.length} períodos com mais de 30 noites (ver mais abaixo).</p>}
        </div>
      ) : null}
      {corte && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/60 p-2 text-sm" data-corte>
          <span>{corte} Usa o filtro por data ou carrega mais.</span>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={aCarregarMais || ocupado} onClick={carregarMais}>{aCarregarMais && <Loader2 className="h-4 w-4 animate-spin" />} Carregar mais</Button>
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
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} onClick={() => alternar(ids, !ids.every((i) => escolhidos.has(i)))}>{ids.every((i) => escolhidos.has(i)) ? "Limpar" : "Escolher a casa"}</Button>
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} onClick={() => decidir(ids, "bloqueio")}>Marcar todos como bloqueio</Button>
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
