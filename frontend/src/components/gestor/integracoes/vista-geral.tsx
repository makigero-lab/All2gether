"use client";

import { AlertCircle, CheckCircle2, ChevronRight, CircleDashed, FileWarning, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/utils";
import { haQuanto, ordenarLinhas, passaFiltro, type CasaResumo, type EstadoLinha, type Filtro, type ProprietarioResumo } from "./tipos";

const ESTADOS: Record<EstadoLinha, { texto: string; classe: string; Icone: React.ComponentType<{ className?: string }> }> = {
  ok: { texto: "A funcionar", classe: "text-emerald-700 dark:text-emerald-400", Icone: CheckCircle2 },
  erro: { texto: "Com erro", classe: "text-destructive", Icone: AlertCircle },
  por_aceitar: { texto: "Acordo por aceitar", classe: "text-amber-700 dark:text-amber-400", Icone: FileWarning },
  pausada: { texto: "Em pausa", classe: "text-muted-foreground", Icone: PauseCircle },
  sem_ligacao: { texto: "Sem ligação", classe: "text-muted-foreground", Icone: CircleDashed },
};

function EstadoLinhaTexto({ estado }: { estado: EstadoLinha }) {
  const e = ESTADOS[estado];
  return <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${e.classe}`}><e.Icone className="h-4 w-4 shrink-0" aria-hidden /> {e.texto}</span>;
}

/** Estado da casa na mini-barra: uma célula por casa (cor + texto alternativo, nunca só cor). */
function estadoCasa(c: CasaResumo): { classe: string; texto: string } {
  const lista = [c.airbnb, c.booking, ...c.outros].filter(Boolean);
  if (c.smoobu) return { classe: "bg-sky-500", texto: "Smoobu" };
  if (lista.some((x) => x?.estado === "erro" || x?.em_validacao)) return { classe: "bg-red-600", texto: "com erro" };
  if (lista.some((x) => x?.estado === "pausada" || x?.estado === "suspensa")) return { classe: "bg-amber-500", texto: "em pausa" };
  if (lista.length > 0) return { classe: "bg-emerald-600", texto: "ligada" };
  return { classe: "bg-muted-foreground/30", texto: "sem ligação" };
}

export function MiniBarra({ casas }: { casas: CasaResumo[] }) {
  if (casas.length === 0) return <span className="text-xs text-muted-foreground">Sem casas</span>;
  return (
    <span className="flex flex-wrap items-center gap-1" role="img" aria-label={casas.map((c) => `${c.nome}: ${estadoCasa(c).texto}`).join("; ")}>
      {casas.slice(0, 24).map((c) => <span key={c._id} title={`${c.nome}: ${estadoCasa(c).texto}`} className={`h-3.5 w-3.5 rounded-sm ${estadoCasa(c).classe}`} />)}
      {casas.length > 24 && <span className="text-xs text-muted-foreground">+{casas.length - 24}</span>}
    </span>
  );
}

export const FILTROS: { id: Filtro; texto: string }[] = [
  { id: "todos", texto: "Todos" },
  { id: "erro", texto: "Com erro" },
  { id: "por_confirmar", texto: "Por confirmar" },
  { id: "sem_ligacao", texto: "Sem ligação" },
  { id: "pausada", texto: "Em pausa" },
];

/**
 * Vista geral (opção A): uma linha por proprietário. Os erros sobem ao topo, com a explicação em linguagem simples
 * e a ação Corrigir. «Ligar» fica desativado quando a funcionalidade está indisponível ou o acordo está por aceitar.
 */
export function VistaGeral({ lista, filtro, disponivel, aoAbrir, aoLigar }: {
  lista: ProprietarioResumo[]; filtro: Filtro; disponivel: boolean;
  aoAbrir: (id: string) => void; aoLigar: (p: ProprietarioResumo) => void;
}) {
  const visiveis = ordenarLinhas(lista).filter((p) => passaFiltro(p, filtro));
  const comErro = visiveis.filter((p) => p.n_erros > 0 && p.primeiro_erro);
  if (visiveis.length === 0) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhum proprietário neste filtro.</p>;
  return (
    <div className="space-y-4">
      {comErro.length > 0 && (
        <section aria-label="Precisam de atenção" className="space-y-2 rounded-md border border-destructive/50 p-3">
          <h2 className="text-sm font-semibold text-destructive">Precisam de atenção ({comErro.length})</h2>
          <ul className="space-y-2">
            {comErro.map((p) => (
              <li key={p._id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="min-w-0 text-sm"><span className="font-medium">{p.nome}</span> · {p.primeiro_erro!.casa} · {p.primeiro_erro!.canal}: {p.primeiro_erro!.mensagem}</p>
                <Button size="sm" className="min-h-11 shrink-0 sm:min-h-9" onClick={() => aoAbrir(p._id)}>Corrigir</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="divide-y rounded-md border" aria-label="Proprietários">
        {visiveis.map((p) => {
          const acordoBloqueia = p.acordo === "por_aceitar";
          return (
            <li key={p._id} className="grid gap-x-4 gap-y-2 p-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] sm:items-center">
              <div className="min-w-0">
                <button type="button" onClick={() => aoAbrir(p._id)} className="min-h-11 text-left font-medium hover:underline sm:min-h-0" aria-label={`Abrir ${p.nome}`}>
                  {p.nome}{!p.ativo && <span className="ml-1 text-xs font-normal text-muted-foreground">(inativo)</span>}
                </button>
                <div className="mt-1"><MiniBarra casas={p.casas} /></div>
              </div>
              <div className="space-y-0.5">
                <EstadoLinhaTexto estado={p.estado} />
                <p className="text-xs text-muted-foreground">
                  {plural(p.n_ligacoes, "ligação", "ligações")} · lido {haQuanto(p.ultima_leitura_em)}
                </p>
              </div>
              <p className={`text-sm ${p.n_por_confirmar ? "font-medium" : "text-muted-foreground"}`}>{p.n_por_confirmar ? `${p.n_por_confirmar} por confirmar` : "Nada por confirmar"}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={!disponivel || acordoBloqueia} title={acordoBloqueia ? "O proprietário ainda não aceitou o Acordo de Tratamento de Dados." : undefined} onClick={() => aoLigar(p)}>Ligar</Button>
                <Button size="sm" variant="ghost" className="min-h-11 gap-1 sm:min-h-9" onClick={() => aoAbrir(p._id)} aria-label={`Abrir ${p.nome}`}>Abrir <ChevronRight className="h-4 w-4" aria-hidden /></Button>
              </div>
              {acordoBloqueia && <p className="text-xs text-muted-foreground sm:col-span-4">Acordo por aceitar: o proprietário tem de aceitar o Acordo de Tratamento de Dados no portal antes de ligares calendários.</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
