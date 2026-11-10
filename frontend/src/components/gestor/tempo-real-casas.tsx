"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, Timer, Lightbulb } from "lucide-react";

import { adminGet } from "@/lib/api";
import { mensagemErro } from "@/lib/rascunho-staff";
import { plural } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface CasaTempoReal {
  propriedade_id: string;
  nome: string;
  amostras: number;
  por_botao: number;
  por_checklist: number;
  real_medio_min: number;
  estimado_medio_min: number;
  tempo_atual_casa_min: number;
  diferenca_min: number;
  sugestao_min: number | null;
}

interface TempoRealDTO {
  inicios: { botao: number; automatico: number; sem_registo: number };
  limpezas_concluidas: number;
  excluidas_sem_inicio_fiavel: number;
  casas: CasaTempoReal[];
}

/**
 * Tempo real vs estimado por casa. Só conta limpezas normais com início por botão («Comecei») ou
 * por checklist; os inícios automáticos sem checklist ficam de fora. A sugestão NUNCA se aplica
 * sozinha: o gestor altera o tempo da casa à mão em Propriedades.
 */
export function TempoRealCasas({ inicio, fim }: { inicio: string; fim: string }) {
  const [dados, setDados] = useState<TempoRealDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [a, setA] = useState(true);

  useEffect(() => {
    let cancelado = false;
    setA(true);
    setErro(null);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (inicio) params.set("inicio", inicio);
        if (fim) params.set("fim", fim);
        const r = await adminGet<TempoRealDTO>(`/api/gestor/relatorios/tempo-real?${params.toString()}`);
        if (!cancelado) setDados(r);
      } catch (e) {
        if (!cancelado) setErro(mensagemErro(e, "Não foi possível carregar o tempo real."));
      } finally {
        if (!cancelado) setA(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [inicio, fim]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-brand-text" aria-hidden="true" />
          Tempo real vs estimado por casa
        </CardTitle>
        <CardDescription>
          Média do tempo que a limpeza demorou (do «Comecei» ou do primeiro item da checklist até à conclusão) contra o
          tempo estimado da casa. Não entram inícios automáticos sem checklist. Nada é alterado sozinho.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {a && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
          </p>
        )}
        {erro && (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {erro}
          </p>
        )}
        {dados && (
          <>
            <p className="text-sm text-muted-foreground">
              {plural(dados.limpezas_concluidas, "limpeza concluída", "limpezas concluídas")} no período:{" "}
              <strong>{dados.inicios.botao}</strong> começaram pelo botão, <strong>{dados.inicios.automatico}</strong> automaticamente
              {dados.inicios.sem_registo > 0 ? `, ${dados.inicios.sem_registo} sem registo de início` : ""}.{" "}
              {dados.excluidas_sem_inicio_fiavel > 0 &&
                `${plural(dados.excluidas_sem_inicio_fiavel, "limpeza")} sem início fiável ficaram de fora da média.`}
            </p>
            {dados.casas.length === 0 ? (
              <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                Ainda não há limpezas com início fiável neste período.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Tempo real contra tempo estimado, por casa</caption>
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th scope="col" className="px-3 py-2 font-medium">Casa</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Limpezas</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Estimado</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Real (média)</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Diferença</th>
                      <th scope="col" className="px-3 py-2 font-medium">Sugestão</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {dados.casas.map((c) => (
                      <tr key={c.propriedade_id}>
                        <td className="px-3 py-2 font-medium">{c.nome}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.amostras}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.tempo_atual_casa_min} min</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.real_medio_min} min</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <Badge variant={Math.abs(c.diferenca_min) >= 10 ? "destructive" : "secondary"}>
                            {c.diferenca_min > 0 ? "+" : ""}{c.diferenca_min} min
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          {c.sugestao_min !== null ? (
                            <span className="inline-flex flex-wrap items-center gap-2">
                              <Lightbulb className="h-4 w-4 text-brand-text" aria-hidden="true" />
                              Ajustar para <strong>{c.sugestao_min} min</strong>
                              <Link href="/gestor/propriedades" className="text-xs underline">
                                alterar na casa
                              </Link>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {c.amostras < 3 ? "Poucas limpezas para sugerir" : "Sem ajuste necessário"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
