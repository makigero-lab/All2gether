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
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
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

/** Para o fornecedor, "Não atribuída" (detalhe interno) é igual a "Por atribuir". */
const estadoParaFornecedor = (e: string) => (e === "nao_atribuida" ? "por_atribuir" : e);

/** Data YYYY-MM-DD no fuso de Lisboa (en-CA formata como ISO). */
function chaveDiaLisboa(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Resumo de um dia: nº de casas (distintas) e total de hóspedes. */
function resumirDia(tarefas: TarefaFornecedorDTO[], chave: string) {
  const casas = new Set<string>();
  let hospedes = 0;
  let incluiLotacaoMaxima = false;
  for (const t of tarefas) {
    if (t.estado === "cancelada") continue;
    const d = parsearDataSegura(t.data);
    if (!d || chaveDiaLisboa(d) !== chave) continue;
    casas.add(t.propriedade_id?.nome ?? t._id);
    if (t.hospedes && t.hospedes > 0) {
      hospedes += t.hospedes;
    } else if (t.propriedade_id?.capacidade_hospedes) {
      hospedes += t.propriedade_id.capacidade_hospedes;
      incluiLotacaoMaxima = true;
    }
  }
  return { casas: casas.size, hospedes, incluiLotacaoMaxima };
}

function CartaoDia({
  titulo,
  resumo,
}: {
  titulo: string;
  resumo: { casas: number; hospedes: number; incluiLotacaoMaxima: boolean };
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase text-muted-foreground">{titulo}</p>
        {resumo.casas === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Sem tarefas</p>
        ) : (
          <>
            <p className="mt-1 text-2xl font-bold">
              {resumo.casas} {resumo.casas === 1 ? "casa" : "casas"}
            </p>
            <p className="text-sm text-muted-foreground">
              {resumo.incluiLotacaoMaxima ? "até " : ""}
              {resumo.hospedes} {resumo.hospedes === 1 ? "hóspede" : "hóspedes"}
              {resumo.incluiLotacaoMaxima && " (inclui lotação máxima)"}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

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

  // Cartões Hoje / Amanhã (dia civil em Europe/Lisbon).
  const resumoHojeAmanha = useMemo(() => {
    const agora = new Date();
    const hoje = chaveDiaLisboa(agora);
    // Soma 1 dia ao calendário (via UTC, sem efeitos de mudança de hora).
    const [a, m, d] = hoje.split("-").map(Number);
    const amanha = new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
    return { hoje: resumirDia(tarefas, hoje), amanha: resumirDia(tarefas, amanha) };
  }, [tarefas]);

  return (
    <div className="flex min-h-screen flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Shirt className="h-6 w-6 text-gold-text" />
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

      {!loading && tarefas.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <CartaoDia titulo="Hoje" resumo={resumoHojeAmanha.hoje} />
          <CartaoDia titulo="Amanhã" resumo={resumoHojeAmanha.amanha} />
        </div>
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
        <>
        <Card className="hidden md:block">
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

        {/* Telemóvel (< md): um cartão por tarefa, com o botão sempre visível. */}
        <div className="flex flex-col gap-4 md:hidden">
          {tarefasAgrupadas.map((grupo) => (
            <section key={grupo.dataKey} aria-label={grupo.dataLabel} className="space-y-2">
              <h2 className="text-sm font-bold first-letter:uppercase text-gold-text">
                {grupo.dataLabel}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {grupo.tarefas.length} tarefa(s)
                </span>
              </h2>
              {grupo.tarefas.map((t) => (
                <CartaoTarefaLavandaria key={t._id} t={t} togglingId={togglingId} onToggle={toggleRoupaEntregue} />
              ))}
            </section>
          ))}
        </div>
        </>
      )}

      <p className="mt-auto text-xs text-muted-foreground">
        © {new Date().getFullYear()} All2gether — Portal da Lavandaria
      </p>
    </div>
  );
}


/**
 * Botão "Marcar Entregue": alvo de toque >= 44 px (h-11), sempre visível.
 * Partilhado pela tabela (desktop) e pelos cartões (telemóvel).
 */
function BotaoEntregue({
  t,
  togglingId,
  onToggle,
  className,
}: {
  t: TarefaFornecedorDTO;
  togglingId: string | null;
  onToggle: (t: TarefaFornecedorDTO) => void;
  className?: string;
}) {
  const nome = t.propriedade_id?.nome ?? "propriedade";
  return (
    <Button
      type="button"
      variant={t.roupa_entregue ? "default" : "outline"}
      disabled={togglingId === t._id}
      onClick={() => onToggle(t)}
      aria-label={t.roupa_entregue ? `Roupa entregue em ${nome}: desmarcar` : `Marcar roupa entregue em ${nome}`}
      aria-pressed={!!t.roupa_entregue}
      className={`h-11 min-w-[44px] gap-1.5 px-4 ${t.roupa_entregue ? "bg-status-conc text-status-foreground hover:bg-status-conc/90" : ""} ${className ?? ""}`}
    >
      {togglingId === t._id ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : t.roupa_entregue ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <Shirt className="h-4 w-4" />
      )}
      {t.roupa_entregue ? "Entregue" : "Marcar Entregue"}
    </Button>
  );
}

/** Cartão de uma tarefa (telemóvel, < md). */
function CartaoTarefaLavandaria({
  t,
  togglingId,
  onToggle,
}: {
  t: TarefaFornecedorDTO;
  togglingId: string | null;
  onToggle: (t: TarefaFornecedorDTO) => void;
}) {
  const hospedesReal =
    t.hospedes && t.hospedes > 0 ? t.hospedes : t.propriedade_id?.capacidade_hospedes ?? null;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{t.propriedade_id?.nome ?? "—"}</span>
          </h3>
          <EstadoTarefaBadge estado={estadoParaFornecedor(t.estado)} className="shrink-0" />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {hospedesReal != null && hospedesReal > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" />
              {hospedesReal} hóspede(s){(!t.hospedes || t.hospedes === 0) && " (máx)"}
            </span>
          )}
          {t.sacos_roupa_suja && t.sacos_roupa_suja > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Shirt className="h-3.5 w-3.5" />
              {t.sacos_roupa_suja} saco(s) de roupa suja
            </span>
          ) : null}
        </div>
        <BotaoEntregue t={t} togglingId={togglingId} onToggle={onToggle} className="w-full" />
      </CardContent>
    </Card>
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
          <span className="text-sm font-bold inline-block first-letter:uppercase text-gold-text">
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
                    <span className="text-xs text-muted-foreground" title="Lotação máxima da casa">
                      (máx)
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-4 py-3">
              {t.sacos_roupa_suja && t.sacos_roupa_suja > 0 ? (
                <Badge variant="secondary" className="gap-1">
                  <Shirt className="h-3 w-3" />
                  {t.sacos_roupa_suja} saco(s)
                </Badge>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </td>
            <td className="px-4 py-3">
              <EstadoTarefaBadge estado={estadoParaFornecedor(t.estado)} />
            </td>
            <td className="px-4 py-3 text-center">
              <BotaoEntregue t={t} togglingId={togglingId} onToggle={onToggle} />
            </td>
          </tr>
        );
      })}
    </>
  );
}
