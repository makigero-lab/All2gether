"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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

// Paleta coesa com o tema dourado do FisioCell.
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
  // Prompt 138 (136 V2) — SLA excedido.
  nao_atribuida: "Não atribuída (SLA)",
};

const ESTADO_COR: Record<string, string> = {
  concluida: CORES.verde,
  atribuida: CORES.dourado,
  em_curso: CORES.amber,
  por_atribuir: CORES.muted,
  cancelada: CORES.vermelho,
  // Prompt 138 (136 V2) — vermelho (urgente).
  nao_atribuida: CORES.vermelho,
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

  // Prompt 136 — Resumo IA + exportação PDF via window.print() (nova janela A4)
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResumo, setAiResumo] = useState<string | null>(null);
  const [aiErro, setAiErro] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  // Prompt 127 — Toast visual para erros de PDF.
  const [pdfErro, setPdfErro] = useState<string | null>(null);

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

  // Prompt 136 — Exportar PDF via window.open() + print() (A4, inclui resumo IA + tabelas).
  const exportarPDF = useCallback(async () => {
    if (!data) return;
    setPdfLoading(true);
    setPdfErro(null);
    try {
      const periodo = formatarDataCurta(data.periodo.inicio.slice(0, 10)) + " a " + formatarDataCurta(data.periodo.fim.slice(0, 10));
      const geradoEm = new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });

      // Pre-computa as secções do relatório (evita nested template literals).
      const r = data.resumo;
      const tempoEstimado = r.tempoEstimadoMedioMinutos ?? r.tempoMedioMinutos ?? 0;
      const tempoReal = r.tempoRealMedioMinutos ?? 0;
      const diff = tempoReal - tempoEstimado;

      const kpisHtml = [
        '<div class="kpi"><div class="label">Total Tarefas</div><div class="value">' + (r.totalTarefas ?? 0) + '</div></div>',
        '<div class="kpi"><div class="label">Concluidas</div><div class="value">' + (r.concluidas ?? 0) + '</div><div class="sub">' + Math.round((r.concluidas / Math.max(1, r.totalTarefas)) * 100) + '%</div></div>',
        '<div class="kpi"><div class="label">Tempo Medio</div><div class="value">' + (Math.round((tempoEstimado / 60) * 10) / 10) + 'h</div></div>',
        '<div class="kpi"><div class="label">Diff Real</div><div class="value">' + (diff === 0 ? '—' : (diff > 0 ? '+' : '') + (Math.round(diff / 60 * 10) / 10) + 'h') + '</div></div>',
      ].join('');

      const maxStaff = Math.max(1, ...data.porStaff.map(x => x.total));
      const staffHtml = data.porStaff.length > 0
        ? '<h2>Produtividade por Staff</h2><table><thead><tr><th>Staff</th><th>Total</th><th>Concluidas</th><th>Taxa</th><th>Carga (min)</th><th>Volume</th></tr></thead><tbody>' +
          data.porStaff.map(s => {
            const pct = Math.round(s.taxaConclusao * 100);
            const largura = Math.round((s.total / maxStaff) * 100);
            return '<tr><td>' + s.nome + '</td><td>' + s.total + '</td><td>' + s.concluidas + '</td><td>' + pct + '%</td><td>' + s.carga_minutos + '</td><td><div class="barra-container"><div class="barra" style="width:' + largura + '%"></div></div></td></tr>';
          }).join('') + '</tbody></table>'
        : '';

      const maxProp = Math.max(1, ...data.porPropriedade.map(x => x.total));
      const propHtml = data.porPropriedade.length > 0
        ? '<h2>Tarefas por Propriedade</h2><table><thead><tr><th>Propriedade</th><th>Total</th><th>Concluidas</th><th>Volume</th></tr></thead><tbody>' +
          data.porPropriedade.slice(0, 15).map(p => {
            const largura = Math.round((p.total / maxProp) * 100);
            return '<tr><td>' + p.nome + '</td><td>' + p.total + '</td><td>—</td><td><div class="barra-container"><div class="barra" style="width:' + largura + '%"></div></div></td></tr>';
          }).join('') + '</tbody></table>'
        : '';

      const totalTarefas = data.resumo.totalTarefas || 1;
      const estadoHtml = data.porEstado.length > 0
        ? '<h2>Distribuicao por Estado</h2><table><thead><tr><th>Estado</th><th>Total</th><th>%</th></tr></thead><tbody>' +
          data.porEstado.map(e => {
            const pct = Math.round((e.total / totalTarefas) * 100);
            return '<tr><td>' + e.estado + '</td><td>' + e.total + '</td><td>' + pct + '%</td></tr>';
          }).join('') + '</tbody></table>'
        : '';

      const iaHtml = aiResumo
        ? '<h2>Resumo Executivo IA</h2><div class="ia-box">' + aiResumo.replace(/</g, '&lt;') + '</div>'
        : '';

      const html = [
        '<!DOCTYPE html><html lang="pt-PT"><head><meta charset="utf-8">',
        '<title>Relatorio FisioCell - ' + periodo + '</title>',
        '<style>',
        '* { box-sizing: border-box; margin: 0; padding: 0; }',
        'body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #0f172a; font-size: 12px; line-height: 1.5; padding: 20px; }',
        'h1 { font-size: 18px; font-weight: 700; }',
        'h2 { font-size: 14px; font-weight: 700; margin-top: 16px; margin-bottom: 6px; color: #c9a227; }',
        '.header { border-bottom: 2px solid #c9a227; padding-bottom: 8px; margin-bottom: 16px; }',
        '.ia-box { background: #fffaf0; border: 1px solid #fde68a; border-radius: 6px; padding: 10px; font-size: 11.5px; color: #1f2937; white-space: pre-wrap; margin-bottom: 16px; }',
        '.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }',
        '.kpi { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; text-align: center; }',
        '.kpi .label { font-size: 10px; color: #64748b; text-transform: uppercase; }',
        '.kpi .value { font-size: 18px; font-weight: 700; color: #0f172a; }',
        '.kpi .sub { font-size: 10px; color: #64748b; }',
        'table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px; }',
        'th { background: #f1f5f9; padding: 6px 8px; text-align: left; font-weight: 600; border-bottom: 1px solid #e2e8f0; }',
        'td { padding: 6px 8px; border-bottom: 1px solid #f1f5f9; }',
        '.barra { height: 12px; border-radius: 3px; background: #c9a227; }',
        '.barra-container { width: 100%; height: 12px; background: #f1f5f9; border-radius: 3px; overflow: hidden; }',
        '@media print { body { padding: 0; } }',
        '</style></head><body>',
        '<div class="header"><h1>Relatorio de Produtividade - FisioCell</h1>',
        '<div style="font-size:12px;color:#475569;margin-top:2px;">Periodo: ' + periodo + '</div>',
        '<div style="font-size:11px;color:#64748b;margin-top:2px;">Gerado em ' + geradoEm + '</div></div>',
        iaHtml,
        '<h2>KPIs</h2><div class="kpis">' + kpisHtml + '</div>',
        staffHtml,
        propHtml,
        estadoHtml,
        '</body></html>',
      ].join('');

      // Abre uma nova janela e escreve o HTML.
      const printWindow = window.open('', '_blank', 'width=900,height=700');
      if (!printWindow) {
        throw new Error('O browser bloqueou a abertura da janela. Permite pop-ups para este site.');
      }
      printWindow.document.write(html);
      printWindow.document.close();

      // Espera o conteúdo carregar e abre o diálogo de impressão.
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.print();
          setTimeout(() => printWindow.close(), 500);
        }, 300);
      };
    } catch (e) {
      console.error("Erro ao exportar PDF:", e);
      setPdfErro(
        e instanceof Error
          ? "Erro ao gerar relatorio: " + e.message
          : "Erro ao gerar relatorio PDF."
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
          {/* Prompt 136 — Exportar PDF via window.print() (nova janela A4) */}
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

