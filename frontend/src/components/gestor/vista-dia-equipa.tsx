"use client";

/**
 * Vista Dia do calendário do gestor: horas na vertical e uma coluna por pessoa
 * que trabalha nesse dia (decisão 2026-11-13). As limpezas sem ninguém ficam
 * numa coluna própria à esquerda. Uma limpeza de equipa aparece na coluna de
 * cada membro.
 *
 * O fundo e a borda do cartão dizem o estado (tokens --status-*); a faixa
 * à esquerda e o círculo com a inicial dizem a pessoa (lib/cores-equipa).
 * Folgas e ausências não ocupam colunas: vão numa linha curta por cima.
 */

import { useMemo, useRef, type ReactNode } from "react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { AlertTriangle, ChevronLeft, ChevronRight, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { infoEstadoTarefa } from "@/lib/estados";
import { extrairHoraISO, plural, temHoraReal } from "@/lib/utils";
import { rotuloTipoLimpeza } from "@/components/tipo-limpeza-badge";
import { AusentesLinha, AvatarPessoa, AvisosLimpeza, EtiquetaEstado, GrupoAvatares, MotivoSaida, COR_SEM_MAPA, textoAvisos, tokenDoCartao } from "@/components/gestor/pessoa-estado";
import { LinhaLimpeza } from "@/components/gestor/semana-lista";
import { saidaPorConfirmar } from "@/lib/saida-desconhecida";
import type { UtilizadorDTO } from "@/lib/api";

export interface TarefaDia {
  _id: string;
  propriedade_id: { _id: string; nome: string } | null;
  utilizador_id: { _id: string; nome: string } | null;
  equipa_atribuida?: { _id?: string; nome: string }[] | null;
  data: string;
  tempo_limpeza_minutos: number;
  tempo_viagem_minutos?: number | null;
  tipo: string;
  tipo_limpeza?: string | null;
  estado: string;
  pessoas_em_falta?: number | null;
  oferta_estado?: string | null;
  oferta_expira_em?: string | null;
  alerta_orfao?: boolean;
  alerta_mensagem?: string;
  // Reserva do Smoobu sem data de saída: limpeza provisória no dia de chegada, com o motivo.
  data_saida_desconhecida?: boolean;
  motivo_nao_atribuicao?: string | null;
  title?: string;
  start?: string;
  end?: string;
}

const AUSENCIAS = ["ausencia", "ausencia_pendente", "folga_fixa"];

/** Duração em horas para o cabeçalho («4,5 h»). */
function horasTexto(min: number): string {
  return `${(Math.round((min / 60) * 100) / 100).toLocaleString("pt-PT")} h`;
}
const PX_POR_MIN = 1.4;

