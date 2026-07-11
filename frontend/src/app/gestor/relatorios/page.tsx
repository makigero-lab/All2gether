"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Clock,
  TrendingUp,
  AlertTriangle,
  Timer,
  FileDown,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { adminGet } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

interface PorStaff {
  utilizador_id: string | null;
  nome: string;
  total: number;
  concluidas: number;
  carga_minutos: number;
  taxaConclusao: number;
}

interface PorDia {
  data: string;
  total: number;
  concluidas: number;
  carga_minutos: number;
}

interface PorEstado {
  estado: string;
  total: number;
}

interface PorPropriedade {
  propriedade_id: string;
  nome: string;
  total: number;
  carga_minutos: number;
}

interface RelatorioData {
  periodo: { inicio: string; fim: string };
  resumo: {
    totalTarefas: number;
    concluidas: number;
    taxaConclusao: number;
    emAtraso: number;
    taxaAtraso: number;
    cargaTotalMinutos: number;
    tempoMedioMinutos: number;
    tempoEstimadoMedioMinutos?: number;
    tempoRealMedioMinutos?: number;
  };
  porStaff: PorStaff[];
  porDia: PorDia[];
  porEstado: PorEstado[];
  porPropriedade: PorPropriedade[];
}

/* ------------------------------------------------------------------ */
/* Paleta e constantes                                                 */
/* ------------------------------------------------------------------ */

// Paleta coesa com o tema dourado do Autocell.
const CORES = {
  dourado: "hsl(43, 74%, 49%)",
  verde: "hsl(142, 71%, 45%)",
  vermelho: "hsl(0, 72%, 51%)",
  amber: "hsl(38, 92%, 50%)",
  muted: "hsl(220, 14%, 55%)",
};

