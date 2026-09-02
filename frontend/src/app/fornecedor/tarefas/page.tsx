"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shirt,
  Loader2,
  AlertCircle,
  Building2,
  Users,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { adminGet, adminPatch } from "@/lib/api";
import { parsearDataSegura } from "@/lib/utils";

/**
 * /fornecedor/tarefas — Portal da Lavandaria (FIX: portal lavandaria).
 *
 * Mostra as tarefas dos próximos 7 dias das propriedades atribuídas ao
 * fornecedor. O fornecedor (lavandaria) marca `roupa_entregue = true` quando
 * entrega roupa limpa numa propriedade. Também vê quantos sacos de roupa
 * suja foram recolhidos pelo staff em cada tarefa.
 *
 * FIX (fallback hospedes) — A célula de Qtd. Hóspedes faz fallback estrito:
 * usa tarefa.hospedes; se for null, 0 ou undefined, usa
 * tarefa.propriedade_id?.capacidade_hospedes (lotação máxima da casa).
 *
 * FIX (agrupamento por dias) — A tabela agrupa as tarefas por data
 * (data_agendada), inserindo uma linha separadora (colspan=6) com a data
 * formatada de forma amigável (ex: "Segunda-feira, 15 de Janeiro") antes de
 * listar as respetivas tarefas desse dia.
 */
interface TarefaFornecedorDTO {
  _id: string;
  data: string;
  estado: string;
  tipo: string;
  hospedes?: number | null;
  roupa_entregue?: boolean;
  sacos_roupa_suja?: number;
  propriedade_id: { nome: string; morada?: string; capacidade_hospedes?: number | null } | null;
}

const ESTADO_LABEL: Record<string, string> = {
  por_atribuir: "Por Atribuir",
  atribuida: "Atribuída",
  em_curso: "Em Curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  nao_atribuida: "Não Atribuída",
};

