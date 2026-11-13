"use client";

/**
 * Peças comuns da vista Dia e da Semana em lista do calendário do gestor:
 * círculo com a inicial da pessoa (cor própria), grupo de círculos sobrepostos
 * (limpeza de equipa) e etiqueta de estado com ícone e texto.
 * O estado nunca depende só da cor: leva sempre ícone e texto.
 */

import { AlertTriangle, Ban, Check, Clock, Play, UserPlus, UserX, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { infoEstadoTarefa } from "@/lib/estados";
import { textoSobreCor } from "@/lib/cores-equipa";
import { cn } from "@/lib/utils";
import { textoFalta } from "@/lib/equipa";

export const COR_SEM_MAPA = "#64748b";

export function primeiroNome(nome?: string | null): string {
  return (nome ?? "").trim().split(/\s+/)[0] || "";
}

export interface MembroCor {
  _id: string;
  nome: string;
}

/** Círculo com a inicial (cor da pessoa) ou, sem cor, o círculo tracejado «?» de «Por atribuir». */
export function AvatarPessoa({
  nome,
  cor,
  pequeno,
  className,
}: {
  nome?: string;
  cor?: string | null;
  pequeno?: boolean;
  className?: string;
}) {
  const tam = pequeno ? "pessoa-av pessoa-av--s" : "pessoa-av";
  if (!cor) {
    return (
      <span className={cn(tam, "pessoa-av--vazio", className)} aria-hidden="true">
        ?
      </span>
    );
  }
  return (
    <span className={cn(tam, className)} style={{ background: cor, color: textoSobreCor(cor) }} aria-hidden="true">
      {primeiroNome(nome).charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** Círculos sobrepostos dos membros de uma limpeza (o primeiro é o responsável). */
export function GrupoAvatares({ membros, cores, pequeno }: { membros: MembroCor[]; cores: Map<string, string>; pequeno?: boolean }) {
  if (membros.length === 0) return <AvatarPessoa pequeno={pequeno} />;
  return (
    <span className="pessoa-grupo">
      {membros.map((m) => (
        <AvatarPessoa key={m._id} nome={m.nome} cor={cores.get(m._id) ?? COR_SEM_MAPA} pequeno={pequeno} />
      ))}
    </span>
  );
}

const ICONE_ESTADO: Record<string, LucideIcon> = {
  concluida: Check,
  em_curso: Play,
  atribuida: Clock,
  por_atribuir: UserPlus,
  nao_atribuida: UserX,
  cancelada: Ban,
};

/** Etiqueta de estado (ícone + texto) nas cores do estado (tokens --status-*). `soIcone`: só o ícone (cartões estreitos). */
export function EtiquetaEstado({ estado, className, soIcone }: { estado: string; className?: string; soIcone?: boolean }) {
  const info = infoEstadoTarefa(estado);
  const Icone = ICONE_ESTADO[estado] ?? Clock;
  return (
    <span
      className={cn("pessoa-etiqueta", soIcone && "pessoa-etiqueta--icone", className)}
      style={{ color: `hsl(var(--status-${info.token}))`, borderColor: `hsl(var(--status-${info.token}) / 0.45)` }}
      title={soIcone ? info.label : undefined}
      aria-label={soIcone ? info.label : undefined}
    >
      <Icone className="h-3 w-3 shrink-0" aria-hidden="true" />
      {!soIcone && info.label}
    </span>
  );
}

export interface CamposAviso {
  alerta_orfao?: boolean;
  alerta_mensagem?: string;
  pessoas_em_falta?: number | null;
}

/** Texto dos avisos de uma limpeza («Órfã: ...», «Falta 1 pessoa») para aria-label e title; null se não houver. */
export function textoAvisos(t: CamposAviso): string | null {
  const out = [t.alerta_orfao ? t.alerta_mensagem || "Órfã: a pessoa está ausente" : null, textoFalta(t.pessoas_em_falta)].filter(Boolean);
  return out.length ? out.join(". ") : null;
}

/** Estado em que o cartão é pintado: uma órfã leva o vermelho dos alertas (como no Mês). */
export function tokenDoCartao(t: CamposAviso & { estado: string }): string {
  return t.alerta_orfao ? "naoat" : infoEstadoTarefa(t.estado).token;
}

/** Selos vermelhos «Órfã» (pessoa ausente com a limpeza atribuída) e «Falta N pessoa(s)». Texto + ícone, nunca só cor. */
export function AvisosLimpeza({ t, className }: { t: CamposAviso; className?: string }) {
  const falta = textoFalta(t.pessoas_em_falta);
  if (!t.alerta_orfao && !falta) return null;
  return (
    <>
      {t.alerta_orfao && (
        <span className={cn("pessoa-aviso", className)} title={t.alerta_mensagem || "Órfã: a pessoa está ausente nesta data"}>
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          Órfã
        </span>
      )}
      {falta && (
        <span className={cn("pessoa-aviso", className)} title={falta}>
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {falta}
        </span>
      )}
    </>
  );
}

export interface AusenteDia {
  nome: string;
  /** Texto completo para o title (quem, tipo/motivo). */
  texto: string;
  /** Pedido por aprovar: leva um ponto âmbar (e «pendente» para leitores de ecrã). */
  pendente?: boolean;
  /** Id do pedido (Ausencia): o nome passa a ser um botão que abre o pedido em /gestor/ausencias. */
  pedidoId?: string;
}

/**
 * Linha curta «Ausentes: Rita, Marta +3» (folgas, férias, baixas). Os pedidos por aprovar vão primeiro
 * e levam um ponto âmbar. A lista completa e o motivo ficam no title.
 */
export function AusentesLinha({ itens, max, className }: { itens: AusenteDia[]; max?: number; className?: string }) {
  const router = useRouter();
  if (itens.length === 0) return null;
  const ordenados = [...itens].sort((a, b) => Number(!!b.pendente) - Number(!!a.pendente));
  const visiveis = max ? ordenados.slice(0, max) : ordenados;
  const resto = ordenados.length - visiveis.length;
  return (
    <span className={cn("ausentes-linha", className)} title={ordenados.map((x) => `${x.texto}${x.pendente ? " (pendente de aprovação)" : ""}`).join(" · ")}>
      <span className="ausentes-linha__rotulo">Ausentes:</span>{" "}
      {visiveis.map((x, i) => (
        <span key={`${x.nome}-${i}`}>
          {i > 0 && ", "}
          {x.pendente && x.pedidoId ? (
            <button
              type="button"
              className="ausentes-linha__ligacao"
              title={`${x.texto}: pedido por aprovar. Abre o pedido em Ausências / Férias.`}
              aria-label={`${x.nome}, ausência por aprovar. Abrir o pedido`}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                router.push(`/gestor/ausencias?pedido=${encodeURIComponent(x.pedidoId as string)}`);
              }}
            >
              {x.nome}
            </button>
          ) : (
            x.nome
          )}
          {x.pendente && (
            <>
              <span className="ausentes-linha__pendente" aria-hidden="true" />
              {!x.pedidoId && <span className="sr-only"> (pendente)</span>}
            </>
          )}
        </span>
      ))}
      {resto > 0 ? ` +${resto}` : ""}
    </span>
  );
}
