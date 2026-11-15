"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, LockKeyhole, TriangleAlert } from "lucide-react";

import { adminGet } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { rotuloDaCasa, rotulosDeCasas, type CasaDaApi } from "@/lib/casas-rotulo";
import { plural } from "@/lib/utils";
import { DetalheTarefaModal, type TarefaDetalheGestor } from "@/components/gestor/detalhe-tarefa-modal";

interface Pessoa {
  _id: string;
  nome: string;
}

interface LimpezaFechada {
  _id: string;
  data: string;
  tipo?: string;
  tipo_limpeza?: string | null;
  tempo_limpeza_minutos?: number;
  conclusao_origem?: "staff" | "gestor" | "automatica" | null;
  concluida_em?: string | null;
  casa: (CasaDaApi & { _id: string }) | null;
  pessoas: Pessoa[];
  fechada_em: string;
  confirmada_depois: boolean;
  confirmada_depois_em: string | null;
  acrescentou: { fotos: number; notas: boolean; avarias: number };
  acrescentou_algo: boolean;
}

interface LimpezaPresa {
  _id: string;
  data: string;
  tipo_limpeza?: string | null;
  tempo_limpeza_minutos?: number;
  iniciada_em?: string | null;
  casa: (CasaDaApi & { _id: string }) | null;
  pessoas: Pessoa[];
}

interface FechadasDTO {
  dias: number;
  total: number;
  limpezas: LimpezaFechada[];
  presas?: LimpezaPresa[];
}

const PERIODOS = [7, 14, 30];

/** «10/05» do dia da limpeza (o dia guardado é UTC: 10:00-18:00 de Lisboa caem no mesmo dia). */
function diaCurto(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : "—";
}

/** O que a pessoa acrescentou depois do fecho, em palavras curtas. */
function textoAcrescentou(l: LimpezaFechada): string {
  const partes: string[] = [];
  if (l.confirmada_depois) partes.push("confirmou a limpeza");
  if (l.acrescentou.fotos > 0) partes.push(plural(l.acrescentou.fotos, "foto"));
  if (l.acrescentou.notas) partes.push("nota");
  if (l.acrescentou.avarias > 0) partes.push(plural(l.acrescentou.avarias, "avaria"));
  return partes.join(", ");
}

/** Parte «Casa Azul (Alcântara)» em nome e sufixo, para truncar só o nome e nunca o sufixo identificador. */
function partirRotulo(rotulo: string): { nome: string; sufixo: string } {
  const m = /^(.*?)(\s*\([^()]*\))$/.exec(rotulo);
  return m ? { nome: m[1], sufixo: m[2] } : { nome: rotulo, sufixo: "" };
}

function NomeCasa({ rotulo }: { rotulo: string }) {
  const { nome, sufixo } = partirRotulo(rotulo);
  return (
    <span className="flex min-w-0 font-medium" title={rotulo}>
      <span className="truncate">{nome}</span>
      {sufixo && <span className="shrink-0 whitespace-pre">{sufixo}</span>}
    </span>
  );
}

/** A tarefa no formato do modal de detalhe do gestor (a prova carrega-se lá dentro). */
function paraModal(
  l: LimpezaFechada | LimpezaPresa,
  estado: string,
  extra: Partial<TarefaDetalheGestor> = {}
): TarefaDetalheGestor {
  return {
    _id: l._id,
    data: l.data,
    tipo: "limpeza",
    estado,
    tempo_limpeza_minutos: l.tempo_limpeza_minutos ?? 0,
    tipo_limpeza: l.tipo_limpeza ?? null,
    propriedade_id: l.casa ? { nome: l.casa.nome, morada: l.casa.morada ?? undefined } : null,
    utilizador_id: l.pessoas[0] ? { _id: l.pessoas[0]._id, nome: l.pessoas[0].nome } : null,
    equipa_atribuida: l.pessoas.length > 1 ? l.pessoas : null,
    ...extra,
  };
}

/**
 * Limpezas que o sistema fechou às 20:00 porque ninguém as fechou (nunca prova de que foram feitas), e as que
 * ficaram «em curso» há mais de 3 dias (o sistema já não lhes mexe). Cada linha abre o detalhe da limpeza.
 */
