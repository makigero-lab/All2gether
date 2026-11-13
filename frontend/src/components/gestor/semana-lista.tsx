"use client";

/**
 * Vista Semana do calendário do gestor: lista vertical a toda a largura, agrupada por dia.
 * Cada limpeza é uma linha: faixa com a cor da pessoa, hora, casa, pessoa(s) e etiqueta de estado.
 * Fundo e borda dizem o estado; «Por atribuir» fica tracejado. Folgas e ausências não são linhas:
 * vão numa linha curta «Ausentes: A, B +N» no cabeçalho do dia.
 */

import type { ReactNode } from "react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { infoEstadoTarefa } from "@/lib/estados";
import { cn, extrairHoraISO, plural, temHoraReal } from "@/lib/utils";
import { rotuloTipoLimpeza } from "@/components/tipo-limpeza-badge";
import { AusentesLinha, AvatarPessoa, AvisosLimpeza, EtiquetaEstado, GrupoAvatares, COR_SEM_MAPA, primeiroNome, textoAvisos, tokenDoCartao, type AusenteDia } from "@/components/gestor/pessoa-estado";
import type { TarefaDia } from "@/components/gestor/vista-dia-equipa";

export const TIPOS_FORA = ["ausencia", "ausencia_pendente", "folga_fixa", "viagem"];

/** Início–fim («09:00–11:00») a partir da hora guardada e da duração. */
export function intervalo(t: TarefaDia): string {
  if (!temHoraReal(t.data)) return "Sem hora";
  const ini = extrairHoraISO(t.data);
  const m = /^(\d{2}):(\d{2})$/.exec(ini);
  if (!m) return ini;
  const fimMin = (Number(m[1]) * 60 + Number(m[2]) + Math.max(15, Number(t.tempo_limpeza_minutos) || 45)) % (24 * 60);
  return `${ini}–${String(Math.floor(fimMin / 60)).padStart(2, "0")}:${String(fimMin % 60).padStart(2, "0")}`;
}

export function membrosDe(t: TarefaDia): { _id: string; nome: string }[] {
  const out: { _id: string; nome: string }[] = [];
  for (const m of [t.utilizador_id, ...(t.equipa_atribuida ?? [])]) {
    if (!m?._id || out.some((x) => x._id === m._id)) continue;
    out.push({ _id: m._id, nome: m.nome });
  }
  return out;
}

/** Uma limpeza em linha: faixa da cor da pessoa, hora, casa (+ avisos e extras), pessoa(s) e etiqueta de estado. */
export function LinhaLimpeza<T extends TarefaDia>({
  t,
  cores,
  onAbrir,
  renderExtra,
}: {
  t: T;
  cores: Map<string, string>;
  onAbrir: (t: T) => void;
  renderExtra?: (t: T) => ReactNode;
}) {
  const info = infoEstadoTarefa(t.estado);
  const tok = tokenDoCartao(t);
  const ms = membrosDe(t);
  const semPessoa = ms.length === 0;
  const cor = semPessoa ? null : cores.get(ms[0]._id) ?? COR_SEM_MAPA;
  const especial = t.tipo === "limpeza" && t.tipo_limpeza && t.tipo_limpeza !== "normal" ? rotuloTipoLimpeza(t.tipo_limpeza) : null;
  const casa = `${especial ? `${especial} - ` : ""}${t.propriedade_id?.nome ?? "—"}`;
  const quem = semPessoa ? "Sem pessoa" : ms.map((m) => primeiroNome(m.nome)).join(" e ");
  const hora = intervalo(t);
  const avisos = textoAvisos(t);
  return (
    <button
      type="button"
      onClick={() => onAbrir(t)}
      aria-label={`${t.tipo === "manutencao" ? "Manutenção, " : ""}${hora}, ${casa}, ${quem}, ${info.label}${avisos ? `, ${avisos}` : ""}`}
      title={casa}
      className={cn("semana-lista__lin", semPessoa && "semana-lista__lin--pa", t.estado === "cancelada" && "semana-lista__lin--cancelada")}
      style={{
        background: `hsl(var(--status-${tok}-bg))`,
        borderColor: `hsl(var(--status-${tok}))`,
        borderLeftColor: cor ?? `hsl(var(--status-${tok}))`,
      }}
    >
      <span className="semana-lista__hora">{hora}</span>
      <span className="semana-lista__casa">
        <span className="truncate">{casa}</span>
        <AvisosLimpeza t={t} />
        {renderExtra?.(t)}
      </span>
      <span className="semana-lista__pessoa">
        {semPessoa ? <AvatarPessoa pequeno /> : <GrupoAvatares membros={ms} cores={cores} pequeno />}
        <span className={cn("truncate", semPessoa && "font-bold")} style={semPessoa ? { color: "hsl(var(--status-porat))" } : undefined}>{quem}</span>
      </span>
      <EtiquetaEstado estado={t.estado} className="semana-lista__estado" />
    </button>
  );
}

