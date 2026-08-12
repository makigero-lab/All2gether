"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ClipboardList,
  Loader2,
  AlertCircle,
  Building2,
  Calendar,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminGet } from "@/lib/api";

interface TarefaParceiroDTO {
  _id: string;
  data: string;
  estado: string;
  tipo: string;
  observacoes?: string;
  hospedes?: number | null;
  propriedade_id: { nome: string; morada?: string } | null;
}

const ESTADO_LABEL: Record<string, string> = {
  por_atribuir: "Por Atribuir",
  atribuida: "Atribuída",
  em_curso: "Em Curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  nao_atribuida: "Não Atribuída",
};

const ESTADO_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  por_atribuir: "warning",
  atribuida: "secondary",
  em_curso: "default",
  concluida: "success",
  cancelada: "outline",
  nao_atribuida: "destructive",
};

export default function ParceiroTarefasPage() {
  const [tarefas, setTarefas] = useState<TarefaParceiroDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const data = await adminGet<{ tarefas: TarefaParceiroDTO[] }>("/api/parceiro/tarefas");
      setTarefas(data.tarefas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function formatarData(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString("pt-PT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardList className="h-6 w-6 text-primary" />
          Tarefas de Limpeza
        </h1>
        <p className="text-sm text-muted-foreground">
          Limpezas geradas automaticamente a partir das tuas reservas (vista apenas de leitura).
        </p>
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
          <ClipboardList className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Sem tarefas. As tarefas são geradas automaticamente quando crias reservas.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tarefas.map((t) => (
            <Card key={t._id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4 text-primary" />
                  {t.propriedade_id?.nome ?? "Propriedade"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>{formatarData(t.data)}</span>
                </div>
                {t.hospedes != null && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    <span>{t.hospedes} hóspede(s)</span>
                  </div>
                )}
                {t.observacoes && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{t.observacoes}</p>
                )}
                <Badge variant={ESTADO_VARIANT[t.estado] ?? "outline"}>
                  {ESTADO_LABEL[t.estado] ?? t.estado}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