export default function FornecedorTarefasPage() {
  const [tarefas, setTarefas] = useState<TarefaFornecedorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const data = await adminGet<{ tarefas: TarefaFornecedorDTO[] }>("/api/fornecedor/tarefas");
      setTarefas(data.tarefas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar tarefas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Marca/desmarca roupa_entregue (toggle). */
  async function toggleRoupaEntregue(t: TarefaFornecedorDTO) {
    setTogglingId(t._id);
    try {
      const novoValor = !t.roupa_entregue;
      setTarefas((prev) =>
        prev.map((x) => (x._id === t._id ? { ...x, roupa_entregue: novoValor } : x))
      );
      await adminPatch(`/api/fornecedor/tarefas/${t._id}/roupa`, {
        roupa_entregue: novoValor,
      });
    } catch (e) {
      setTarefas((prev) =>
        prev.map((x) => (x._id === t._id ? { ...x, roupa_entregue: !x.roupa_entregue } : x))
      );
      setErro(e instanceof Error ? e.message : "Erro ao atualizar roupa.");
    } finally {
      setTogglingId(null);
    }
  }

  /**
   * FIX (agrupamento por dias) — Agrupa as tarefas por data (YYYY-MM-DD).
   * O backend já devolve as tarefas ordenadas por data (sort: { data: 1 }),
   * mas precisamos de detetar quando muda o dia para inserir o separador.
   */
  const tarefasAgrupadas = useMemo(() => {
    const grupos: Array<{ dataKey: string; dataLabel: string; tarefas: TarefaFornecedorDTO[] }> = [];
    for (const t of tarefas) {
      const dataObj = parsearDataSegura(t.data);
      if (!dataObj) continue;
      const dataKey = dataObj.toISOString().slice(0, 10); // YYYY-MM-DD
      // Formata a data de forma amigável: "Segunda-feira, 15 de Janeiro"
      const dataLabel = format(dataObj, "EEEE, d 'de' MMMM", { locale: pt });

      let grupo = grupos.find((g) => g.dataKey === dataKey);
      if (!grupo) {
        grupo = { dataKey, dataLabel, tarefas: [] };
        grupos.push(grupo);
      }
      grupo.tarefas.push(t);
    }
    return grupos;
  }, [tarefas]);

  return (
    <div className="flex min-h-screen flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Shirt className="h-6 w-6 text-primary" />
            Tarefas de Lavandaria
          </h1>
          <p className="text-sm text-muted-foreground">
            Tarefas dos próximos 7 dias. Marca a roupa entregue em cada propriedade.
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {erro && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {erro}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tarefas.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Shirt className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Sem tarefas nos próximos 7 dias.
          </p>
        </div>
      ) : (
        /* FIX (agrupamento por dias) — Tabela com separadores por dia. */
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Propriedade</th>
                    <th className="px-4 py-3 font-medium">Qtd. Hóspedes</th>
                    <th className="px-4 py-3 font-medium">Roupa Suja</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 text-center font-medium">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {tarefasAgrupadas.map((grupo) => (
                    <GrupoTarefasLavandaria
                      key={grupo.dataKey}
                      grupo={grupo}
                      togglingId={togglingId}
                      onToggle={toggleRoupaEntregue}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="mt-auto text-xs text-muted-foreground">
        © {new Date().getFullYear()} All2gether — Portal da Lavandaria
      </p>
    </div>
  );
}

/**
 * GrupoTarefasLavandaria — Renderiza um grupo de tarefas de um dia.
 * Insere uma linha separadora (colspan) com a data formatada, seguida das
 * linhas das tarefas desse dia.
 */
function GrupoTarefasLavandaria({
  grupo,
  togglingId,
  onToggle,
}: {
  grupo: { dataKey: string; dataLabel: string; tarefas: TarefaFornecedorDTO[] };
  togglingId: string | null;
  onToggle: (t: TarefaFornecedorDTO) => void;
}) {
  return (
    <>
      {/* FIX (agrupamento por dias) — Linha separadora com a data em destaque. */}
      <tr className="border-y border-primary/20 bg-primary/5">
        <td colSpan={5} className="px-4 py-2.5">
          <span className="text-sm font-bold capitalize text-primary">
            {grupo.dataLabel}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            {grupo.tarefas.length} tarefa(s)
          </span>
        </td>
      </tr>
      {grupo.tarefas.map((t) => {
        // FIX (fallback hospedes) — Cobrir null, 0 e undefined (não só null).
        // O operador ?? só cobre null/undefined; usamos || para cobrir 0 também.
        const hospedesReal =
          t.hospedes && t.hospedes > 0
            ? t.hospedes
            : t.propriedade_id?.capacidade_hospedes ?? null;
        return (
          <tr key={t._id} className="hover:bg-muted/30">
            <td className="px-4 py-3 font-medium">
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                {t.propriedade_id?.nome ?? "—"}
              </div>
            </td>
            <td className="px-4 py-3 text-muted-foreground">
              {hospedesReal != null && hospedesReal > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {hospedesReal}
                  {/* FIX (fallback hospedes) — Mostra visualmente se é lotação máxima. */}
                  {(!t.hospedes || t.hospedes === 0) && (
                    <span className="text-[10px] text-muted-foreground" title="Lotação máxima da casa">
                      (máx)
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground/50">—</span>
              )}
            </td>
            <td className="px-4 py-3">
              {t.sacos_roupa_suja && t.sacos_roupa_suja > 0 ? (
                <Badge variant="secondary" className="gap-1">
                  <Shirt className="h-3 w-3" />
                  {t.sacos_roupa_suja} saco(s)
                </Badge>
              ) : (
                <span className="text-muted-foreground/50 text-xs">—</span>
              )}
            </td>
            <td className="px-4 py-3">
              <Badge variant={t.estado === "concluida" ? "success" : "outline"}>
                {ESTADO_LABEL[t.estado] ?? t.estado}
              </Badge>
            </td>
            <td className="px-4 py-3 text-center">
              <Button
                type="button"
                variant={t.roupa_entregue ? "default" : "outline"}
                size="sm"
                disabled={togglingId === t._id}
                onClick={() => onToggle(t)}
                className={
                  t.roupa_entregue
                    ? "bg-emerald-600 text-white hover:bg-emerald-700 gap-1.5"
                    : "gap-1.5"
                }
              >
                {togglingId === t._id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : t.roupa_entregue ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Shirt className="h-3.5 w-3.5" />
                )}
                {t.roupa_entregue ? "Entregue" : "Marcar Entregue"}
              </Button>
            </td>
          </tr>
        );
      })}
    </>
  );
}