/** Horas e limpezas por pessoa na semana (mais carregada primeiro). Uma limpeza de equipa conta a duração inteira a cada membro. */
function totaisPorPessoa<T extends TarefaDia>(dias: string[], porDia: Map<string, T[]>) {
  const m = new Map<string, { id: string; nome: string; min: number; n: number }>();
  let porAtribuir = 0;
  for (const dia of dias) {
    for (const t of porDia.get(dia) ?? []) {
      if (TIPOS_FORA.includes(t.tipo) || t.estado === "cancelada") continue;
      const ms = membrosDe(t);
      if (ms.length === 0) {
        porAtribuir++;
        continue;
      }
      for (const p of ms) {
        const c = m.get(p._id) ?? { id: p._id, nome: p.nome, min: 0, n: 0 };
        c.min += Math.max(0, Number(t.tempo_limpeza_minutos) || 0);
        c.n += 1;
        m.set(p._id, c);
      }
    }
  }
  const lista = [...m.values()].sort((a, b) => b.min - a.min || b.n - a.n || a.nome.localeCompare(b.nome, "pt"));
  return { lista, porAtribuir };
}

const horasTexto = (min: number) => `${(Math.round((min / 60) * 10) / 10).toLocaleString("pt-PT")} h`;

export function SemanaLista<T extends TarefaDia>({
  dias,
  porDia,
  ausentesPorDia,
  cores,
  titulo,
  loading,
  onAnterior,
  onSeguinte,
  onHoje,
  onAbrir,
  renderExtra,
}: {
  dias: string[];
  porDia: Map<string, T[]>;
  ausentesPorDia: Map<string, AusenteDia[]>;
  cores: Map<string, string>;
  titulo: string;
  loading: boolean;
  onAnterior: () => void;
  onSeguinte: () => void;
  onHoje: () => void;
  onAbrir: (t: T) => void;
  /** Conteúdo extra por linha (ex.: vaga oferecida à equipa, manutenção). */
  renderExtra?: (t: T) => ReactNode;
}) {
  const hoje = format(new Date(), "yyyy-MM-dd");
  const totais = totaisPorPessoa(dias, porDia);
  return (
    <section aria-label="Limpezas da semana" className="min-w-0 rounded-lg border bg-card p-2 sm:p-4" data-testid="semana-lista">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Semana anterior" onClick={onAnterior}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Semana seguinte" onClick={onSeguinte}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={onHoje}>Hoje</Button>
        <h2 className="ml-1 min-w-0 flex-1 truncate text-lg font-semibold" aria-live="polite">{titulo}</h2>
        {loading && <span className="text-sm text-muted-foreground">A carregar…</span>}
      </div>

      {(totais.lista.length > 0 || totais.porAtribuir > 0) && (
        <ul className="semana-totais" aria-label="Horas e limpezas por pessoa nesta semana">
          {totais.lista.map((p) => (
            <li key={p.id} className="semana-totais__item" title={`${p.nome}: ${horasTexto(p.min)} em ${plural(p.n, "limpeza")} nesta semana`}>
              <AvatarPessoa nome={p.nome} cor={cores.get(p.id) ?? COR_SEM_MAPA} pequeno />
              <span className="font-semibold">{primeiroNome(p.nome)}</span>
              <span>{horasTexto(p.min)} · {p.n}</span>
            </li>
          ))}
          {totais.porAtribuir > 0 && (
            <li className="semana-totais__item" title={`${plural(totais.porAtribuir, "limpeza")} por atribuir nesta semana`}>
              <AvatarPessoa pequeno />
              <span className="font-semibold">Por atribuir</span>
              <span>{totais.porAtribuir}</span>
            </li>
          )}
        </ul>
      )}

      <div className="semana-lista">
        {dias.map((dia) => {
          const itens = (porDia.get(dia) ?? []).filter((t) => !TIPOS_FORA.includes(t.tipo));
          const ausentes = ausentesPorDia.get(dia) ?? [];
          const d = new Date(`${dia}T12:00:00`);
          const rotuloDia = format(d, "EEE d MMM", { locale: pt }).replace(".", "");
          return (
            <div key={dia} className="semana-lista__dia">
              <div className="semana-lista__cab">
                <h3 className="first-letter:uppercase">{rotuloDia}</h3>
                {dia === hoje && <span className="semana-lista__hoje">Hoje</span>}
                <span className="semana-lista__n">{itens.length === 0 ? "Sem limpezas" : plural(itens.length, "limpeza")}</span>
                <AusentesLinha itens={ausentes} max={3} className="semana-lista__ausentes" />
              </div>
              {itens.map((t) => (
                <LinhaLimpeza key={t._id} t={t} cores={cores} onAbrir={onAbrir} renderExtra={renderExtra} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
