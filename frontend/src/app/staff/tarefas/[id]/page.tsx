"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { Loader2, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MSG_SEM_LIGACAO } from "@/lib/rascunho-staff";

import { DetalheTarefaClient } from "@/components/staff/detalhe-tarefa-client";

/**
 * Ecrã de Detalhe da Tarefa — /staff/tarefas/[id]
 *
 * Client Component: busca a tarefa real da API (/api/auth/me/tarefas/:id)
 * e passa ao DetalheTarefaClient que gere o estado interativo.
 *
 * A checklist vem do propriedade_id.checklist (populado pelo backend).
 */
export default function DetalheTarefaPage({
  params,
}: {
  params: { id: string };
}) {
  const [tarefa, setTarefa] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // true quando falhou a rede / servidor (distinto de "tarefa não existe").
  const [semRede, setSemRede] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    setSemRede(false);
    (async () => {
      try {
        const res = await fetch(`/api/auth/me/tarefas/${params.id}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (cancelado) return;
        if (res.ok) {
          const data = await res.json();
          setTarefa(data.tarefa);
        } else if (res.status >= 500) {
          setSemRede(true);
        }
        // 404/403/401: tarefa inexistente ou sem acesso -> notFound abaixo.
      } catch {
        if (!cancelado) setSemRede(true);
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [params.id, tentativa]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!tarefa && semRede) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <WifiOff className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{MSG_SEM_LIGACAO}</p>
        <Button size="touch" onClick={() => setTentativa((t) => t + 1)}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (!tarefa) {
    notFound();
  }

  // Adapta a tarefa real para o formato esperado pelo DetalheTarefaClient.
  const tarefaAdaptada = {
    id: tarefa._id,
    propriedade_nome: tarefa.propriedade_id?.nome ?? "Propriedade",
    hora_limite: "",
    tempo_estimado_minutos: tarefa.tempo_limpeza_minutos,
    estado: tarefa.estado,
    tipo: tarefa.tipo,
    endereco: tarefa.propriedade_id?.morada,
    // Prompt 95 — detalhes da reserva Smoobu (para card de destaque).
    detalhes_reserva: tarefa.detalhes_reserva ?? null,
    // Prompt 114 — Lotação máxima da propriedade (para destaque no detalhe).
    capacidade_hospedes: tarefa.propriedade_id?.capacidade_hospedes ?? null,
    // Prompt 126 — Observações/notas internas da propriedade (regras de acesso, etc.).
    observacoes_propriedade: tarefa.propriedade_id?.observacoes ?? null,
    // Prompt 133 — Checklist dinâmica (snapshot do ModeloChecklist).
    // Se a tarefa tem snapshot, o detalhe do staff renderiza secções em vez
    // da checklist flat. Caso contrário (checklist_dinamica vazia ou null),
    // cai no fallback do array de strings do propriedade_id.checklist.
    checklist_dinamica: Array.isArray(tarefa.checklist_dinamica)
      ? tarefa.checklist_dinamica
      : undefined,
    // Prompt 138 (136 V2) — Tempo de viagem (para mostrar no detalhe).
    tempo_viagem_minutos: tarefa.tempo_viagem_minutos ?? null,
  };

  // Usa a checklist real da propriedade (vinda do populate do backend).
  // Se a propriedade não tiver checklist definida, usa uma vazia (o botão
  // de concluir fica sempre ativo quando não há itens).
  const checklist: string[] = tarefa.propriedade_id?.checklist ?? [];

  return (
    <DetalheTarefaClient
      tarefa={tarefaAdaptada}
      checklist={checklist}
    />
  );
}
