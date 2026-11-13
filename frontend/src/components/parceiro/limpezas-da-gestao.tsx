"use client";

import { Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { rotuloTipoLimpeza } from "@/components/tipo-limpeza-badge";

/**
 * Limpezas das casas do proprietário que NÃO vêm de uma reserva dele: as criadas pela All2gether
 * e as vindas do Smoobu. Aparecem na tabela de Reservas, SÓ DE LEITURA (o backend recusa editar
 * ou apagar). Mostram a origem, as datas, o tipo de limpeza e o estado; nunca dados de hóspedes.
 */
export interface LimpezaGestaoDTO {
  _id: string;
  origem: "smoobu" | "all2gether";
  origem_texto: string;
  propriedade: { _id: string; nome: string; morada?: string | null };
  /** Dia da limpeza (ISO). */
  data: string;
  estado: string;
  tipo_limpeza: string;
  check_in: string | null;
  check_out: string | null;
  somente_leitura: true;
}

const MSG_SO_LEITURA = "Só de leitura: esta limpeza é gerida pela All2gether (ou vem do Smoobu). Fala com o gestor para a alterar.";

/** «2026-11-13» ou ISO completo -> «13/11/2026». */
function formatar(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : "—";
}

/** Para o proprietário, «Não atribuída» (detalhe interno) é igual a «Por atribuir». */
const estadoParaParceiro = (e: string) => (e === "nao_atribuida" ? "por_atribuir" : e);

function EtiquetaOrigem({ l }: { l: LimpezaGestaoDTO }) {
  return (
    <Badge variant={l.origem === "smoobu" ? "secondary" : "outline"} className="whitespace-nowrap px-1.5 py-0 text-xs">
      {l.origem_texto}
    </Badge>
  );
}

/**
 * Linhas da tabela (desktop). Segue as colunas da tabela de reservas: propriedade, check-in, [hora],
 * check-out, [noites], hóspedes, hóspede, plataforma, tipo, [horário], notas, estado (fixa), ações (fixa).
 */
export function LinhasLimpezasGestao({
  limpezas,
  classeEstado,
  classeAcoes,
}: {
  limpezas: LimpezaGestaoDTO[];
  classeEstado: string;
  classeAcoes: string;
}) {
  if (limpezas.length === 0) return null;
  return (
    <>
      <tr className="border-b bg-muted/40">
        <td colSpan={10} className="px-3 py-2 text-xs font-medium text-muted-foreground min-[1366px]:hidden">
          Limpezas geridas pela All2gether e do Smoobu (só de leitura)
        </td>
        <td colSpan={11} className="hidden px-3 py-2 text-xs font-medium text-muted-foreground min-[1366px]:table-cell min-[1600px]:hidden">
          Limpezas geridas pela All2gether e do Smoobu (só de leitura)
        </td>
        <td colSpan={13} className="hidden px-3 py-2 text-xs font-medium text-muted-foreground min-[1600px]:table-cell">
          Limpezas geridas pela All2gether e do Smoobu (só de leitura)
        </td>
      </tr>
      {limpezas.map((l) => (
        <tr key={l._id} className="border-b bg-muted/20 text-muted-foreground last:border-0" data-testid="linha-limpeza-gestao">
          <td title={l.propriedade.nome} className="truncate px-2 py-2 font-medium text-foreground">{l.propriedade.nome}</td>
          <td className="px-2 py-2">{formatar(l.check_in)}</td>
          <td className="hidden px-2 py-2 min-[1600px]:table-cell">—</td>
          <td className="px-2 py-2">{formatar(l.check_out)}</td>
          <td className="hidden px-2 py-2 min-[1600px]:table-cell">—</td>
          <td className="px-2 py-2 text-right">—</td>
          <td className="px-2 py-2">—</td>
          <td className="px-2 py-2">—</td>
          <td className="px-2 py-2">{rotuloTipoLimpeza(l.tipo_limpeza)}</td>
          <td className="hidden px-2 py-2 min-[1366px]:table-cell">—</td>
          <td className="px-2 py-2">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <EtiquetaOrigem l={l} />
              <span className="text-xs">Limpeza a {formatar(l.data)}</span>
            </span>
          </td>
          <td className={`${classeEstado} bg-background px-2 py-2`}>
            <EstadoTarefaBadge estado={estadoParaParceiro(l.estado)} />
          </td>
          <td className={`${classeAcoes} bg-background px-1 text-right`}>
            <span title={MSG_SO_LEITURA} className="inline-flex h-8 w-8 items-center justify-center">
              <Lock className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{MSG_SO_LEITURA}</span>
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}

/** Cartões (telemóvel). */
export function CartoesLimpezasGestao({ limpezas }: { limpezas: LimpezaGestaoDTO[] }) {
  if (limpezas.length === 0) return null;
  return (
    <>
      <h2 className="px-1 pt-2 text-sm font-semibold">Limpezas geridas pela All2gether e do Smoobu (só de leitura)</h2>
      {limpezas.map((l) => (
        <Card key={l._id} className="bg-muted/20" data-testid="cartao-limpeza-gestao">
          <CardContent className="space-y-2 p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{l.propriedade.nome}</p>
              <span title={MSG_SO_LEITURA} className="shrink-0 text-muted-foreground">
                <Lock className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">{MSG_SO_LEITURA}</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <EtiquetaOrigem l={l} />
              <EstadoTarefaBadge estado={estadoParaParceiro(l.estado)} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
              <div>
                <dt className="text-xs">Limpeza</dt>
                <dd className="text-foreground">{formatar(l.data)}</dd>
              </div>
              <div>
                <dt className="text-xs">Tipo de limpeza</dt>
                <dd className="text-foreground">{rotuloTipoLimpeza(l.tipo_limpeza)}</dd>
              </div>
              {(l.check_in || l.check_out) && (
                <>
                  <div>
                    <dt className="text-xs">Check-in</dt>
                    <dd className="text-foreground">{formatar(l.check_in)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs">Check-out</dt>
                    <dd className="text-foreground">{formatar(l.check_out)}</dd>
                  </div>
                </>
              )}
            </dl>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
