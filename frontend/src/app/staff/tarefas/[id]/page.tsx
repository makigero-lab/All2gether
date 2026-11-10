"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { Loader2, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MSG_SEM_LIGACAO } from "@/lib/rascunho-staff";
import { checklistDaTarefa, temHoraReal } from "@/lib/utils";

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
    // Esqueleto com a forma do detalhe (cabeçalho, cartões e checklist), na mesma coluna,
    // em vez de um ecrã branco só com o ícone a rodar.
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 bg-muted/20 p-4 md:max-w-2xl md:border-x" aria-busy="true" aria-label="A carregar a limpeza">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
          <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        </div>
        <div className="h-28 animate-pulse rounded-lg bg-muted" />
        <div className="h-20 animate-pulse rounded-lg bg-muted" />
        <div className="space-y-2 rounded-lg border bg-background p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${90 - i * 10}%` }} />
          ))}
        </div>
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
    // Hora de início no cabeçalho (antes ficava vazio ao lado do relógio).
    hora_limite: tarefa.data && temHoraReal(tarefa.data)
      ? `Início ${new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" }).format(new Date(tarefa.data))}`
      : "Sem hora marcada",
    tempo_estimado_minutos: tarefa.tempo_limpeza_minutos,
    tipo_limpeza: tarefa.tipo_limpeza ?? null,
    checklist_do_tipo: tarefa.checklist_do_tipo === true,
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
    equipa_nomes: tarefa.equipa_nomes ?? null,
    observacoes_staff: tarefa.observacoes_staff ?? null,
    iniciada_em: tarefa.iniciada_em ?? null,
    inicio_origem: tarefa.inicio_origem ?? null,
    nao_consegui_comecar: tarefa.nao_consegui_comecar ?? null,
    tem_lavandaria: !!tarefa.propriedade_id?.fornecedor_id,
    roupa_entregue: tarefa.roupa_entregue === true,
    avarias_abertas_casa: tarefa.avarias_abertas_casa ?? null,
  };

  // Usa a checklist real da propriedade (vinda do populate do backend).
  // Se a propriedade não tiver checklist definida, usa uma vazia (o botão
  // de concluir fica sempre ativo quando não há itens).
  // B1: a checklist da própria tarefa (do tipo de limpeza) tem prioridade; a da
  // casa só entra se a da tarefa vier vazia (tarefas antigas).
  const checklist: string[] = checklistDaTarefa(tarefa);

  return (
    <DetalheTarefaClient
      tarefa={tarefaAdaptada}
      checklist={checklist}
    />
  );
}