export function FechadasAutomaticamente() {
  const [dias, setDias] = useState(7);
  const [dados, setDados] = useState<FechadasDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [a, setA] = useState(true);
  const [aberta, setAberta] = useState<TarefaDetalheGestor | null>(null);

  useEffect(() => {
    let cancelado = false;
    setA(true);
    setErro(null);
    (async () => {
      try {
        const r = await adminGet<FechadasDTO>(`/api/gestor/limpezas/fechadas-automaticamente?dias=${dias}`);
        if (!cancelado) setDados(r);
      } catch (e) {
        if (!cancelado) setErro(mensagemErro(e, "Não foi possível carregar as limpezas fechadas automaticamente."));
      } finally {
        if (!cancelado) setA(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [dias]);

  const rotulos = useMemo(() => {
    const vistas = new Map<string, CasaDaApi>();
    for (const l of [...(dados?.limpezas ?? []), ...(dados?.presas ?? [])]) if (l.casa) vistas.set(l.casa._id, l.casa);
    return rotulosDeCasas([...vistas.values()]);
  }, [dados]);

  const presas = dados?.presas ?? [];

  return (
    <section aria-labelledby="dash-fechadas" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 id="dash-fechadas" className="flex items-center gap-2 text-sm font-bold">
          <LockKeyhole className="h-4 w-4" aria-hidden="true" />
          Fechadas automaticamente
        </h2>
        {dados && <span className="text-xs font-medium text-muted-foreground">{plural(dados.total, "limpeza")}</span>}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Últimos
          <select
            value={dias}
            onChange={(e) => setDias(Number(e.target.value))}
            className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
            aria-label="Período das limpezas fechadas automaticamente"
          >
            {PERIODOS.map((p) => (
              <option key={p} value={p}>
                {p} dias
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
        Às 20:00 o sistema fecha as limpezas que ficaram em curso e que ninguém fechou. Não há prova de que foram feitas e o proprietário não é avisado.
      </p>
      {a && (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
        </p>
      )}
      {erro && (
        <p role="alert" className="flex items-center gap-2 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {erro}
        </p>
      )}
      {!a && !erro && dados && dados.limpezas.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">Nenhuma limpeza foi fechada automaticamente neste período.</p>
      )}
      {!a && dados && dados.limpezas.length > 0 && (
        <ul className="divide-y">
          {dados.limpezas.map((l) => (
            <li key={l._id}>
              <button
                type="button"
                onClick={() =>
                  setAberta(
                    paraModal(l, "concluida", {
                      conclusao_origem: l.conclusao_origem ?? null,
                      concluida_em: l.concluida_em ?? null,
                      fechada_automaticamente_em: l.fechada_em,
                    })
                  )
                }
                className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Ver a limpeza de ${rotuloDaCasa(rotulos, l.casa)}, dia ${diaCurto(l.data)}`}
              >
                <span className="min-w-0 flex-1 basis-48">
                  <NomeCasa rotulo={rotuloDaCasa(rotulos, l.casa)} />
                  <span className="block text-xs text-muted-foreground">
                    {diaCurto(l.data)} · {l.pessoas.length > 0 ? l.pessoas.map((p) => p.nome).join(", ") : "Sem pessoa registada"}
                  </span>
                </span>
                <span
                  className={
                    l.acrescentou_algo
                      ? "shrink-0 rounded-full bg-status-conc-bg px-2 py-0.5 text-xs font-medium text-status-conc"
                      : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  }
                >
                  {l.acrescentou_algo ? `Depois: ${textoAcrescentou(l)}` : "Sem confirmação da equipa"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!a && presas.length > 0 && (
        <div className="border-t">
          <h3 className="flex items-center gap-2 bg-status-porat-bg/50 px-4 py-2 text-xs font-bold text-status-porat">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            Presa há mais de 3 dias ({presas.length})
          </h3>
          <p className="px-4 py-2 text-xs text-muted-foreground">
            Ficaram «em curso» e o sistema já não as fecha sozinho. Abre cada uma para a fechar ou resolver à mão.
          </p>
          <ul className="divide-y">
            {presas.map((l) => (
              <li key={l._id}>
                <button
                  type="button"
                  onClick={() => setAberta(paraModal(l, "em_curso", { iniciada_em: l.iniciada_em ?? null }))}
                  className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Ver a limpeza presa de ${rotuloDaCasa(rotulos, l.casa)}, dia ${diaCurto(l.data)}`}
                >
                  <span className="min-w-0 flex-1 basis-48">
                    <NomeCasa rotulo={rotuloDaCasa(rotulos, l.casa)} />
                    <span className="block text-xs text-muted-foreground">
                      {diaCurto(l.data)} · {l.pessoas.length > 0 ? l.pessoas.map((p) => p.nome).join(", ") : "Sem pessoa registada"}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-status-porat-bg px-2 py-0.5 text-xs font-medium text-status-porat">
                    Presa há mais de 3 dias
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <DetalheTarefaModal tarefa={aberta} open={aberta !== null} onOpenChange={(o) => !o && setAberta(null)} />
    </section>
  );
}