const ESTADO_LABEL: Record<string, string> = {
  por_atribuir: "Por atribuir",
  atribuida: "Atribuída",
  em_curso: "Em curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

const ESTADO_COR: Record<string, string> = {
  concluida: CORES.verde,
  atribuida: CORES.dourado,
  em_curso: CORES.amber,
  por_atribuir: CORES.muted,
  cancelada: CORES.vermelho,
};

const PRESETS = [
  { id: "7", label: "7 dias", dias: 7 },
  { id: "30", label: "30 dias", dias: 30 },
  { id: "90", label: "90 dias", dias: 90 },
] as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatarDataInput(d: Date): string {
  // yyyy-mm-dd para <input type="date">.
  return d.toISOString().slice(0, 10);
}

function formatarDataCurta(iso: string): string {
  // dd/mm a partir de yyyy-mm-dd.
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function formatarHoras(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function formatarPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function RelatoriosPage() {
  const [data, setData] = useState<RelatorioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Período: preset selecionado + datas custom.
  const [preset, setPreset] = useState<string>("30");
  const [inicio, setInicio] = useState<string>("");
  const [fim, setFim] = useState<string>("");

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (inicio) params.set("inicio", inicio);
      if (fim) params.set("fim", fim);
      const res = await adminGet<RelatorioData>(
        `/api/gestor/relatorios/produtividade?${params.toString()}`
      );
      setData(res);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar relatório.");
    } finally {
      setLoading(false);
    }
  }, [inicio, fim]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const aplicarPreset = (dias: number) => {
    const f = new Date();
    const i = new Date();
    i.setDate(i.getDate() - dias);
    setInicio(formatarDataInput(i));
    setFim(formatarDataInput(f));
    setPreset(String(dias));
  };

  const limparPeriodo = () => {
    setInicio("");
    setFim("");
    setPreset("30");
  };

  // Resumo em cartões.
  const stats = useMemo(() => {
    if (!data) return [];
    const r = data.resumo;
    const tempoEstimado = r.tempoEstimadoMedioMinutos ?? r.tempoMedioMinutos ?? 0;
    const tempoReal = r.tempoRealMedioMinutos ?? 0;
    // Diferença real - estimado. Negativo = staff demorou menos (verde).
    // Positivo = staff demorou mais (vermelho).
    const diff = tempoReal - tempoEstimado;
    const diffCor = tempoReal === 0
      ? CORES.muted
      : diff <= 0
        ? CORES.verde
        : CORES.vermelho;
    const diffLabel =
      tempoReal === 0
        ? "Sem dados"
        : diff <= 0
          ? `${formatarHoras(Math.abs(diff))} mais rápido`
          : `${formatarHoras(diff)} mais lento`;
    return [
      {
        label: "Total tarefas",
        value: String(r.totalTarefas),
        icon: BarChart3,
        cor: CORES.dourado,
      },
      {
        label: "Concluídas",
        value: String(r.concluidas),
        sub: formatarPercent(r.taxaConclusao),
        icon: CheckCircle2,
        cor: CORES.verde,
      },
      {
        label: "Em atraso",
        value: String(r.emAtraso),
        sub: formatarPercent(r.taxaAtraso),
        icon: AlertTriangle,
        cor: CORES.vermelho,
      },
      {
        label: "Carga total",
        value: formatarHoras(r.cargaTotalMinutos),
        icon: Timer,
        cor: CORES.amber,
      },
      {
        label: "Tempo médio estimado",
        value: formatarHoras(tempoEstimado),
        icon: TrendingUp,
        cor: CORES.muted,
      },
      {
        label: "Tempo real médio",
        value: formatarHoras(tempoReal),
        sub: tempoReal > 0 ? "Concluídas" : undefined,
        icon: Clock,
        cor: CORES.amber,
      },
      {
        label: "Diferença (real - estimado)",
        value: tempoReal === 0 ? "—" : formatarHoras(Math.abs(diff)),
        sub: diffLabel,
        icon: diff <= 0 && tempoReal > 0 ? CheckCircle2 : AlertTriangle,
        cor: diffCor,
      },
    ];
  }, [data]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho — escondido na impressão (print:hidden) */}
      <div className="hidden flex-col gap-1 lg:flex print:hidden">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Relatórios</h1>
          <Button
            variant="outline"
            size="icon"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {/* Prompt 118 — Exportar PDF (window.print otimizado com @media print) */}
          <Button
            variant="outline"
            onClick={() => window.print()}
            disabled={loading || !data}
            title="Gera um PDF limpo com os gráficos e métricas (usa a janela de impressão do browser)"
            className="gap-2"
          >
            <FileDown className="h-4 w-4" />
            Exportar PDF
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Produtividade da equipa e distribuição de tarefas no período selecionado.
        </p>
      </div>

      {/* Filtro de período — escondido na impressão */}
      <Card className="print:hidden">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Período rápido</span>
            <div className="flex gap-1">
              {PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={preset === p.id ? "default" : "outline"}
                  onClick={() => aplicarPreset(p.dias)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="inicio" className="text-xs font-medium text-muted-foreground">
              Início
            </label>
            <Input
              id="inicio"
              type="date"
              value={inicio}
              onChange={(e) => {
                setInicio(e.target.value);
                setPreset("");
              }}
              className="w-40"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="fim" className="text-xs font-medium text-muted-foreground">
              Fim
            </label>
            <Input
              id="fim"
              type="date"
              value={fim}
              onChange={(e) => {
                setFim(e.target.value);
                setPreset("");
              }}
              className="w-40"
            />
          </div>

          <Button variant="ghost" size="sm" onClick={limparPeriodo}>
            Limpar
          </Button>

          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {data
              ? `${formatarDataCurta(data.periodo.inicio.slice(0, 10))} — ${formatarDataCurta(
                  data.periodo.fim.slice(0, 10)
                )}`
              : "—"}
          </div>
        </CardContent>
      </Card>

      {/* Estados */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar relatório…
        </div>
      ) : erro ? (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{erro}</span>
            <Button variant="outline" size="sm" onClick={carregar} className="ml-auto">
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Cabeçalho de impressão — só visível no PDF (hidden no ecrã) */}
          <div className="hidden print:block mb-4">
            <h1 className="text-xl font-bold">Relatório de Produtividade — Autocell</h1>
            <p className="text-sm text-muted-foreground">
              Período: {formatarDataCurta(data.periodo.inicio.slice(0, 10))} a{" "}
              {formatarDataCurta(data.periodo.fim.slice(0, 10))}
            </p>
            <p className="text-xs text-muted-foreground">
              Gerado em {new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" })}
            </p>
          </div>

          {/* Cartões de resumo */}
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-7">
            {stats.map((s) => {
              const Icon = s.icon;
              return (
                <Card key={s.label}>
                  <CardContent className="flex items-center gap-4 p-5">
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `color-mix(in srgb, ${s.cor} 15%, transparent)`, color: s.cor }}
                    >
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-2xl font-bold leading-none">{s.value}</span>
                      <span className="mt-1 text-sm text-muted-foreground">{s.label}</span>
                      {s.sub && (
                        <span className="text-xs font-medium" style={{ color: s.cor }}>
                          {s.sub}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Gráfico de linha — tarefas por dia */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                Evolução diária
              </CardTitle>
              <CardDescription>
                Tarefas agendadas vs. concluídas por dia.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.porDia.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Sem dados para o período selecionado.
                </p>
              ) : (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.porDia} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" />
                      <XAxis
                        dataKey="data"
                        tickFormatter={formatarDataCurta}
                        tick={{ fontSize: 12 }}
                        className="fill-muted-foreground"
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                      <Tooltip
                        labelFormatter={(l) => formatarDataCurta(String(l))}
                        contentStyle={{ borderRadius: 8, fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line
                        type="monotone"
                        dataKey="total"
                        name="Agendadas"
                        stroke={CORES.dourado}
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="concluidas"
                        name="Concluídas"
                        stroke={CORES.verde}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Gráfico de barras — produtividade por staff */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  Produtividade por funcionário
                </CardTitle>
                <CardDescription>Concluídas vs. total de tarefas atribuídas.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.porStaff.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Sem tarefas atribuídas no período.
                  </p>
                ) : (
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={data.porStaff}
                        layout="vertical"
                        margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" horizontal={false} />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                        <YAxis
                          type="category"
                          dataKey="nome"
                          width={90}
                          tick={{ fontSize: 12 }}
                          className="fill-muted-foreground"
                        />
                        <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="concluidas" name="Concluídas" stackId="a" fill={CORES.verde} radius={[0, 0, 0, 0]} />
                        <Bar dataKey="total" name="Total" stackId="a" fill={CORES.dourado} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pie chart — distribuição por estado */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  Distribuição por estado
                </CardTitle>
                <CardDescription>Repartição das tarefas no período.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.porEstado.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Sem dados para o período.
                  </p>
                ) : (
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.porEstado}
                          dataKey="total"
                          nameKey="estado"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          innerRadius={45}
                          paddingAngle={2}
                          label={({ payload }: { payload?: PorEstado }) =>
                            `${ESTADO_LABEL[payload?.estado ?? ""] ?? payload?.estado}: ${payload?.total ?? 0}`
                          }
                          labelLine={false}
                          style={{ fontSize: 11 }}
                        >
                          {data.porEstado.map((e) => (
                            <Cell key={e.estado} fill={ESTADO_COR[e.estado] ?? CORES.muted} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v, n) => [v, ESTADO_LABEL[String(n)] ?? n]}
                          contentStyle={{ borderRadius: 8, fontSize: 12 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Tabela — por propriedade */}
          <Card>
            <CardHeader>
              <CardTitle>Carga por propriedade</CardTitle>
              <CardDescription>Tarefas e carga total (minutos) por propriedade.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.porPropriedade.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Sem propriedades com tarefas no período.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Propriedade</th>
                        <th className="py-2 pr-4 text-right font-medium">Tarefas</th>
                        <th className="py-2 pr-4 text-right font-medium">Carga</th>
                        <th className="py-2 text-right font-medium">% do total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.porPropriedade.map((p) => {
                        const pct = data.resumo.totalTarefas > 0 ? (p.total / data.resumo.totalTarefas) * 100 : 0;
                        return (
                          <tr key={p.propriedade_id} className="border-b last:border-0">
                            <td className="py-2.5 pr-4 font-medium">{p.nome}</td>
                            <td className="py-2.5 pr-4 text-right">{p.total}</td>
                            <td className="py-2.5 pr-4 text-right">{formatarHoras(p.carga_minutos)}</td>
                            <td className="py-2.5 text-right">
                              <Badge variant="outline">{Math.round(pct)}%</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