function minutosDe(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function primeiro(nome?: string | null): string {
  return (nome ?? "").split(" ")[0] || (nome ?? "");
}
/** Membros da limpeza (responsável primeiro, sem repetidos). */
function membros(t: TarefaDia): { _id: string; nome: string }[] {
  const out: { _id: string; nome: string }[] = [];
  for (const m of [t.utilizador_id, ...(t.equipa_atribuida ?? [])]) {
    if (!m?._id || out.some((x) => x._id === m._id)) continue;
    out.push({ _id: m._id, nome: m.nome });
  }
  return out;
}
/** Diz se a ausência (end exclusivo) ou folga cobre o dia. */
function cobreDia(t: TarefaDia, dia: string): boolean {
  if (t.tipo === "folga_fixa") return String(t.data).slice(0, 10) === dia;
  const ini = String(t.start ?? t.data).slice(0, 10);
  const fim = t.end ? String(t.end).slice(0, 10) : null;
  return dia >= ini && (fim ? dia < fim : dia === ini);
}

interface Bloco {
  t: TarefaDia;
  ini: number;
  fim: number;
  viagem: number;
  faixa: number;
  faixas: number;
}

/** Põe lado a lado as limpezas que se sobrepõem na mesma coluna (não devia acontecer, mas acontece). */
function dispor(itens: { t: TarefaDia; ini: number; fim: number; viagem: number }[]): Bloco[] {
  const ord = [...itens].sort((a, b) => a.ini - b.ini || a.fim - b.fim);
  const out: Bloco[] = [];
  let grupo: Bloco[] = [];
  let fimGrupo = -1;
  const fechar = () => {
    const n = Math.max(1, ...grupo.map((b) => b.faixa + 1));
    grupo.forEach((b) => (b.faixas = n));
    out.push(...grupo);
    grupo = [];
  };
  for (const it of ord) {
    if (grupo.length && it.ini >= fimGrupo) fechar();
    const usadas = new Set(grupo.filter((b) => b.fim > it.ini).map((b) => b.faixa));
    let faixa = 0;
    while (usadas.has(faixa)) faixa++;
    grupo.push({ ...it, faixa, faixas: 1 });
    fimGrupo = Math.max(fimGrupo, it.fim);
  }
  if (grupo.length) fechar();
  return out;
}

export function VistaDiaEquipa({
  dia,
  tarefas,
  equipa,
  cores,
  loading,
  onMudarDia,
  onHoje,
  onAbrir,
  estreito,
  renderExtra,
}: {
  dia: string;
  tarefas: TarefaDia[];
  equipa: UtilizadorDTO[];
  cores: Map<string, string>;
  loading: boolean;
  onMudarDia: (delta: number) => void;
  onHoje: () => void;
  onAbrir: (t: TarefaDia) => void;
  /** Telemóvel: em vez de colunas, uma lista por hora (uma linha por limpeza). */
  estreito?: boolean;
  /** Extras por limpeza (etiqueta de manutenção, vaga oferecida). */
  renderExtra?: (t: TarefaDia) => ReactNode;
}) {
  const dados = useMemo(() => {
    const ausentes: { id?: string; nome: string; texto: string; pendente: boolean; pedidoId?: string }[] = [];
    const doDia: { t: TarefaDia; ini: number; fim: number; viagem: number }[] = [];
    const semHora: TarefaDia[] = [];
    for (const t of tarefas) {
      if (t.tipo === "viagem") continue;
      if (AUSENCIAS.includes(t.tipo)) {
        if (!cobreDia(t, dia)) continue;
        const id = t.utilizador_id?._id;
        const ja = id ? ausentes.find((a) => a.id === id) : undefined;
        if (ja) {
          // Pedido por aprovar do mesmo dia: passa a mandar (é o que o gestor tem de decidir).
          if (t.tipo === "ausencia_pendente" && !ja.pendente) {
            ja.pendente = true;
            ja.pedidoId = String(t._id).replace(/^ausencia_pendente_/, "");
          }
          continue;
        }
        ausentes.push({ id, nome: primeiro(t.utilizador_id?.nome) || "?", texto: t.title ?? `Folga - ${t.utilizador_id?.nome ?? ""}`, pendente: t.tipo === "ausencia_pendente", pedidoId: t.tipo === "ausencia_pendente" ? String(t._id).replace(/^ausencia_pendente_/, "") : undefined });
        continue;
      }
      if (String(t.data).slice(0, 10) !== dia) continue;
      if (!temHoraReal(t.data)) {
        semHora.push(t);
        continue;
      }
      const ini = minutosDe(extrairHoraISO(t.data));
      if (ini === null) {
        semHora.push(t);
        continue;
      }
      const dur = Math.max(15, Number(t.tempo_limpeza_minutos) || 45);
      doDia.push({ t, ini, fim: ini + dur, viagem: Math.max(0, Number(t.tempo_viagem_minutos) || 0) });
    }

    // Colunas: «Por atribuir» (se houver), depois cada pessoa com limpezas, por ordem da primeira limpeza.
    const porPessoa = new Map<string, { nome: string; itens: typeof doDia }>();
    const porAtribuir: typeof doDia = [];
    for (const it of doDia) {
      const ms = membros(it.t);
      if (ms.length === 0) {
        porAtribuir.push(it);
        continue;
      }
      for (const m of ms) {
        const c = porPessoa.get(m._id) ?? { nome: m.nome, itens: [] };
        c.itens.push(it);
        porPessoa.set(m._id, c);
      }
    }
    const pessoas = [...porPessoa.entries()]
      .map(([id, c]) => ({ id, nome: c.nome, itens: c.itens, primeira: Math.min(...c.itens.map((x) => x.ini)) }))
      .sort((a, b) => a.primeira - b.primeira || a.nome.localeCompare(b.nome));

    const idsAusentes = new Set(ausentes.map((a) => a.id).filter(Boolean));
    const livres = equipa
      .filter((u) => !porPessoa.has(u._id) && !idsAusentes.has(u._id))
      .map((u) => primeiro(u.nome));

    const todos = doDia.flatMap((x) => [x.ini - x.viagem, x.fim]);
    const inicio = Math.min(8 * 60, ...(todos.length ? [Math.floor(Math.min(...todos) / 60) * 60] : []));
    const fim = Math.max(19 * 60, ...(todos.length ? [Math.ceil(Math.max(...todos) / 60) * 60] : []));
    const lista = [...doDia].sort((a, b) => a.ini - b.ini || a.fim - b.fim).map((x) => x.t);
    return { ausentes, pessoas, porAtribuir, semHora, livres, inicio, fim, lista, total: doDia.length + semHora.length };
  }, [tarefas, equipa, dia]);

  const d = new Date(`${dia}T12:00:00`);
  const titulo = format(d, "EEEE, d 'de' MMMM", { locale: pt });
  const hoje = format(new Date(), "yyyy-MM-dd") === dia;
  const altura = (dados.fim - dados.inicio) * PX_POR_MIN;
  const horas: number[] = [];
  for (let h = dados.inicio; h < dados.fim; h += 60) horas.push(h);

  const colunas = [
    ...(dados.porAtribuir.length ? [{ id: "__por_atribuir", nome: "Por atribuir", itens: dados.porAtribuir, cor: null as string | null }] : []),
    ...dados.pessoas.map((p) => ({ id: p.id, nome: p.nome, itens: p.itens, cor: cores.get(p.id) ?? COR_SEM_MAPA })),
  ];

  const agora = new Date();
  const minAgora = agora.getHours() * 60 + agora.getMinutes();

  // O cabeçalho das colunas fica fora da área que rola na horizontal e acompanha-a (a página rola na vertical).
  const cabRef = useRef<HTMLDivElement | null>(null);
  const modelo = `3.25rem repeat(${colunas.length}, minmax(9.5rem, 1fr))`;

  const cartao = (b: Bloco, colId: string) => {
    const { t } = b;
    const info = infoEstadoTarefa(t.estado);
    const tok = tokenDoCartao(t);
    const semPessoa = colId === "__por_atribuir";
    const corPessoa = semPessoa ? null : cores.get(colId) ?? COR_SEM_MAPA;
    const especial = t.tipo === "limpeza" && t.tipo_limpeza && t.tipo_limpeza !== "normal" ? rotuloTipoLimpeza(t.tipo_limpeza) : null;
    const casa = t.propriedade_id?.nome ?? "—";
    const todos = membros(t);
    const colegas = todos.filter((m) => m._id !== colId).map((m) => primeiro(m.nome));
    const top = (b.ini - dados.inicio) * PX_POR_MIN;
    // Uma limpeza provisória precisa de espaço para «Data de saída por confirmar» e o motivo.
    const h = Math.max(saidaPorConfirmar(t) ? 96 : 22, (b.fim - b.ini) * PX_POR_MIN - 2);
    const baixo = h < 70;
    // Cartões lado a lado (sobreposição): só cabe o círculo, o ícone do estado e a casa; o resto vai no title.
    const estreitoCard = b.faixas > 1;
    const largura = 100 / b.faixas;
    const manut = t.tipo === "manutencao";
    const avisos = textoAvisos(t);
    const rotulo = `${manut ? "Manutenção, " : ""}${hhmm(b.ini)} a ${hhmm(b.fim)}, ${especial ? `${especial} - ` : ""}${casa}, ${info.label}${colegas.length ? `, com ${colegas.join(" e ")}` : ""}${avisos ? `, ${avisos}` : ""}`;
    const extra = renderExtra?.(t);
    return (
      <div key={`${t._id}-${colId}`}>
        {b.viagem > 0 && (
          <div
            className="vista-dia__viagem"
            style={{ top: top - b.viagem * PX_POR_MIN, height: b.viagem * PX_POR_MIN, left: `${b.faixa * largura}%`, width: `${largura}%` }}
            title={`Viagem de ${b.viagem} min`}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={() => onAbrir(t)}
          aria-label={rotulo}
          title={rotulo}
          className={`vista-dia__cartao${semPessoa ? " vista-dia__cartao--sem-pessoa" : ""}${t.estado === "cancelada" ? " vista-dia__cartao--cancelada" : ""}`}
          style={{
            top,
            height: h,
            left: `calc(${b.faixa * largura}% + 2px)`,
            width: `calc(${largura}% - 4px)`,
            background: `hsl(var(--status-${tok}-bg))`,
            borderColor: `hsl(var(--status-${tok}))`,
            borderLeftColor: corPessoa ?? `hsl(var(--status-${tok}))`,
          }}
        >
          <span className="vista-dia__linha">
            <GrupoAvatares membros={todos} cores={cores} pequeno />
            {manut && <Wrench className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {!estreitoCard && <span className="vista-dia__hora">{hhmm(b.ini)}–{hhmm(b.fim)}</span>}
            {baixo && !estreitoCard && <EtiquetaEstado estado={t.estado} saida={t} className="ml-auto" />}
          </span>
          {estreitoCard && <EtiquetaEstado estado={t.estado} saida={t} soIcone className="shrink-0" />}
          <span className="vista-dia__casa">{especial ? `${especial} - ` : ""}{casa}</span>
          {!estreitoCard && (
            <span className="vista-dia__selos">
              {!baixo && <EtiquetaEstado estado={t.estado} saida={t} />}
              <AvisosLimpeza t={t} />
              {!baixo && extra}
            </span>
          )}
          {!estreitoCard && !baixo && <MotivoSaida t={t} />}
          {estreitoCard && avisos && <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: "hsl(var(--status-naoat))" }} aria-hidden="true" />}
        </button>
      </div>
    );
  };

  return (
    <section aria-label={`Limpezas de ${titulo}`} className="rounded-lg border bg-card p-2 sm:p-4" data-testid="vista-dia">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Dia anterior" onClick={() => onMudarDia(-1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Dia seguinte" onClick={() => onMudarDia(1)}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={onHoje} disabled={hoje} aria-disabled={hoje}>Hoje</Button>
        <h2 className="ml-1 text-lg font-semibold first-letter:uppercase" aria-live="polite">{titulo}</h2>
        <span className="text-sm text-muted-foreground">
          {loading ? "A carregar…" : dados.total === 0 ? "Sem limpezas" : plural(dados.total, "limpeza")}
        </span>
      </div>

      {(dados.ausentes.length > 0 || dados.livres.length > 0) && (
        <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <AusentesLinha itens={dados.ausentes} />
          {dados.livres.length > 0 && (
            <span>
              <span className="font-semibold text-foreground">Sem limpezas:</span> {dados.livres.join(", ")}
            </span>
          )}
        </p>
      )}

      {dados.semHora.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">Sem hora:</span>
          {dados.semHora.map((t) => (
            <button key={t._id} type="button" onClick={() => onAbrir(t)} className="rounded border px-2 py-1 hover:bg-muted">
              {t.propriedade_id?.nome ?? "—"} · {membros(t).map((m) => primeiro(m.nome)).join(" + ") || "por atribuir"}
            </button>
          ))}
        </div>
      )}

      {colunas.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {loading ? "A carregar…" : "Sem limpezas com hora neste dia."}
        </p>
      ) : estreito ? (
        /* Telemóvel: uma linha por limpeza, por hora (a grelha em colunas não cabe). */
        <div className="semana-lista" data-testid="vista-dia-lista">
          <div className="semana-lista__dia">
            {dados.lista.map((t) => (
              <LinhaLimpeza key={t._id} t={t} cores={cores} onAbrir={onAbrir} renderExtra={renderExtra} />
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div ref={cabRef} className="vista-dia__cabs">
            <div className="vista-dia__grelha" style={{ gridTemplateColumns: modelo }}>
              <div className="vista-dia__cab vista-dia__cab--canto" />
              {colunas.map((c) => (
                <div key={c.id} className={`vista-dia__cab${c.cor ? "" : " vista-dia__cab--pa"}`} title={c.nome}>
                  <AvatarPessoa nome={c.nome} cor={c.cor} />
                  <span className="min-w-0">
                    <span className="block truncate">{c.cor ? primeiro(c.nome) : c.nome}</span>
                    <span className="block truncate text-[0.6875rem] font-normal text-muted-foreground">
                      {plural(c.itens.length, "limpeza")} · {horasTexto(c.itens.reduce((s2, x) => s2 + (x.fim - x.ini), 0))}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="vista-dia__scroll" onScroll={(e) => { if (cabRef.current) cabRef.current.scrollLeft = e.currentTarget.scrollLeft; }}>
            <div className="vista-dia__grelha" style={{ gridTemplateColumns: modelo }}>
              <div className="vista-dia__horas" style={{ height: altura }}>
                {horas.map((h) => (
                  <span key={h} style={{ top: (h - dados.inicio) * PX_POR_MIN }}>{hhmm(h)}</span>
                ))}
              </div>
              {colunas.map((c) => (
                <div
                  key={c.id}
                  className={`vista-dia__coluna${c.cor ? "" : " vista-dia__coluna--pa"}`}
                  style={{ height: altura, backgroundSize: `100% ${60 * PX_POR_MIN}px` }}
                  role="group"
                  aria-label={`${c.nome}: ${plural(c.itens.length, "limpeza")}`}
                >
                  {hoje && minAgora >= dados.inicio && minAgora <= dados.fim && (
                    <div className="vista-dia__agora" style={{ top: (minAgora - dados.inicio) * PX_POR_MIN }} aria-hidden="true" />
                  )}
                  {dispor(c.itens).map((b) => cartao(b, c.id))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
