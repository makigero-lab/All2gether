"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Users,
  ClipboardList,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/api";

interface DashboardData {
  totalPropriedades: number;
  propriedadesAtivas: number;
  membrosEquipaAtivos: number;
  tarefasHoje: number;
  tarefasPorAtribuir: number;
  tarefasConcluidasHoje: number;
  tarefasPorStaff: { utilizador_id: string; nome: string; tarefas: number; carga_minutos: number }[];
}

/**
 * Dashboard do Gestor (/manager) — dados reais.
 * Consome GET /api/admin/dashboard (via proxy same-origin).
 *
 * Diferença para o /admin: SEM o banner de emergência (esse é exclusivo do admin).
 */
export default function ManagerDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const dashRes = await adminGet<DashboardData>("/api/admin/dashboard");
      setData(dashRes);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const stats = data
    ? [
        { label: "Propriedades", value: `${data.propriedadesAtivas}/${data.totalPropriedades}`, icon: Building2 },
        { label: "Staff ativo", value: data.membrosEquipaAtivos, icon: Users },
        { label: "Tarefas hoje", value: data.tarefasHoje, icon: ClipboardList },
        { label: "Por atribuir", value: data.tarefasPorAtribuir, icon: AlertCircle },
        { label: "Concluídas", value: data.tarefasConcluidasHoje, icon: CheckCircle2 },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="hidden flex-col gap-1 lg:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <Button variant="outline" size="icon" onClick={carregar} disabled={loading} aria-label="Atualizar">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Visão operacional das limpezas de hoje (dados em tempo real).
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          A carregar dashboard…
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
          {/* Cartões de estatística */}
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {stats.map((s) => {
              const Icon = s.icon;
              return (
                <Card key={s.label}>
                  <CardContent className="flex items-center gap-4 p-5">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-2xl font-bold leading-none">
                        {s.value}
                      </span>
                      <span className="mt-1 text-sm text-muted-foreground">
                        {s.label}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Carga por staff */}
          <Card>
            <CardHeader>
              <CardTitle>Estado da equipa</CardTitle>
              <CardDescription>Carga de trabalho de hoje.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.tarefasPorStaff.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sem tarefas atribuídas hoje.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.tarefasPorStaff.map((s) => (
                    <li key={s.utilizador_id} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{s.nome}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.tarefas} tarefas
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={s.carga_minutos > 420 ? "destructive" : "secondary"}>
                          {Math.floor(s.carga_minutos / 60)}h{String(s.carga_minutos % 60).padStart(2, "0")}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
