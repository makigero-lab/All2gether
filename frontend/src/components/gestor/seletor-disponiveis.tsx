"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { adminGet } from "@/lib/api";

export interface Disponivel {
  _id: string;
  nome: string;
  /** Hora de início prevista para esta pessoa (ISO). */
  hora_prevista: string;
  tempo_viagem_minutos: number;
  /** Tem um pedido de ausência por aprovar que cobre o dia (continua elegível). */
  ausencia_pendente?: boolean;
}

export interface InfoDisponiveis {
  /** 'responsavel': a pessoa escolhida passa a responsável; 'vaga': entra para a equipa que já existe. */
  modo: "responsavel" | "vaga";
  disponiveis: Disponivel[];
  /** Motivo real quando não há ninguém. */
  motivo: string | null;
}

const horaLisboa = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });

/**
 * Seletor de pessoas para a atribuição manual: só quem pode fazer a limpeza (ativo, sem ausência nem
 * folga, na equipa exclusiva da casa e com a limpeza dentro do horário), com a hora prevista.
 * Pede ao servidor UMA vez por limpeza aberta (`GET /api/gestor/tarefas/:id/disponiveis`).
 * `acao`: 'atribuir' mantém a hora da limpeza; 'reatribuir' recalcula-a.
 */
export function SeletorDisponiveis({
  tarefaId,
  acao,
  value,
  onChange,
  onInfo,
  id,
  disabled,
  className,
}: {
  tarefaId: string;
  acao: "atribuir" | "reatribuir";
  value: string;
  onChange: (id: string) => void;
  onInfo?: (info: InfoDisponiveis | null) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [info, setInfo] = useState<InfoDisponiveis | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErro(null);
    setInfo(null);
    onInfo?.(null);
    (async () => {
      try {
        const r = await adminGet<InfoDisponiveis>(`/api/gestor/tarefas/${tarefaId}/disponiveis?acao=${acao}`);
        if (cancelado) return;
        setInfo(r);
        onInfo?.(r);
      } catch (e) {
        if (!cancelado) setErro(e instanceof Error ? e.message : "Não foi possível ver quem está disponível.");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tarefaId, acao]);

  if (carregando) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />A ver quem está disponível…
      </p>
    );
  }
  if (erro) {
    return (
      <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
        {erro}
      </p>
    );
  }
  if (!info || info.disponiveis.length === 0) {
    return (
      <p role="status" className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
        Ninguém disponível para esta limpeza. {info?.motivo ?? ""}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={
          className ??
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <option value="">{info.modo === "vaga" ? "— Escolher quem entra na equipa —" : "— Selecionar —"}</option>
        {info.disponiveis.map((d) => (
          <option key={d._id} value={d._id}>
            {d.nome} — às {horaLisboa(d.hora_prevista)}{d.ausencia_pendente ? " (ausência por aprovar)" : ""}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        Só aparecem as pessoas disponíveis (sem ausência aprovada nem folga, da equipa da casa, com a limpeza dentro do horário). Quem tem um pedido de ausência por aprovar aparece marcado.
        A hora é a prevista para cada uma.
      </p>
    </div>
  );
}

/** Corpo do PATCH /atribuir: em modo «vaga» a pessoa entra na equipa (o responsável mantém-se). */
export function corpoAtribuicao(
  escolhida: string,
  info: InfoDisponiveis | null,
  resp?: { _id?: string } | null,
  equipa?: { _id?: string }[] | null
): Record<string, unknown> {
  if (info?.modo !== "vaga") return { utilizador_id: escolhida };
  const ids = [...new Set([resp?._id, ...(equipa ?? []).map((m) => m._id)].filter((x): x is string => !!x))];
  return { utilizador_id: ids[0] ?? escolhida, equipa_atribuida: [...ids, escolhida] };
}
