"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { Loader2 } from "lucide-react";

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

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/auth/me/tarefas/${params.id}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setTarefa(data.tarefa);
        }
      } catch {
        // silencioso
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
