"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Ban, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmarDialog } from "@/components/ui/confirmar-dialog";
import { adminGet, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { emCurso, hojeLisboaISO, OPCOES_CHEGADA, ordenarPorChegada, periodoComAno, textoConfirmarBloqueio, textoLongosDeFora, ultimoDiaDoFiltro, type FiltroChegada } from "@/lib/reservas-externas";
import { agruparFalhas, enviarEmBlocos, msgErro, nomesDistintos, textoCorte, type RespostaLote } from "./tipos";

interface Externa {
  _id: string;
  parceiro: { _id: string; nome: string } | null;
  propriedade: { _id: string; nome: string; morada_curta?: string | null; morada_rua?: string | null; morada_localidade?: string | null };
  canal_texto: string;
  check_in: string;
  check_out: string;
  noites: number;
  motivo: "sobreposicao" | "periodo_longo" | "reapareceu" | null;
}

interface RespostaLista { reservas_externas: Externa[]; total?: number; limite?: number }
type Resultado = { texto: string; falhas: { texto: string; n: number }[]; erro: boolean };

/**
 * Agrupa por proprietário e depois por casa, tudo por data de chegada: dentro de cada casa os períodos vão do mais
 * próximo para o mais distante, e as casas e os proprietários ficam pela primeira chegada (função pura).
 */
export function agrupar(lista: Externa[]): { parceiro: string; parceiroId: string; casas: { casaId: string; casa: string; itens: Externa[] }[] }[] {
  const mapa = new Map<string, { parceiro: string; parceiroId: string; casas: Map<string, { casa: string; itens: Externa[] }> }>();
  // A lista entra já ordenada por chegada, por isso a ordem de inserção dos Map é a da primeira chegada de cada grupo.
  for (const x of ordenarPorChegada(lista)) {
    const pid = x.parceiro?._id ?? "?";
    if (!mapa.has(pid)) mapa.set(pid, { parceiro: x.parceiro?.nome ?? "Sem proprietário", parceiroId: pid, casas: new Map() });
    const g = mapa.get(pid)!;
    // Pelo id da casa: duas casas com o mesmo nome não se fundem.
    if (!g.casas.has(x.propriedade._id)) g.casas.set(x.propriedade._id, { casa: x.propriedade.nome, itens: [] });
    g.casas.get(x.propriedade._id)!.itens.push(x);
  }
  return [...mapa.values()].map((g) => ({
    parceiro: g.parceiro, parceiroId: g.parceiroId, casas: [...g.casas.entries()].map(([casaId, c]) => ({ casaId, casa: c.casa, itens: c.itens })),
  }));
}

/**
 * Separador «Reservas por confirmar»: a lista única da empresa, agrupada por proprietário e casa, com ações em lote
 * (Confirmar / É um bloqueio). Os períodos com mais de 30 noites (normalmente fechos do calendário) ficam agrupados e fechados.
 * Os lotes seguem em blocos de 25 com progresso e o resultado fica num aviso fixo, sempre visível.
 * Marcar vários como bloqueio pede confirmação (age já e não se desfaz aqui).
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
  // «Todas» por defeito: um filtro que esconde períodos sem o gestor o pedir deixaria reservas por decidir fora da vista.
  const [filtro, setFiltro] = useState<FiltroChegada>("todas");
  const [aConfirmarBloqueio, setAConfirmarBloqueio] = useState<{ ids: string[]; casas: string[] } | null>(null);
  const [longosAbertos, setLongosAbertos] = useState(false);
  const longosRef = useRef<HTMLDetailsElement>(null);

  const url = useCallback((pular = 0) => {
    const ate = ultimoDiaDoFiltro(filtro, hojeLisboaISO());
    return `/api/gestor/reservas-externas?estado=por_confirmar${ate ? `&ate=${ate}` : ""}${pular ? `&pular=${pular}` : ""}`;
  }, [filtro]);
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

  // «Marcar como bloqueio» em vários períodos age já e não se desfaz aqui: pede confirmação (um só período decide-se logo).
  const hoje = hojeLisboaISO();
  // Nomes das casas que se distinguem (morada curta quando o nome se repete), pelo id da casa.
  const nomes = useMemo(() => {
    const m = new Map<string, { _id: string; nome: string; morada_curta?: string | null }>();
    for (const x of lista ?? []) m.set(x.propriedade._id, x.propriedade);
    return nomesDistintos([...m.values()]);
  }, [lista]);
  const nomeDaCasa = (p: { _id: string; nome: string }) => nomes.get(p._id) ?? p.nome;
  const pedirBloqueio = (ids: string[]) => {
    if (ids.length <= 1) { void decidir(ids, "bloqueio"); return; }
    const alvo = new Set(ids);
    setAConfirmarBloqueio({ ids, casas: (lista ?? []).filter((x) => alvo.has(x._id)).map((x) => nomeDaCasa(x.propriedade)) });
  };
  const verLongos = () => { setLongosAbertos(true); requestAnimationFrame(() => longosRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" })); };

  const linha = (x: Externa) => (
    <li key={x._id} className="flex items-center gap-3 py-2">
      <Checkbox checked={escolhidos.has(x._id)} onCheckedChange={(v) => alternar([x._id], v)} aria-label={`Escolher ${nomeDaCasa(x.propriedade)}, ${periodoComAno(x)}, ${x.canal_texto}`} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{periodoComAno(x)} <span className="font-normal text-muted-foreground">({plural(x.noites, "noite")})</span></p>
        <p className="text-xs text-muted-foreground"><span className="rounded border px-1.5 py-0.5 text-foreground" data-plataforma>{x.canal_texto}</span>{emCurso(x, hoje) && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-foreground" data-em-curso>Em curso</span>}{x.motivo === "sobreposicao" && " · coincide com outra reserva"}{x.motivo === "reapareceu" && " · voltou a aparecer no calendário"}</p>
      </div>
    </li>
  );

  if (!lista && !erro) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>;
  const grupos = agrupar(normais);
  const corte = textoCorte(lista?.length ?? 0, total);
  const bloqueioT = aConfirmarBloqueio ? textoConfirmarBloqueio(aConfirmarBloqueio.ids.length, aConfirmarBloqueio.casas) : null;

  return (
    <div className="space-y-4">
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {lista && lista.length === 0 && !resultado && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Não há períodos por confirmar{filtro !== "todas" ? " neste intervalo" : ""}. O Airbnb confirma-se sozinho; aqui aparecem os fechos do Booking.com.</p>}
      {(lista && lista.length > 0) || filtro !== "todas" ? (
        <div className="space-y-2" data-filtros>
          <div role="group" aria-label="Filtrar por data de chegada" className="flex flex-wrap items-center gap-1.5" data-filtro-chegada>
            <span className="mr-1 text-xs text-muted-foreground">Chegada:</span>
            {OPCOES_CHEGADA.map((o) => (
              <button key={o.valor} type="button" aria-pressed={filtro === o.valor} title={o.dica} disabled={ocupado}
                onClick={() => { setFiltro(o.valor); setEscolhidos(new Set()); }}
                className={`min-h-11 rounded-md border px-3 text-sm font-medium disabled:opacity-60 sm:min-h-9 ${filtro === o.valor ? "border-primary bg-accent" : "border-input bg-background hover:bg-accent"}`}>
                {o.texto}
              </button>
            ))}
            {lista && lista.length > 0 && <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={ocupado} onClick={() => setEscolhidos(new Set(normais.map((x) => x._id)))}>Escolher todos</Button>}
          </div>
          {lista && lista.length > 0 && longos.length > 0 && (
            <p className="text-xs text-muted-foreground" data-longos-fora>
              {textoLongosDeFora(longos.length)}{" "}
              <button type="button" onClick={verLongos} className="inline py-2 font-medium text-foreground underline underline-offset-2">Ver abaixo.</button>
            </p>
          )}
        </div>
      ) : null}
      {(lista && lista.length > 0) || resultado || progresso ? (
        <div className="sticky top-0 z-10 space-y-2 rounded-md border bg-background p-2" data-barra-lote>
          {lista && lista.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Ações em lote">
              <span className="text-sm">{escolhidos.size ? plural(escolhidos.size, "escolhido", "escolhidos") : `${total} por confirmar`}</span>
              <Button size="sm" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || !disponivel || escolhidos.size === 0} onClick={() => decidir([...escolhidos], "confirmar")}>{ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar</Button>
              <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-9" disabled={ocupado || escolhidos.size === 0} onClick={() => pedirBloqueio([...escolhidos])}><Ban className="h-4 w-4" /> É um bloqueio</Button>
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
              <div key={c.casaId} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{nomes.get(c.casaId) ?? c.casa} <span className="font-normal text-muted-foreground">· {c.itens.length}</span></h3>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} aria-label={`${ids.every((i) => escolhidos.has(i)) ? "Limpar" : "Escolher a casa"} ${nomes.get(c.casaId) ?? c.casa}`} onClick={() => alternar(ids, !ids.every((i) => escolhidos.has(i)))}>{ids.every((i) => escolhidos.has(i)) ? "Limpar" : "Escolher a casa"}</Button>
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={ocupado} onClick={() => pedirBloqueio(ids)}>Marcar todos como bloqueio</Button>
                  </div>
                </div>
                <ul className="mt-1 divide-y">{c.itens.map(linha)}</ul>
              </div>
            );
          })}
        </section>
      ))}
      {longos.length > 0 && (
        <details ref={longosRef} open={longosAbertos} onToggle={(e) => setLongosAbertos(e.currentTarget.open)} className="rounded-md border bg-muted/30 p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium sm:min-h-9">{plural(longos.length, "período")} com mais de 30 noites (normalmente são fechos do calendário)</summary>
          <div className="space-y-2 pt-2">
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={ocupado} onClick={() => pedirBloqueio(longos.map((x) => x._id))}>Marcar todos como bloqueio</Button>
            {agrupar(longos).map((g) => (
              <div key={g.parceiroId}>
                <p className="text-sm font-medium">{g.parceiro}</p>
                {g.casas.map((c) => (<div key={c.casaId}><p className="text-xs text-muted-foreground">{nomes.get(c.casaId) ?? c.casa}</p><ul className="divide-y">{c.itens.map(linha)}</ul></div>))}
              </div>
            ))}
          </div>
        </details>
      )}
      {aConfirmarBloqueio && bloqueioT && (
        <ConfirmarDialog aberto destrutivo titulo={bloqueioT.titulo} descricao={bloqueioT.descricao} detalhe={bloqueioT.casas} textoConfirmar={bloqueioT.confirmar}
          aoCancelar={() => setAConfirmarBloqueio(null)} aoConfirmar={() => { const ids = aConfirmarBloqueio.ids; setAConfirmarBloqueio(null); void decidir(ids, "bloqueio"); }} />
      )}
    </div>
  );
}
