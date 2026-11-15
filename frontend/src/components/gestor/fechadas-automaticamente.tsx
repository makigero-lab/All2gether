"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, LockKeyhole } from "lucide-react";

import { adminGet } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { rotuloDaCasa, rotulosDeCasas, type CasaDaApi } from "@/lib/casas-rotulo";
import { plural } from "@/lib/utils";

interface LimpezaFechada {
  _id: string;
  data: string;
  casa: (CasaDaApi & { _id: string }) | null;
  pessoas: { _id: string; nome: string }[];
  fechada_em: string;
  confirmada_depois: boolean;
  confirmada_depois_em: string | null;
  acrescentou: { fotos: number; notas: boolean; avarias: number };
  acrescentou_algo: boolean;
}

interface FechadasDTO {
  dias: number;
  total: number;
  limpezas: LimpezaFechada[];
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
  if (l.acrescentou.fotos > 0) partes.push(plural(l.acrescentou.fotos, "foto"));
  if (l.acrescentou.notas) partes.push("nota");
  if (l.acrescentou.avarias > 0) partes.push(plural(l.acrescentou.avarias, "avaria"));
  if (l.confirmada_depois) partes.unshift("confirmou a limpeza");
  return partes.join(", ");
}

/**
 * Limpezas que o sistema fechou às 20:00 porque ninguém as fechou (nunca prova de que foram feitas).
 * Mostra o dia, a casa, a equipa e se alguém acrescentou algo depois. Só leitura.
 */
export function FechadasAutomaticamente() {
  const [dias, setDias] = useState(7);
  const [dados, setDados] = useState<FechadasDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [a, setA] = useState(true);

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
    for (const l of dados?.limpezas ?? []) if (l.casa) vistas.set(l.casa._id, l.casa);
    return rotulosDeCasas([...vistas.values()]);
  }, [dados]);

  return (
    <section aria-labelledby="dash-fechadas" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 id="dash-fechadas" className="flex items-center gap-2 text-sm font-bold">
          <LockKeyhole className="h-4 w-4" aria-hidden="true" />
          Fechadas automaticamente
        </h2>
        <span className="text-xs font-medium text-muted-foreground">{dados ? dados.total : ""}</span>
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
        Às 20:00 o sistema fecha as limpezas que a equipa começou e não fechou. Não há prova de que foram feitas e o proprietário não é avisado.
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
            <li key={l._id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1 basis-48">
                <p className="line-clamp-2 break-words font-medium">{rotuloDaCasa(rotulos, l.casa)}</p>
                <p className="text-xs text-muted-foreground">
                  {diaCurto(l.data)} · {l.pessoas.length > 0 ? l.pessoas.map((p) => p.nome).join(", ") : "Sem pessoa registada"}
                </p>
              </div>
              <span
                className={
                  l.acrescentou_algo
                    ? "shrink-0 rounded-full bg-status-conc-bg px-2 py-0.5 text-xs font-medium text-status-conc"
                    : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                }
              >
                {l.acrescentou_algo ? `Depois: ${textoAcrescentou(l)}` : "Sem nada acrescentado"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
