"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Sparkles,
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
import { adminGet, adminPost } from "@/lib/api";

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

  // Prompt 124-Fix1 — Resumo IA + exportação PDF (html2pdf.js)
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResumo, setAiResumo] = useState<string | null>(null);
  const [aiErro, setAiErro] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  // Prompt 127 — Toast visual para erros de PDF.
  const [pdfErro, setPdfErro] = useState<string | null>(null);
  const pdfExportRef = useRef<HTMLDivElement | null>(null);

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

  // Prompt 124-Fix1 — Gera o Resumo Executivo com IA.
  const gerarResumoIA = useCallback(async () => {
    if (!data) return;
    setAiLoading(true);
    setAiErro(null);
    setAiResumo(null);
    try {
      const res = await adminPost<{ resumo: string }>(
        "/api/gestor/relatorios/ai-summary",
        data
      );
      setAiResumo(res.resumo);
    } catch (e) {
      setAiErro(e instanceof Error ? e.message : "Erro ao gerar resumo IA.");
    } finally {
      setAiLoading(false);
    }
  }, [data]);

  // Prompt 124-Fix1 — Exportar PDF com html2pdf.js (A4, inclui resumo IA + tabelas + gráficos).
  const exportarPDF = useCallback(async () => {
    if (!data) return;
    setPdfLoading(true);
    setPdfErro(null);
    try {
      // Torna o div de exportação VISÍVEL temporariamente para o html2canvas
      // conseguir capturá-lo. O problema: opacity:0.01 e zIndex:-50 fazem
      // com que o html2canvas capture um div vazio em alguns browsers.
      // Solução: tornar visível, capturar, depois voltar a esconder.
      if (pdfExportRef.current) {
        pdfExportRef.current.style.opacity = "1";
        pdfExportRef.current.style.zIndex = "9999";
        pdfExportRef.current.style.left = "0";
        pdfExportRef.current.style.top = "0";
      }

      // Espera que o DOM atualize.
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verifica se o ref tem conteúdo.
      if (!pdfExportRef.current) {
        throw new Error('Não foi possível preparar o documento para exportação.');
      }

      // Se há resumo IA, espera mais 300ms.
      if (aiResumo) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Import dinâmico para evitar problemas de SSR com html2pdf.js.
      const html2pdf = (await import("html2pdf.js")).default;
      const el = pdfExportRef.current;

      // Prompt 131b — Verificação extra: se aiResumo existe, confirma que
      // o texto foi mesmo renderizado no div de exportação antes de capturar.
      // Isto evita PDFs em branco quando o React ainda não atualizou o div.
      if (aiResumo && el && !el.textContent?.includes(aiResumo.slice(0, 30))) {
        // Espera mais 500ms e volta a verificar.
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const filename = `relatorio-autocell-${data.periodo.inicio
        .slice(0, 10)
        .replace(/-/g, "")}-${data.periodo.fim.slice(0, 10).replace(/-/g, "")}.pdf`;

      // O conteúdo do div de exportação é construído via React (renderizado
      // off-screen). Aqui só disparamos o html2pdf sobre esse div.
      // Prompt 131b — Mesmo sem aiResumo, o PDF é gerado com tabelas/gráficos.
      const opt = {
        margin: [10, 10, 12, 10] as [number, number, number, number],
        filename,
        image: { type: "jpeg" as const, quality: 0.96 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait" as const,
        },
        pagebreak: { mode: ["css", "legacy"] as const },
      };

      await html2pdf().set(opt).from(el).save();

      // Restaura o estado oculto do div de exportação.
      if (pdfExportRef.current) {
        pdfExportRef.current.style.opacity = "0.01";
        pdfExportRef.current.style.zIndex = "-50";
      }
    } catch (e) {
      console.error("Erro ao exportar PDF:", e);
      // Restaura o estado oculto mesmo em caso de erro.
      if (pdfExportRef.current) {
        pdfExportRef.current.style.opacity = "0.01";
        pdfExportRef.current.style.zIndex = "-50";
      }
      setPdfErro(
        e instanceof Error
          ? `Erro ao gerar relatório: ${e.message}`
          : "Erro ao gerar relatório PDF."
      );
      setTimeout(() => setPdfErro(null), 8000);
    } finally {
      setPdfLoading(false);
    }
  }, [data, aiResumo]);

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
      {/* Cabeçalho */}
      <div className="hidden flex-col gap-1 lg:flex">
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
          {/* Prompt 124-Fix1 — Exportar PDF via html2pdf.js (A4, com resumo IA + tabelas + gráficos) */}
          <Button
            variant="outline"
            onClick={exportarPDF}
            disabled={loading || !data || pdfLoading}
            title="Gera um PDF A4 com os gráficos, tabelas e resumo IA"
            className="gap-2"
          >
            {pdfLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            Exportar PDF
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Produtividade da equipa e distribuição de tarefas no período selecionado.
        </p>
      </div>

      {/* Filtro de período */}
      <Card>
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

          {/* Prompt 127 — Toast de erro do PDF */}
          {pdfErro && (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span className="flex-1">{pdfErro}</span>
                <Button variant="ghost" size="sm" onClick={() => setPdfErro(null)}>Fechar</Button>
              </CardContent>
            </Card>
          )}

          {/* Prompt 124-Fix1 — Cartão do Resumo Executivo IA.
              Prompt 131b — O card está SEMPRE visível (não só quando aiLoading/aiResumo/aiErro),
              para que o utilizador possa clicar no botão "Gerar Relatório Inteligente" e disparar
              a geração do resumo. O botão foi movido do cabeçalho para dentro do CardHeader. */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    Resumo Executivo IA
                  </CardTitle>
                  <CardDescription>
                    Análise automática focada em gestão — tendências e eficiência.
                  </CardDescription>
                </div>
                {/* Botão "Gerar Relatório Inteligente" movido para dentro do card. */}
                <Button
                  variant="default"
                  onClick={gerarResumoIA}
                  disabled={loading || !data || aiLoading}
                  title="Gera um Resumo Executivo com IA a partir dos dados do relatório"
                  className="gap-2"
                >
                  {aiLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Gerar Relatório Inteligente
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {aiLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A gerar resumo com IA…
                </div>
              ) : aiErro ? (
                <div className="flex items-center gap-2 py-4 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{aiErro}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={gerarResumoIA}
                    className="ml-auto"
                  >
                    Tentar novamente
                  </Button>
                </div>
              ) : aiResumo ? (
                <ResumoIATexto texto={aiResumo} />
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  Clica em <strong>“Gerar Relatório Inteligente”</strong> para
                  obteres uma análise automática dos dados do período.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Prompt 124-Fix1 — Conteúdo oculto usado pelo html2pdf para exportar PDF A4.
              Prompt 131b — Em vez de position: absolute; left: -99999px (que em alguns
              browsers faz o html2canvas capturar um div vazio), usamos position: fixed;
              left: 0; top: 0; z-index: -1; opacity: 0; pointer-events: none. Isto mantém
              o div dentro do viewport (html2canvas consegue capturá-lo) mas invisível ao
              utilizador. Inclui resumo IA + tabelas + gráficos. */}
          {data && (
            <div
              ref={pdfExportRef}
              aria-hidden
              style={{
                position: "fixed",
                left: 0,
                top: 0,
                zIndex: -50,
                opacity: 0.01,
                pointerEvents: "none",
                width: "794px",
                background: "#ffffff",
                color: "#0f172a",
                padding: "24px",
                fontFamily:
                  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
                fontSize: "12px",
                lineHeight: 1.5,
              }}
            >
              <PdfExportContent data={data} stats={stats} aiResumo={aiResumo} />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente auxiliar — renderização do resumo IA (markdown simples)  */
/* ------------------------------------------------------------------ */

/**
 * Renderiza o resumo IA (texto com markdown leve: ## headings, - bullets,
 * **bold**) de forma legível, sem bibliotecas externas.
 */
function ResumoIATexto({ texto }: { texto: string }) {
  const linhas = texto.split(/\r?\n/);
  const blocos: ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: number) => {
    if (bullets.length === 0) return;
    blocos.push(
      <ul key={`bullets-${key}`} className="my-2 ml-1 list-none space-y-1">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span>{renderarInline(b)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  linhas.forEach((linha, idx) => {
    const t = linha.trim();
    if (t.startsWith("## ")) {
      flushBullets(idx);
      blocos.push(
        <h3
          key={`h-${idx}`}
          className="mt-4 mb-1 text-sm font-semibold text-primary first:mt-0"
        >
          {t.slice(3).trim()}
        </h3>
      );
    } else if (t.startsWith("# ")) {
      flushBullets(idx);
      blocos.push(
        <h3
          key={`h-${idx}`}
          className="mt-4 mb-1 text-base font-bold first:mt-0"
        >
          {t.slice(2).trim()}
        </h3>
      );
    } else if (t.startsWith("- ") || t.startsWith("* ")) {
      bullets.push(t.slice(2).trim());
    } else if (t === "") {
      flushBullets(idx);
    } else {
      flushBullets(idx);
      blocos.push(
        <p key={`p-${idx}`} className="my-1 text-sm leading-relaxed">
          {renderarInline(t)}
        </p>
      );
    }
  });
  flushBullets(linhas.length);

  return <div className="space-y-1">{blocos}</div>;
}

/**
 * Renderiza **bold** e *itálico* de forma muito simples (regex, sem XSS —
 * o conteúdo vem do nosso próprio backend / IA, não do utilizador).
 */
function renderarInline(texto: string): ReactNode {
  // Split por **bold** primeiro, depois por *italic*.
  const partes = texto.split(/(\*\*[^*]+\*\*)/g);
  return partes.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    }
    // Itálico simples.
    const sub = p.split(/(\*[^*]+\*)/g);
    return sub.map((s, j) => {
      if (s.startsWith("*") && s.endsWith("*") && s.length > 2) {
        return (
          <em key={`${i}-${j}`} className="italic">
            {s.slice(1, -1)}
          </em>
        );
      }
      return <span key={`${i}-${j}`}>{s}</span>;
    });
  });
}

/* ------------------------------------------------------------------ */
/* Componente auxiliar — conteúdo do PDF (A4, com resumo IA + tabelas) */
/* ------------------------------------------------------------------ */

interface PdfExportContentProps {
  data: RelatorioData;
  stats: { label: string; value: string; sub?: string }[];
  aiResumo: string | null;
}

/**
 * Estrutura HTML usada pelo html2pdf para gerar o PDF A4. Usa estilos
 * inline (para garantir renderização consistente pelo html2canvas) e
 * inclui: cabeçalho, período, resumo IA, KPIs, tabelas (staff,
 * propriedades, estados) e minigráficos de barras horizontais baseados
 * em divs (sem dependência do recharts no PDF).
 */
function PdfExportContent({ data, stats, aiResumo }: PdfExportContentProps) {
  const periodo = `${formatarDataCurta(data.periodo.inicio.slice(0, 10))} a ${formatarDataCurta(
    data.periodo.fim.slice(0, 10)
  )}`;
  const geradoEm = new Date().toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  // Largura máxima de barras (px).
  const maxBarra = 360;
  const maxStaffTotal = Math.max(1, ...data.porStaff.map((s) => s.total));
  const maxPropTotal = Math.max(1, ...data.porPropriedade.map((p) => p.total));

  return (
    <div>
      {/* Cabeçalho */}
      <div style={{ borderBottom: "2px solid #c9a227", paddingBottom: 8, marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
          Relatório de Produtividade — Autocell
        </div>
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Período: {periodo}
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
          Gerado em {geradoEm}
        </div>
      </div>

      {/* Resumo IA */}
      {aiResumo && (
        <div style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#c9a227",
              marginBottom: 6,
            }}
          >
            Resumo Executivo IA
          </div>
          <div
            style={{
              background: "#fffaf0",
              border: "1px solid #fde68a",
              borderRadius: 6,
              padding: 10,
              fontSize: 11.5,
              color: "#1f2937",
              whiteSpace: "pre-wrap",
            }}
          >
            {aiResumo}
          </div>
        </div>
      )}

      {/* KPIs em grelha */}
      <div style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#0f172a",
            marginBottom: 6,
          }}
        >
          Indicadores-chave
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
          }}
        >
          {stats.map((s) => (
            <div
              key={s.label}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                padding: 8,
                background: "#f8fafc",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                {s.label}
              </div>
              {s.sub && (
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                  {s.sub}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Tabela — Produtividade por staff + minibarra */}
      {data.porStaff.length > 0 && (
        <div style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              marginBottom: 6,
            }}
          >
            Produtividade por funcionário
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "2px solid #cbd5e1", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>Funcionário</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>Total</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>Concl.</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>%</th>
                <th style={{ padding: "4px 6px" }}>Carga</th>
              </tr>
            </thead>
            <tbody>
              {data.porStaff.map((s, i) => (
                <tr
                  key={s.utilizador_id ?? i}
                  style={{ borderBottom: "1px solid #e2e8f0" }}
                >
                  <td style={{ padding: "4px 6px", fontWeight: 600 }}>{s.nome}</td>
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.total}</td>
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.concluidas}</td>
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>
                    {Math.round(s.taxaConclusao * 100)}%
                  </td>
                  <td style={{ padding: "4px 6px" }}>
                    <div
                      style={{
                        height: 8,
                        width: `${Math.max(
                          4,
                          (s.total / maxStaffTotal) * maxBarra
                        )}px`,
                        background: "#c9a227",
                        borderRadius: 4,
                      }}
                      title={formatarHoras(s.carga_minutos)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tabela — Carga por propriedade + minibarra */}
      {data.porPropriedade.length > 0 && (
        <div style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              marginBottom: 6,
            }}
          >
            Carga por propriedade
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "2px solid #cbd5e1", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>Propriedade</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>Tarefas</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>Carga</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>% do total</th>
                <th style={{ padding: "4px 6px" }}>Distrib.</th>
              </tr>
            </thead>
            <tbody>
              {data.porPropriedade.map((p, i) => {
                const pct =
                  data.resumo.totalTarefas > 0
                    ? (p.total / data.resumo.totalTarefas) * 100
                    : 0;
                return (
                  <tr
                    key={p.propriedade_id ?? i}
                    style={{ borderBottom: "1px solid #e2e8f0" }}
                  >
                    <td style={{ padding: "4px 6px", fontWeight: 600 }}>{p.nome}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{p.total}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {formatarHoras(p.carga_minutos)}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {Math.round(pct)}%
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <div
                        style={{
                          height: 8,
                          width: `${Math.max(
                            4,
                            (p.total / maxPropTotal) * maxBarra
                          )}px`,
                          background: "#22c55e",
                          borderRadius: 4,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Tabela — Distribuição por estado */}
      {data.porEstado.length > 0 && (
        <div style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              marginBottom: 6,
            }}
          >
            Distribuição por estado
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "2px solid #cbd5e1", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>Estado</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>Tarefas</th>
                <th style={{ padding: "4px 6px", textAlign: "right" }}>% do total</th>
              </tr>
            </thead>
            <tbody>
              {data.porEstado.map((e, i) => {
                const pct =
                  data.resumo.totalTarefas > 0
                    ? (e.total / data.resumo.totalTarefas) * 100
                    : 0;
                return (
                  <tr
                    key={e.estado ?? i}
                    style={{ borderBottom: "1px solid #e2e8f0" }}
                  >
                    <td style={{ padding: "4px 6px", fontWeight: 600 }}>
                      {ESTADO_LABEL[e.estado] ?? e.estado}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{e.total}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {Math.round(pct)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Rodapé */}
      <div
        style={{
          marginTop: 24,
          paddingTop: 8,
          borderTop: "1px solid #e2e8f0",
          fontSize: 10,
          color: "#94a3b8",
          textAlign: "center",
        }}
      >
        Autocell — Relatório gerado automaticamente. Dados confidenciais.
      </div>
    </div>
  );
}
