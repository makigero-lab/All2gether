"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Table2,
  Download,
  Trash2,
  Plus,
  Save,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { TipoLimpezaBadge } from "@/components/tipo-limpeza-badge";
import {
  ORDEM_OMISSAO,
  alternarOrdem,
  aplicarOrdemCongelada,
  guardarOrdem,
  lerOrdem,
  ordenarPor,
  type Ordem,
  type TipoOrdem,
} from "@/lib/ordenacao-reservas";
import { EstadoTarefaBadge } from "@/components/ui/estado-tarefa-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  adminGet,
  adminPost,
  adminPut,
  adminDelete,
  type PropriedadeDTO,
} from "@/lib/api";
import { lerUtilizador } from "@/lib/auth";
import { eErroDeRede, mensagemErro } from "@/lib/rascunho-staff";
import {
  CAMPOS,
  aplicarCampo,
  chaveRascunho,
  anularEliminar,
  contarPendentes,
  marcarEliminar,
  reconciliarEliminacoes,
  textoPendentes,
  guardarRascunhoReservas,
  lerRascunhoReservas,
  paraPayload,
  TIPOS_LIMPEZA,
  ROTULO_TIPO,
  tipoPedeData,
  tipoOuNormal,
  limitesDataLimpeza,
  reconciliar,
  validarReserva,
  valoresEfetivos,
  type Campo,
  type NovaReserva,
  type Rascunho,
  type Valores,
} from "@/lib/rascunho-reservas";

interface ReservaDTO {
  _id: string;
  propriedade_id: { nome: string; morada?: string } | null;
  check_in: string;
  check_out: string;
  hospedes: number | null;
  observacoes?: string;
  nome_hospede?: string | null;
  plataforma?: string | null;
  hora_checkin?: string | null;
  horario_preferido?: string | null;
  /** Tipo de limpeza; sem o campo (reservas antigas) = normal. */
  tipo_limpeza?: string | null;
  /** Dia da limpeza escolhido (só intermédia/preparação). */
  data_limpeza?: string | null;
  tarefa_gerada_id: { estado: string; data: string } | null;
  createdAt: string;
}

const PLATAFORMAS = ["Booking", "Airbnb", "Direto", "Vrbo", "Outra"];

/** Opções do tipo de limpeza (o tipo não muda preços). */
const OPCOES_TIPO = TIPOS_LIMPEZA.map((t) => ({ valor: t, rotulo: ROTULO_TIPO[t] }));

/** Célula do desktop (tabela, estilo folha de cálculo). */
const CELULA =
  "h-9 w-full bg-transparent px-2 text-sm outline-none focus:bg-primary/5 focus:ring-2 focus:ring-inset focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

/** Campo do cartão (telemóvel): alvo de toque >= 44 px, 16 px (o iOS não faz zoom). */
const CELULA_CARTAO =
  "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base outline-none focus:border-gold-text focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

/** Marca visual de "por gravar" (não depende só da cor: leva também um traço e o aviso da linha). */
const PENDENTE_TABELA = "bg-amber-100 dark:bg-amber-900/40 shadow-[inset_3px_0_0_0_rgb(217_119_6)]";
const PENDENTE_CARTAO = "border-amber-600 bg-amber-50 dark:bg-amber-950/30";

/** Para o parceiro, "Não atribuída" (detalhe interno) é igual a "Por atribuir". */
const estadoParaParceiro = (e: string) => (e === "nao_atribuida" ? "por_atribuir" : e);

const dia = (iso: string) => iso.slice(0, 10);

function somarDias(isoDia: string, n: number): string {
  const d = new Date(`${isoDia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function noites(ci: string, co: string): number {
  if (!ci || !co) return 0;
  const ms = new Date(`${co}T00:00:00Z`).getTime() - new Date(`${ci}T00:00:00Z`).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Cores por tipo de limpeza (faixa lateral + fundo discreto). Normal quase sem cor. Os estados da
 * linha (erro, a eliminar, por gravar, concluída, cancelada) têm prioridade sobre a cor do tipo.
 * A cor nunca é o único sinal: o tipo está escrito na coluna/campo e nas etiquetas.
 */
const COR_TIPO: Record<string, { tr: string; faixa: string; cartao: string; amostra: string }> = {
  normal: { tr: "", faixa: "border-l-4 border-l-transparent", cartao: "", amostra: "border border-muted-foreground/60 bg-background" },
  intermedia: {
    tr: "bg-sky-50/70 dark:bg-sky-950/25",
    faixa: "border-l-4 border-l-sky-500",
    cartao: "border-l-4 border-l-sky-500 bg-sky-50/60 dark:bg-sky-950/20",
    amostra: "bg-sky-500",
  },
  profunda: {
    tr: "bg-violet-50/70 dark:bg-violet-950/25",
    faixa: "border-l-4 border-l-violet-500",
    cartao: "border-l-4 border-l-violet-500 bg-violet-50/60 dark:bg-violet-950/20",
    amostra: "bg-violet-500",
  },
  preparacao: {
    tr: "bg-teal-50/70 dark:bg-teal-950/25",
    faixa: "border-l-4 border-l-teal-500",
    cartao: "border-l-4 border-l-teal-500 bg-teal-50/60 dark:bg-teal-950/20",
    amostra: "bg-teal-500",
  },
};

/** Cor da linha: estado primeiro (erro > a eliminar > por gravar/alterada > concluída/cancelada), depois o tipo. */
function corDaLinha(l: Linha): { tr: string; faixa: string; cartao: string } {
  if (l.erro || (l.conflito && l.conflito.length > 0)) {
    return { tr: "bg-destructive/10", faixa: "border-l-4 border-l-destructive", cartao: "border-l-4 border-l-destructive bg-destructive/5" };
  }
  if (l.eliminada) {
    return { tr: "bg-destructive/5 opacity-70", faixa: "border-l-4 border-l-destructive", cartao: "border-l-4 border-l-destructive opacity-70" };
  }
  if (l.nova || l.pendentes.size > 0) {
    return { tr: "bg-amber-50/70 dark:bg-amber-950/25", faixa: "border-l-4 border-l-amber-600", cartao: "border-l-4 border-l-amber-600 bg-amber-50 dark:bg-amber-950/30" };
  }
  if (l.estado === "concluida") {
    return { tr: "bg-emerald-50/60 dark:bg-emerald-950/20", faixa: "border-l-4 border-l-emerald-600", cartao: "border-l-4 border-l-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/20" };
  }
  if (l.estado === "cancelada") {
    return { tr: "bg-muted/40 text-muted-foreground", faixa: "border-l-4 border-l-muted-foreground/50", cartao: "border-l-4 border-l-muted-foreground/50 bg-muted/40" };
  }
  const t = COR_TIPO[tipoOuNormal(l.valores.tipo_limpeza)];
  return { tr: t.tr, faixa: t.faixa, cartao: t.cartao };
}

/** Legenda curta das cores (cada cor leva sempre o nome ao lado). */
function LegendaCores() {
  const item = (amostra: string, texto: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block h-3 w-3 rounded-sm ${amostra}`} />
      {texto}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legenda das cores">
      <span className="font-medium">Tipo de limpeza:</span>
      {item(COR_TIPO.normal.amostra, "Normal")}
      {item(COR_TIPO.intermedia.amostra, "Intermédia")}
      {item(COR_TIPO.profunda.amostra, "Profunda")}
      {item(COR_TIPO.preparacao.amostra, "Preparação")}
      <span className="font-medium">Estado (tem prioridade):</span>
      {item("bg-amber-600", "Por gravar")}
      {item("bg-destructive", "Erro / a eliminar")}
      {item("bg-emerald-600", "Concluída")}
      {item("bg-muted-foreground/50", "Cancelada")}
    </div>
  );
}

interface ColunaOrdem {
  chave: string;
  rotulo: string;
  tipo: TipoOrdem;
  valor: (l: Linha) => string | number | null | undefined;
}

const dataDaLimpeza = (l: Linha) => (tipoPedeData(l.valores.tipo_limpeza) ? l.valores.data_limpeza : l.valores.check_out);

/** Colunas ordenáveis (desktop: cabeçalho; telemóvel: seletor). */
const COLUNAS_ORDEM: ColunaOrdem[] = [
  { chave: "propriedade", rotulo: "Propriedade", tipo: "texto", valor: (l) => l.propNome },
  { chave: "check_in", rotulo: "Check-in", tipo: "data", valor: (l) => l.valores.check_in },
  { chave: "hora_checkin", rotulo: "Hora de check-in", tipo: "texto", valor: (l) => l.valores.hora_checkin },
  { chave: "check_out", rotulo: "Check-out", tipo: "data", valor: (l) => l.valores.check_out },
  { chave: "noites", rotulo: "Noites", tipo: "numero", valor: (l) => noites(l.valores.check_in, l.valores.check_out) },
  { chave: "hospedes", rotulo: "Hóspedes", tipo: "numero", valor: (l) => l.valores.hospedes },
  { chave: "nome_hospede", rotulo: "Hóspede", tipo: "texto", valor: (l) => l.valores.nome_hospede },
  { chave: "plataforma", rotulo: "Plataforma", tipo: "texto", valor: (l) => l.valores.plataforma },
  { chave: "tipo_limpeza", rotulo: "Tipo de limpeza", tipo: "texto", valor: (l) => ROTULO_TIPO[tipoOuNormal(l.valores.tipo_limpeza)] },
  { chave: "data_limpeza", rotulo: "Data da limpeza", tipo: "data", valor: dataDaLimpeza },
  { chave: "horario_preferido", rotulo: "Horário preferido", tipo: "texto", valor: (l) => l.valores.horario_preferido },
  { chave: "observacoes", rotulo: "Notas", tipo: "texto", valor: (l) => l.valores.observacoes },
  { chave: "estado", rotulo: "Estado da limpeza", tipo: "texto", valor: (l) => (l.estado ? estadoParaParceiro(l.estado) : "") },
];
const CHAVES_ORDEM = COLUNAS_ORDEM.map((c) => c.chave);

/** Cabeçalho de coluna ordenável (botão, indicador visível e aria-sort). */
function Cab({
  chave, rotulo, ordem, onOrdenar, className = "", direita,
}: {
  chave: string;
  rotulo: string;
  ordem: Ordem;
  onOrdenar: (chave: string) => void;
  className?: string;
  direita?: boolean;
}) {
  const ativo = ordem.chave === chave;
  const Icone = !ativo ? ArrowUpDown : ordem.direcao === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={ativo ? (ordem.direcao === "asc" ? "ascending" : "descending") : "none"}
      className={`px-2 py-2 font-medium ${direita ? "text-right" : ""} ${className}`}
    >
      <button
        type="button"
        onClick={() => onOrdenar(chave)}
        className={`inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${ativo ? "text-foreground" : ""}`}
        title={`Ordenar por ${rotulo}`}
      >
        {rotulo}
        <Icone className={`h-3.5 w-3.5 ${ativo ? "" : "opacity-50"}`} aria-hidden="true" />
      </button>
    </th>
  );
}

/** Valores de uma reserva tal como estão gravados no servidor. */
function doServidor(r: ReservaDTO): Valores {
  return {
    check_in: dia(r.check_in),
    check_out: dia(r.check_out),
    hora_checkin: r.hora_checkin ?? "",
    hospedes: r.hospedes != null ? String(r.hospedes) : "",
    nome_hospede: r.nome_hospede ?? "",
    plataforma: r.plataforma ?? "",
    horario_preferido: r.horario_preferido ?? "",
    observacoes: r.observacoes ?? "",
    tipo_limpeza: tipoOuNormal(r.tipo_limpeza),
    data_limpeza: r.data_limpeza ? dia(r.data_limpeza) : "",
  };
}

const ROTULO_CAMPO: Record<Campo, string> = {
  check_in: "Check-in",
  check_out: "Check-out",
  hora_checkin: "Hora de check-in",
  hospedes: "Hóspedes",
  nome_hospede: "Nome do hóspede",
  plataforma: "Plataforma",
  horario_preferido: "Horário preferido",
  observacoes: "Notas",
  tipo_limpeza: "Tipo de limpeza",
  data_limpeza: "Data da limpeza",
};

/**
 * Célula editável estilo Excel: mostra sempre um input discreto. Sair da célula
 * (blur) ou Enter guarda SÓ no rascunho local; Esc repõe o valor anterior.
 * Nada vai para o servidor antes de carregar em "Gravar".
 */
function Celula({
  value,
  type = "text",
  options,
  opcoes,
  disabled,
  placeholder,
  align,
  min,
  max,
  rotulo,
  cartao,
  pendente,
  onCommit,
}: {
  value: string;
  type?: "text" | "date" | "number" | "select";
  options?: string[];
  /** Opções com rótulo diferente do valor (ex.: tipo de limpeza); sem opção vazia. */
  opcoes?: { valor: string; rotulo: string }[];
  disabled?: boolean;
  placeholder?: string;
  align?: "right";
  /** Limites de um campo de data (AAAA-MM-DD). */
  min?: string;
  max?: string;
  /** Nome acessível da célula (aria-label), ex.: "Check-in, Casa Azul". */
  rotulo: string;
  /** Aspeto de cartão (telemóvel): campo com contorno. */
  cartao?: boolean;
  /** Alteração por gravar: destaca a célula. */
  pendente?: boolean;
  onCommit: (novo: string) => void;
}) {
  const [v, setV] = useState(value);
  // Esc cancela: o blur seguinte (síncrono, com o `v` antigo) não pode guardar.
  const cancelar = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);

  useEffect(() => {
    setV(value);
  }, [value]);

  function guardar(novo: string) {
    if (novo === value) return;
    // Datas não podem ficar vazias: repõe o valor anterior.
    if (novo === "" && type === "date") {
      setV(value);
      return;
    }
    onCommit(novo);
  }

  const comum = {
    ref,
    disabled,
    "aria-label": pendente ? `${rotulo} (por gravar)` : rotulo,
    className: `${cartao ? CELULA_CARTAO : CELULA} ${align === "right" ? "text-right" : ""} ${
      pendente ? (cartao ? PENDENTE_CARTAO : PENDENTE_TABELA) : ""
    }`,
  };

  if (type === "select") {
    return (
      <select
        {...comum}
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          guardar(e.target.value);
        }}
      >
        {!opcoes && <option value="">—</option>}
        {(options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        {(opcoes ?? []).map((o) => (
          <option key={o.valor} value={o.valor}>{o.rotulo}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      {...comum}
      type={type}
      min={type === "number" ? 0 : min}
      max={max}
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (cancelar.current) {
          cancelar.current = false;
          return;
        }
        guardar(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") ref.current?.blur();
        if (e.key === "Escape") {
          cancelar.current = true;
          setV(value);
          ref.current?.blur();
        }
      }}
    />
  );
}

/** Campo de cartão com etiqueta visível (o controlo tem o seu próprio aria-label). */
function Campo({ texto, className, children }: { texto: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <span aria-hidden="true" className="mb-1 block text-xs font-medium text-muted-foreground">
        {texto}
      </span>
      {children}
    </div>
  );
}

const NOVA_VAZIA = {
  propriedade_id: "",
  check_in: "",
  check_out: "",
  hospedes: "",
  nome_hospede: "",
  plataforma: "",
  hora_checkin: "",
  horario_preferido: "",
  observacoes: "",
  tipo_limpeza: "normal",
  data_limpeza: "",
};

/** Linha (existente ou nova) pronta a desenhar, igual para a tabela e para os cartões. */
interface Linha {
  key: string;
  nova: boolean;
  propNome: string;
  valores: Valores;
  pendentes: Set<Campo>;
  estado: string | null;
  bloqueada: boolean;
  /** Marcada para eliminar (só se elimina ao Gravar). */
  eliminada?: boolean;
  /** Células desativadas: limpeza já começou, a eliminar ou a gravar. */
  semEdicao?: boolean;
  erro?: string;
  conflito?: Campo[];
  reserva?: ReservaDTO;
}

export default function ParceiroReservasPage() {
  const [reservas, setReservas] = useState<ReservaDTO[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Linha de entrada (topo / cartão "Nova reserva"): só vira reserva pendente com Enter ou "+".
  const [nova, setNova] = useState(NOVA_VAZIA);
  const [novaErro, setNovaErro] = useState<string | null>(null);

  // Rascunho local (edições + reservas novas) — só vai para o servidor em "Gravar".
  const [chave, setChave] = useState<string | null>(null);

  // Ordenação da tabela (preferência em localStorage). Enquanto se edita, a ordem fica congelada.
  const [ordem, setOrdem] = useState<Ordem>(ORDEM_OMISSAO);
  const [ordemCongelada, setOrdemCongelada] = useState<string[] | null>(null);
  const descongelar = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      setOrdem(lerOrdem(window.localStorage, CHAVES_ORDEM));
    } catch {
      // sem localStorage: usa a omissão
    }
  }, []);
  const ordenarPorColuna = (c: string) => {
    const nova = alternarOrdem(ordem, c);
    setOrdem(nova);
    try { guardarOrdem(window.localStorage, nova); } catch { /* ignora */ }
  };
  const mudarColunaOrdem = (c: string) => {
    const nova: Ordem = { chave: c, direcao: ordem.direcao };
    setOrdem(nova);
    try { guardarOrdem(window.localStorage, nova); } catch { /* ignora */ }
  };
  const inverterOrdem = () => {
    const nova: Ordem = { ...ordem, direcao: ordem.direcao === "asc" ? "desc" : "asc" };
    setOrdem(nova);
    try { guardarOrdem(window.localStorage, nova); } catch { /* ignora */ }
  };
  const [rascunho, setRascunho] = useState<Rascunho>({ edicoes: {}, novas: [], eliminar: {} });
  const [rascunhoPronto, setRascunhoPronto] = useState(false);
  const [conflitos, setConflitos] = useState<Record<string, Campo[]>>({});
  /** Reservas marcadas para eliminar que mudaram no sistema: a pessoa confirma ou anula. */
  const [elimAlteradas, setElimAlteradas] = useState<string[]>([]);
  const [errosLinha, setErrosLinha] = useState<Record<string, string>>({});
  const [gravando, setGravando] = useState(false);
  const [sessaoTerminou, setSessaoTerminou] = useState(false);
  const [resumo, setResumo] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const [descartarAberto, setDescartarAberto] = useState(false);
  const reconciliarNoProximo = useRef(true);
  const rascunhoRef = useRef(rascunho);
  rascunhoRef.current = rascunho;
  const contadorTmp = useRef(0);

  const [eliminar, setEliminar] = useState<ReservaDTO | null>(null);

  const pendentes = contarPendentes(rascunho);

  const carregar = useCallback(async (silencioso = false) => {
    if (!silencioso) setLoading(true);
    setErro(null);
    try {
      const [resReservas, resProps] = await Promise.all([
        adminGet<{ reservas: ReservaDTO[] }>("/api/parceiro/reservas"),
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/parceiro/propriedades"),
      ]);
      reconciliarNoProximo.current = true;
      setReservas(resReservas.reservas ?? []);
      const props = resProps.propriedades ?? [];
      setPropriedades(props);
      // Com uma só propriedade, a linha nova já vem preenchida.
      setNova((n) => (n.propriedade_id || props.length !== 1 ? n : { ...n, propriedade_id: props[0]._id }));
    } catch (e) {
      setErro(mensagemErro(e, "Erro ao carregar."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Rascunho por utilizador/empresa: lê no arranque.
  useEffect(() => {
    let vivo = true;
    lerUtilizador().then((u) => {
      if (!vivo) return;
      if (u) {
        const k = chaveRascunho(u.id, u.empresa_id);
        setChave(k);
        setRascunho(lerRascunhoReservas(k, window.localStorage));
      }
      setRascunhoPronto(true);
    });
    return () => {
      vivo = false;
    };
  }, []);

  // Telemóvel: com a barra «Gravar» fixa em baixo, o campo focado não pode ficar tapado.
  useEffect(() => {
    if (pendentes === 0) return;
    const el = document.documentElement;
    const antes = el.style.scrollPaddingBottom;
    el.style.scrollPaddingBottom = "6rem"; // altura da barra (≈68 px) + folga
    return () => {
      el.style.scrollPaddingBottom = antes;
    };
  }, [pendentes]);

  // Guarda o rascunho sempre que muda (nunca antes de o ter lido).
  useEffect(() => {
    if (!rascunhoPronto || !chave) return;
    guardarRascunhoReservas(chave, rascunho, window.localStorage);
  }, [rascunho, chave, rascunhoPronto]);

  // Depois de cada carregamento, compara o rascunho com o servidor (sem sobrescrever às cegas).
  useEffect(() => {
    if (!rascunhoPronto || !reconciliarNoProximo.current || loading) return;
    reconciliarNoProximo.current = false;
    const r = rascunhoRef.current;
    const porId: Record<string, Valores> = {};
    for (const rs of reservas) porId[rs._id] = doServidor(rs);
    const recE = reconciliarEliminacoes(r.eliminar, porId);
    setElimAlteradas(recE.alteradas);
    if (Object.keys(r.edicoes).length === 0) {
      setConflitos({});
      if (recE.jaEliminadas.length > 0) {
        setAviso(`${recE.jaEliminadas.length} reserva(s) marcadas para eliminar já tinham sido eliminadas no sistema.`);
        setRascunho((prev) => ({ ...prev, eliminar: recE.eliminar }));
      }
      return;
    }
    const rec = reconciliar(r.edicoes, porId);
    setConflitos(rec.conflitos);
    if (rec.desaparecidas.length > 0 || recE.jaEliminadas.length > 0) {
      setAviso(
        `${rec.desaparecidas.length + recE.jaEliminadas.length} reserva(s) com alterações por gravar já não existem no sistema: o rascunho dessas linhas foi descartado.`
      );
    }
    setRascunho((prev) => ({ ...prev, edicoes: rec.edicoes, eliminar: recE.eliminar }));
  }, [reservas, rascunhoPronto, loading]);

  // Aviso ao sair da página com alterações por gravar (diálogo do browser, sem alert()).
  useEffect(() => {
    if (pendentes === 0) return;
    const antes = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", antes);
    return () => window.removeEventListener("beforeunload", antes);
  }, [pendentes]);

  const servidorPorId = useMemo(() => {
    const m: Record<string, Valores> = {};
    for (const r of reservas) m[r._id] = doServidor(r);
    return m;
  }, [reservas]);

  /** Altera uma célula (só no rascunho local). `noites` converte-se em check-out. */
  function alterar(linha: Linha, campo: Campo | "noites", valor: string) {
    // Nada de edições durante o Gravar (perder-se-iam) nem em linhas a eliminar.
    if (gravando || linha.eliminada) return;
    setAviso(null);
    if (campo === "noites") {
      if (valor === "") return;
      campo = "check_out";
      valor = somarDias(linha.valores.check_in, Number(valor));
    }
    const c: Campo = campo;
    // Mexer na linha limpa o erro anterior dela.
    setErrosLinha((e) => {
      if (!(linha.key in e)) return e;
      const { [linha.key]: _x, ...resto } = e;
      return resto;
    });
    // Mudar o tipo acerta a data da limpeza: limpa-a em Normal/Profunda e, em Intermédia/Preparação
    // sem data, sugere o check-in.
    const extras: Array<[Campo, string]> = [];
    if (c === "tipo_limpeza") {
      if (!tipoPedeData(valor)) {
        if (linha.valores.data_limpeza !== "") extras.push(["data_limpeza", ""]);
      } else if (!linha.valores.data_limpeza && linha.valores.check_in) {
        extras.push(["data_limpeza", linha.valores.check_in]);
      }
    }
    if (linha.nova) {
      setRascunho((r) => ({
        ...r,
        novas: r.novas.map((n) => (n.tmp === linha.key ? { ...n, [c]: valor, ...Object.fromEntries(extras) } : n)),
      }));
      return;
    }
    const servidor = servidorPorId[linha.key];
    if (!servidor) return;
    setRascunho((r) => {
      let ed = aplicarCampo(r.edicoes, linha.key, c, valor, servidor);
      for (const [campoExtra, v] of extras) ed = aplicarCampo(ed, linha.key, campoExtra, v, servidor);
      return { ...r, edicoes: ed };
    });
  }

  /** Enter / "+": acrescenta a linha de entrada às reservas por gravar (não envia). */
  function acrescentarNova() {
    if (gravando) return;
    const v: Valores = {
      check_in: nova.check_in,
      check_out: nova.check_out,
      hora_checkin: nova.hora_checkin,
      hospedes: nova.hospedes,
      nome_hospede: nova.nome_hospede,
      plataforma: nova.plataforma,
      horario_preferido: nova.horario_preferido,
      observacoes: nova.observacoes,
      tipo_limpeza: nova.tipo_limpeza,
      data_limpeza: tipoPedeData(nova.tipo_limpeza) ? nova.data_limpeza : "",
    };
    const msg = validarReserva(v, nova.propriedade_id);
    if (msg) {
      setNovaErro(msg);
      return;
    }
    setNovaErro(null);
    setAviso(null);
    contadorTmp.current += 1;
    const item: NovaReserva = { ...v, propriedade_id: nova.propriedade_id, tmp: `nova-${Date.now()}-${contadorTmp.current}` };
    setRascunho((r) => ({ ...r, novas: [item, ...r.novas] }));
    setNova({ ...NOVA_VAZIA, propriedade_id: nova.propriedade_id });
  }

  /** Conflito: mantém a minha alteração (aceita o valor atual do sistema como ponto de partida). */
  function manterMinha(id: string) {
    const servidor = servidorPorId[id];
    const campos = conflitos[id] ?? [];
    if (!servidor) return;
    setRascunho((r) => {
      const e = r.edicoes[id];
      if (!e) return r;
      const antes = { ...e.antes };
      for (const c of campos) antes[c] = servidor[c];
      return { ...r, edicoes: { ...r.edicoes, [id]: { ...e, antes } } };
    });
    setConflitos(({ [id]: _x, ...resto }) => resto);
  }

  /** Conflito: usa o valor do sistema (descarta a minha alteração desses campos). */
  function usarSistema(id: string) {
    const campos = conflitos[id] ?? [];
    setRascunho((r) => {
      const e = r.edicoes[id];
      if (!e) return r;
      const novos = { ...e.campos };
      const antes = { ...e.antes };
      for (const c of campos) {
        delete novos[c];
        delete antes[c];
      }
      const edicoes = { ...r.edicoes };
      if (Object.keys(novos).length === 0) delete edicoes[id];
      else edicoes[id] = { campos: novos, antes };
      return { ...r, edicoes };
    });
    setConflitos(({ [id]: _x, ...resto }) => resto);
  }

  function removerNova(tmp: string) {
    setRascunho((r) => ({ ...r, novas: r.novas.filter((n) => n.tmp !== tmp) }));
    setErrosLinha(({ [tmp]: _x, ...resto }) => resto);
  }

  function descartarTudo() {
    setRascunho({ edicoes: {}, novas: [], eliminar: {} });
    setElimAlteradas([]);
    setConflitos({});
    setErrosLinha({});
    setDescartarAberto(false);
    setResumo("Alterações descartadas.");
  }

  /**
   * Envia tudo de uma vez, uma linha de cada vez (sequencial: o motor de
   * atribuição vê a carga das anteriores). As que falham ficam pendentes com o
   * erro na linha; as que passam deixam de estar pendentes. Sem rede, pára e
   * não perde nada.
   */
  async function gravar() {
    if (descongelar.current) clearTimeout(descongelar.current);
    setOrdemCongelada(null); // reordena ao gravar
    if (gravando || pendentes === 0) return;
    setGravando(true);
    setErro(null);
    setAviso(null);
    setErrosLinha({});
    setResumo("A gravar…");
    const erros: Record<string, string> = {};
    let edicoes = { ...rascunho.edicoes };
    let novas = [...rascunho.novas];
    const eliminar = { ...rascunho.eliminar };
    let gravadas = 0;
    let criadas = 0;
    let semRede = false;
    let semSessao = false;
    setSessaoTerminou(false);
    const conflitosRestantes = { ...conflitos };

    const sincronizar = () => setRascunho({ edicoes: { ...edicoes }, novas: [...novas], eliminar: { ...eliminar } });

    for (const [id, e] of Object.entries(rascunho.edicoes)) {
      if (semRede || semSessao) break;
      // Linha a eliminar: a edição pendente não é enviada.
      if (id in rascunho.eliminar) continue;
      const reserva = reservas.find((r) => r._id === id);
      if (!reserva) continue;
      // Campos em conflito com o sistema NÃO se enviam sem a pessoa decidir.
      const emConflito = new Set(conflitos[id] ?? []);
      const campos: Partial<Valores> = {};
      for (const c of CAMPOS) if (c in e.campos && !emConflito.has(c)) campos[c] = e.campos[c];
      if (Object.keys(campos).length === 0) {
        erros[id] = "Há valores que mudaram no sistema: escolhe «Manter a minha» ou «Usar a do sistema».";
        continue;
      }
      const msg = validarReserva(valoresEfetivos(doServidor(reserva), { campos, antes: e.antes }));
      if (msg) {
        erros[id] = msg;
        continue;
      }
      try {
        const res = await adminPut<{ reserva: ReservaDTO }>(`/api/parceiro/reservas/${id}`, paraPayload(campos));
        setReservas((rs) => rs.map((r) => (r._id === id ? res.reserva : r)));
        gravadas++;
        const resto: Partial<Valores> = {};
        const restoAntes: Partial<Valores> = {};
        for (const c of emConflito) {
          if (c in e.campos) {
            resto[c] = e.campos[c];
            restoAntes[c] = e.antes[c];
          }
        }
        if (Object.keys(resto).length > 0) {
          edicoes[id] = { campos: resto, antes: restoAntes };
          erros[id] = "Gravado, menos os valores que mudaram no sistema (decide em baixo).";
        } else {
          delete edicoes[id];
          delete conflitosRestantes[id];
        }
        sincronizar();
      } catch (err) {
        if ((err as { status?: number })?.status === 401) semSessao = true; // sessão terminada: pára e mantém o rascunho
        else if (eErroDeRede(err)) semRede = true; // uma só mensagem «Sem ligação» no ecrã
        else erros[id] = mensagemErro(err, "Erro ao gravar.");
      }
    }

    let eliminadas = 0;
    for (const id of Object.keys(rascunho.eliminar)) {
      if (semRede || semSessao) break;
      const reserva = reservas.find((r) => r._id === id);
      if (!reserva) {
        // Já não existe no sistema: a eliminação está feita.
        delete eliminar[id];
        sincronizar();
        continue;
      }
      if (elimAlteradas.includes(id)) {
        erros[id] = "Esta reserva mudou no sistema depois de a marcares. Confirma «Eliminar mesmo assim» ou «Anular».";
        continue;
      }
      try {
        await adminDelete(`/api/parceiro/reservas/${id}`);
        eliminadas++;
        delete eliminar[id];
        delete edicoes[id];
        setReservas((rs) => rs.filter((r) => r._id !== id));
        sincronizar();
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 404) {
          // Entretanto eliminada noutro sítio: o resultado pretendido já existe.
          delete eliminar[id];
          delete edicoes[id];
          setReservas((rs) => rs.filter((r) => r._id !== id));
          sincronizar();
        } else {
          if ((err as { status?: number })?.status === 401) semSessao = true; // sessão terminada: pára e mantém o rascunho
        else if (eErroDeRede(err)) semRede = true; // uma só mensagem «Sem ligação» no ecrã
          else erros[id] = mensagemErro(err, "Erro ao eliminar.");
        }
      }
    }

    for (const n of rascunho.novas) {
      if (semRede || semSessao) break;
      const msg = validarReserva(n, n.propriedade_id);
      if (msg) {
        erros[n.tmp] = msg;
        continue;
      }
      try {
        await adminPost("/api/parceiro/reservas", {
          propriedade_id: n.propriedade_id,
          // Chave de idempotência: se a resposta se perder, o Gravar seguinte não duplica.
          chave_idempotencia: n.tmp,
          ...paraPayload(n),
          hospedes: n.hospedes.trim() === "" ? undefined : Number(n.hospedes),
        });
        criadas++;
        novas = novas.filter((x) => x.tmp !== n.tmp);
        sincronizar();
      } catch (err) {
        if ((err as { status?: number })?.status === 401) semSessao = true; // sessão terminada: pára e mantém o rascunho
        else if (eErroDeRede(err)) semRede = true; // uma só mensagem «Sem ligação» no ecrã
        else erros[n.tmp] = mensagemErro(err, "Erro ao gravar.");
      }
    }

    setConflitos(conflitosRestantes);
    setErrosLinha(erros);
    const comErro = Object.keys(erros).length;
    const partes = [];
    if (gravadas) partes.push(`${gravadas} reserva(s) atualizada(s)`);
    if (criadas) partes.push(`${criadas} reserva(s) criada(s)`);
    if (eliminadas) partes.push(`${eliminadas} reserva(s) eliminada(s)`);
    const resultado = partes.length ? partes.join(", ") : "Nada foi gravado";
    setResumo(
      semRede || semSessao
        ? `${resultado}. O resto continua por gravar.`
        : comErro > 0
        ? `${resultado}. ${comErro} linha(s) com erro continuam por gravar.`
        : criadas > 0 || gravadas > 0
        ? `${resultado}. As limpezas foram criadas/reatribuídas.`
        : `${resultado}.`
    );
    if (semSessao) {
      setErro("A tua sessão terminou. Inicia sessão outra vez, as alterações ficam guardadas.");
      setSessaoTerminou(true);
    } else if (semRede) setErro("Sem ligação. As alterações continuam aqui, carrega em Gravar quando a rede voltar.");
    // Recarrega a lista (as reservas novas aparecem com a sua limpeza).
    if (criadas > 0 || gravadas > 0 || eliminadas > 0) await carregar(true);
    setGravando(false);
  }

  /** Confirmado no diálogo: só marca a linha "a eliminar"; o envio é ao Gravar. */
  function marcarParaEliminar() {
    if (!eliminar || gravando) return;
    const servidor = servidorPorId[eliminar._id];
    if (servidor) setRascunho((r) => marcarEliminar(r, eliminar._id, servidor));
    setAviso(null);
    setEliminar(null);
  }

  function anularEliminacao(id: string) {
    if (gravando) return; // durante o Gravar a eliminação já está a ser enviada
    setRascunho((r) => anularEliminar(r, id));
    setElimAlteradas((a) => a.filter((x) => x !== id));
    setErrosLinha(({ [id]: _x, ...resto }) => resto);
  }

  /** A reserva mudou no sistema mas a pessoa confirma: passa a valer o estado atual. */
  function eliminarMesmoAssim(id: string) {
    if (gravando) return;
    const servidor = servidorPorId[id];
    if (!servidor) return;
    setRascunho((r) => marcarEliminar(r, id, servidor));
    setElimAlteradas((a) => a.filter((x) => x !== id));
    // O erro «mudou no sistema» deixa de fazer sentido: a pessoa já confirmou.
    setErrosLinha(({ [id]: _x, ...resto }) => resto);
  }

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

  // FIX (excel parceiro) — Exporta as reservas do parceiro para .xlsx.
  async function handleExportarExcel() {
    try {
      const res = await fetch("/api/parceiro/reservas/exportar-excel", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Erro ao exportar Excel.");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "minhas_reservas.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      if (pendentes > 0) {
        setAviso(
          `O Excel reflete o que está gravado. Tens ${pendentes} alteração(ões) por gravar que não foram incluídas.`
        );
      }
    } catch (e) {
      setErro(mensagemErro(e, "Erro ao exportar Excel."));
    }
  }

  const setN = (k: keyof typeof NOVA_VAZIA) => (v: string) => setNova((n) => ({ ...n, [k]: v }));
  /** Tipo da reserva nova: limpa a data em Normal/Profunda; em Intermédia/Preparação sugere o check-in. */
  const mudarTipoNova = (v: string) =>
    setNova((n) => ({ ...n, tipo_limpeza: v, data_limpeza: tipoPedeData(v) ? n.data_limpeza || n.check_in : "" }));
  const enterAdiciona = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") acrescentarNova();
  };

  const nomePropriedade = (id: string) => propriedades.find((p) => p._id === id)?.nome ?? "—";

  // Linhas a desenhar: primeiro as novas por gravar (ficam sempre no topo), depois as reservas do servidor
  // ordenadas pela coluna escolhida (congeladas enquanto se edita, para a linha não saltar).
  const linhasNovas: Linha[] = rascunho.novas.map<Linha>((n) => ({
      key: n.tmp,
      nova: true,
      propNome: nomePropriedade(n.propriedade_id),
      valores: n,
      pendentes: new Set<Campo>(CAMPOS),
      estado: null,
      bloqueada: false,
      semEdicao: gravando,
      erro: errosLinha[n.tmp],
  }));
  const linhasReservas: Linha[] = reservas.map<Linha>((r) => {
      const e = rascunho.edicoes[r._id];
      return {
        key: r._id,
        nova: false,
        propNome: r.propriedade_id?.nome ?? "—",
        valores: valoresEfetivos(doServidor(r), e),
        pendentes: new Set<Campo>(e ? (Object.keys(e.campos) as Campo[]) : []),
        estado: r.tarefa_gerada_id?.estado ?? null,
        bloqueada: r.tarefa_gerada_id?.estado === "em_curso" || r.tarefa_gerada_id?.estado === "concluida",
        eliminada: r._id in rascunho.eliminar,
        semEdicao: gravando || r._id in rascunho.eliminar || r.tarefa_gerada_id?.estado === "em_curso" || r.tarefa_gerada_id?.estado === "concluida",
        erro: errosLinha[r._id],
        conflito: conflitos[r._id],
        reserva: r,
      };
  });
  const colOrdem = COLUNAS_ORDEM.find((c) => c.chave === ordem.chave) ?? COLUNAS_ORDEM[1];
  const linhasReservasOrdenadas = aplicarOrdemCongelada(
    ordenarPor(linhasReservas, colOrdem.valor, colOrdem.tipo, ordem.direcao),
    ordemCongelada,
    (l) => l.key
  );
  const linhas: Linha[] = [...linhasNovas, ...linhasReservasOrdenadas];

  /** Ao entrar num campo congela a ordem; ao sair (com pequena folga para saltar de campo) reordena. */
  const aoFocar = (e: React.FocusEvent) => {
    const alvo = e.target as HTMLElement;
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(alvo.tagName)) return;
    if (descongelar.current) clearTimeout(descongelar.current);
    setOrdemCongelada((c) => c ?? linhasReservasOrdenadas.map((l) => l.key));
  };
  const aoDesfocar = () => {
    if (descongelar.current) clearTimeout(descongelar.current);
    descongelar.current = setTimeout(() => setOrdemCongelada(null), 250);
  };

  /** Mensagens da linha: erro e/ou conflito com o sistema (com escolha explícita). */
  const avisosLinha = (l: Linha) => {
    const elimMudou = l.eliminada && elimAlteradas.includes(l.key);
    if (!l.erro && !l.conflito?.length && !elimMudou) return null;
    const servidor = servidorPorId[l.key];
    return (
      <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {l.erro && !elimMudou && <p>{l.erro}</p>}
        {elimMudou && (
          <div className="space-y-1">
            <p>Esta reserva mudou no sistema desde que a marcaste para eliminar.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={gravando} onClick={() => eliminarMesmoAssim(l.key)}>
                Eliminar mesmo assim
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={gravando} onClick={() => anularEliminacao(l.key)}>
                Anular
              </Button>
            </div>
          </div>
        )}
        {l.conflito && l.conflito.length > 0 && servidor && (
          <div className="space-y-1">
            <p>
              Mudou no sistema desde que começaste a editar:{" "}
              {l.conflito.map((c) => `${ROTULO_CAMPO[c]} (agora: ${servidor[c] || "vazio"})`).join("; ")}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => manterMinha(l.key)}>
                Manter a minha
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => usarSistema(l.key)}>
                Usar a do sistema
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const botaoGravar = (extra = "") => (
    <Button
      onClick={gravar}
      disabled={gravando || pendentes === 0}
      className={`gap-2 ${extra}`}
      aria-label={pendentes === 0 ? "Gravar (sem alterações por gravar)" : `Gravar: ${textoPendentes(pendentes)}`}
    >
      {gravando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      Gravar{pendentes > 0 ? ` (${pendentes})` : ""}
    </Button>
  );

  return (
    <main className={`flex flex-col gap-6 p-4 sm:p-6 lg:p-8 ${pendentes > 0 ? "pb-28 md:pb-8" : ""}`}>
      {/* Anúncio para leitores de ecrã: pendentes e resultado da gravação. */}
      <div className="sr-only" aria-live="polite" role="status">
        {pendentes === 0 ? "Sem alterações por gravar." : `${textoPendentes(pendentes)}.`} {resumo}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Table2 className="h-6 w-6 text-gold-text" />
            Minhas Reservas
          </h1>
          <p className="text-sm text-muted-foreground">
            Clica num campo para editar. Sair do campo guarda só neste aparelho (rascunho): nada é enviado nem
            atribuído até carregares em <strong>Gravar</strong>. Para uma reserva nova, preenche a linha do topo
            (ou o cartão &quot;Nova reserva&quot; no telemóvel) e carrega em Enter ou em +; ela fica por gravar.
            Cada reserva gerada gera uma limpeza.
          </p>
        </div>
        <div className="flex gap-2">
          <span className="hidden md:inline-flex">{botaoGravar()}</span>
          <Button
            variant="outline"
            onClick={handleExportarExcel}
            disabled={gravando}
            className="gap-2"
            title={
              pendentes > 0
                ? "Exporta o que está gravado (as alterações por gravar não entram)."
                : "Exporta as tuas reservas para Excel (.xlsx)."
            }
            aria-label="Exportar reservas gravadas para Excel"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Exportar</span>
          </Button>
        </div>
      </div>

      {erro && (
        <Card className="sticky top-2 z-20 border-destructive/50 bg-background" role="alert">
          <CardContent className="flex flex-wrap items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 basis-48">{erro}</span>
            {sessaoTerminou && (
              <a
                href="/login"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md text-center sm:w-auto border border-destructive/50 px-3 font-medium underline"
              >
                Iniciar sessão (abre noutro separador)
              </a>
            )}
          </CardContent>
        </Card>
      )}

      {aviso && (
        <Card className="border-amber-500/50 bg-background" role="status">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span className="flex-1">{aviso}</span>
            <button type="button" onClick={() => setAviso(null)} aria-label="Fechar aviso" className="min-h-[44px] min-w-[44px]">
              <X className="mx-auto h-4 w-4" />
            </button>
          </CardContent>
        </Card>
      )}

      {/* Barra de alterações por gravar: fixa em baixo no telemóvel; no desktop fica visível ao rolar. */}
      {pendentes > 0 && (
        <>
          <div className="sticky top-2 z-20 hidden items-center justify-between gap-3 rounded-lg border border-amber-500/60 bg-background px-4 py-2 shadow md:flex">
            <p className="text-sm font-medium">
              {textoPendentes(pendentes)}{" "}
              <span className="font-normal text-muted-foreground">(guardadas neste aparelho)</span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDescartarAberto(true)} disabled={gravando}>
                Descartar
              </Button>
              {botaoGravar()}
            </div>
          </div>
          <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t bg-background p-3 shadow-[0_-2px_8px_rgba(0,0,0,0.12)] md:hidden">
            <Button variant="outline" size="touch" onClick={() => setDescartarAberto(true)} disabled={gravando}>
              Descartar
            </Button>
            {botaoGravar("min-h-[44px] flex-1")}
          </div>
        </>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : propriedades.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Table2 className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Ainda não tens propriedades. Contacta o gestor para te atribuir propriedades.
          </p>
        </div>
      ) : (
        <>
        <LegendaCores />
        {/* Desktop (md+): tabela editável tipo folha de cálculo. */}
        <Card className="hidden md:block" onFocus={aoFocar} onBlur={aoDesfocar}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1450px] border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <Cab chave="propriedade" rotulo="Propriedade" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="check_in" rotulo="Check-in" ordem={ordem} onOrdenar={ordenarPorColuna} className="min-w-[11rem]" />
                  <Cab chave="hora_checkin" rotulo="Hora c/in" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="check_out" rotulo="Check-out" ordem={ordem} onOrdenar={ordenarPorColuna} className="min-w-[11rem]" />
                  <Cab chave="noites" rotulo="Noites" ordem={ordem} onOrdenar={ordenarPorColuna} direita />
                  <Cab chave="hospedes" rotulo="Hósp." ordem={ordem} onOrdenar={ordenarPorColuna} direita />
                  <Cab chave="nome_hospede" rotulo="Hóspede" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="plataforma" rotulo="Plataforma" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="tipo_limpeza" rotulo="Tipo de limpeza" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="data_limpeza" rotulo="Data da limpeza" ordem={ordem} onOrdenar={ordenarPorColuna} className="min-w-[11rem]" />
                  <Cab chave="horario_preferido" rotulo="Horário pref. limpeza" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="observacoes" rotulo="Notas" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <Cab chave="estado" rotulo="Limpeza" ordem={ordem} onOrdenar={ordenarPorColuna} />
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {/* Linha de entrada: Enter ou + acrescentam-na às reservas por gravar */}
                <tr className="border-b bg-primary/5" onKeyDown={enterAdiciona}>
                  <td className="p-0">
                    <select
                      value={nova.propriedade_id}
                      onChange={(e) => setN("propriedade_id")(e.target.value)}
                      className={CELULA}
                      disabled={gravando} aria-label="Nova reserva: propriedade"
                    >
                      <option value="">Propriedade…</option>
                      {propriedades.map((p) => (
                        <option key={p._id} value={p._id}>{p.nome}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-0">
                    <input type="date" value={nova.check_in} className={CELULA} disabled={gravando} aria-label="Nova reserva: check-in"
                      onChange={(e) => setNova((n) => ({ ...n, check_in: e.target.value, check_out: n.check_out || e.target.value }))} />
                  </td>
                  <td className="p-0">
                    <input value={nova.hora_checkin} onChange={(e) => setN("hora_checkin")(e.target.value)} placeholder="18:00" className={CELULA} disabled={gravando} aria-label="Nova reserva: hora de check-in" />
                  </td>
                  <td className="p-0">
                    <input type="date" value={nova.check_out} onChange={(e) => setN("check_out")(e.target.value)} className={CELULA} disabled={gravando} aria-label="Nova reserva: check-out" />
                  </td>
                  <td className="px-2 text-right text-muted-foreground">{noites(nova.check_in, nova.check_out) || ""}</td>
                  <td className="p-0">
                    <input type="number" min={0} value={nova.hospedes} onChange={(e) => setN("hospedes")(e.target.value)} className={`${CELULA} text-right`} disabled={gravando} aria-label="Nova reserva: hóspedes" />
                  </td>
                  <td className="p-0">
                    <input value={nova.nome_hospede} onChange={(e) => setN("nome_hospede")(e.target.value)} className={CELULA} disabled={gravando} aria-label="Nova reserva: nome do hóspede" />
                  </td>
                  <td className="p-0">
                    <select value={nova.plataforma} onChange={(e) => setN("plataforma")(e.target.value)} className={CELULA} disabled={gravando} aria-label="Nova reserva: plataforma">
                      <option value="">—</option>
                      {PLATAFORMAS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="p-0">
                    <select value={nova.tipo_limpeza} onChange={(e) => mudarTipoNova(e.target.value)} className={CELULA} disabled={gravando} aria-label="Nova reserva: tipo de limpeza">
                      {OPCOES_TIPO.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
                    </select>
                  </td>
                  <td className="p-0">
                    <input type="date" {...limitesDataLimpeza(nova.tipo_limpeza, nova.check_in, nova.check_out)} value={tipoPedeData(nova.tipo_limpeza) ? nova.data_limpeza : ""} onChange={(e) => setN("data_limpeza")(e.target.value)} className={CELULA} disabled={gravando || !tipoPedeData(nova.tipo_limpeza)} aria-label="Nova reserva: data da limpeza (intermédia ou preparação)" />
                  </td>
                  <td className="p-0">
                    <input value={nova.horario_preferido} onChange={(e) => setN("horario_preferido")(e.target.value)} placeholder="11h - 14h" className={CELULA} disabled={gravando} aria-label="Nova reserva: horário preferido de limpeza" />
                  </td>
                  <td className="p-0">
                    <input value={nova.observacoes} onChange={(e) => setN("observacoes")(e.target.value)} className={CELULA} disabled={gravando} aria-label="Nova reserva: notas" />
                  </td>
                  <td className="px-2 text-xs text-muted-foreground">nova</td>
                  <td className="px-1 text-right">
                    <Button size="sm" onClick={acrescentarNova} title="Acrescentar às reservas por gravar (Enter)" disabled={gravando} aria-label="Acrescentar reserva por gravar">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
                {novaErro && (
                  <tr>
                    <td colSpan={12} className="px-3 py-1 text-xs text-destructive" role="alert">{novaErro}</td>
                  </tr>
                )}

                {linhas.map((l) => {
                  const ci = l.valores.check_in;
                  const co = l.valores.check_out;
                  const nome = l.propNome;
                  const p = (c: Campo) => l.pendentes.has(c);
                  const avisos = avisosLinha(l);
                  const cor = corDaLinha(l);
                  return (
                    <FragmentoLinha key={l.key} avisos={avisos}>
                      <tr className={`border-b last:border-0 hover:bg-muted/30 ${cor.tr}`}>
                        <td className={`whitespace-nowrap px-2 py-1 font-medium ${cor.faixa}`}>{nome}</td>
                        <td className="p-0">
                          <Celula type="date" value={ci} pendente={p("check_in")} rotulo={`Check-in, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "check_in", v)} />
                        </td>
                        <td className="p-0">
                          <Celula value={l.valores.hora_checkin} pendente={p("hora_checkin")} rotulo={`Hora de check-in, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "hora_checkin", v)} />
                        </td>
                        <td className="p-0">
                          <Celula type="date" value={co} pendente={p("check_out")} rotulo={`Check-out, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "check_out", v)} />
                        </td>
                        <td className="w-16 p-0">
                          <Celula type="number" align="right" pendente={p("check_out")} rotulo={`Noites, ${nome}`} value={String(noites(ci, co))} disabled={l.semEdicao} onCommit={(v) => alterar(l, "noites", v)} />
                        </td>
                        <td className="w-16 p-0">
                          <Celula type="number" align="right" value={l.valores.hospedes} pendente={p("hospedes")} rotulo={`Hóspedes, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "hospedes", v)} />
                        </td>
                        <td className="p-0">
                          <Celula value={l.valores.nome_hospede} pendente={p("nome_hospede")} rotulo={`Nome do hóspede, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "nome_hospede", v)} />
                        </td>
                        <td className="p-0">
                          <Celula type="select" options={PLATAFORMAS} pendente={p("plataforma")} rotulo={`Plataforma, ${nome}`} value={l.valores.plataforma} disabled={l.semEdicao} onCommit={(v) => alterar(l, "plataforma", v)} />
                        </td>
                        <td className="p-0">
                          <Celula type="select" opcoes={OPCOES_TIPO} pendente={p("tipo_limpeza")} rotulo={`Tipo de limpeza, ${nome}`} value={tipoOuNormal(l.valores.tipo_limpeza)} disabled={l.semEdicao} onCommit={(v) => alterar(l, "tipo_limpeza", v)} />
                        </td>
                        <td className="p-0">
                          {tipoPedeData(l.valores.tipo_limpeza) ? (
                            <Celula type="date" {...limitesDataLimpeza(l.valores.tipo_limpeza, l.valores.check_in, l.valores.check_out)} pendente={p("data_limpeza")} rotulo={`Data da limpeza, ${nome}`} value={l.valores.data_limpeza} disabled={l.semEdicao} onCommit={(v) => alterar(l, "data_limpeza", v)} />
                          ) : (
                            <span className="px-2 text-xs text-muted-foreground" title="Normal e profunda ficam no check-out">No check-out</span>
                          )}
                        </td>
                        <td className="p-0">
                          <Celula value={l.valores.horario_preferido} pendente={p("horario_preferido")} rotulo={`Horário preferido, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "horario_preferido", v)} />
                        </td>
                        <td className="p-0">
                          <Celula value={l.valores.observacoes} pendente={p("observacoes")} rotulo={`Observações, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "observacoes", v)} />
                        </td>
                        <td className="whitespace-nowrap px-2">
                          {l.nova ? (
                            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">Por gravar</span>
                          ) : l.eliminada ? (
                            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">A eliminar</span>
                          ) : l.estado ? (
                            <span className="inline-flex items-center gap-1">
                              <EstadoTarefaBadge estado={estadoParaParceiro(l.estado)} />
                              {l.pendentes.size > 0 && (
                                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">Alterada</span>
                              )}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-1 text-right">
                          {l.nova ? (
                            <Button variant="ghost" size="sm" onClick={() => removerNova(l.key)} title="Tirar das reservas por gravar" aria-label={`Tirar a reserva nova de ${nome} das alterações por gravar`}>
                              <X className="h-4 w-4" />
                            </Button>
                          ) : (
                            l.eliminada ? (
                            <Button variant="outline" size="sm" disabled={gravando} onClick={() => anularEliminacao(l.key)} aria-label={`Anular a eliminação da reserva de ${nome}`}>
                              Anular
                            </Button>
                            ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => l.reserva && setEliminar(l.reserva)}
                              disabled={l.bloqueada || gravando}
                              title={l.bloqueada ? "A limpeza já começou ou foi concluída." : "Eliminar reserva"}
                              aria-label={`Eliminar reserva de ${nome}, ${formatarData(l.reserva?.check_in ?? "")}`}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            )
                          )}
                        </td>
                      </tr>
                    </FragmentoLinha>
                  );
                })}
              </tbody>
            </table>
          </div>
          {linhas.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Sem reservas. Preenche a linha do topo e grava para adicionar a primeira.
            </p>
          )}
        </Card>

        {/* Telemóvel (< md): cartões com os mesmos campos editáveis (a mesma <Celula/>). */}
        <div className="flex flex-col gap-3 md:hidden" onFocus={aoFocar} onBlur={aoDesfocar}>
          <Card onKeyDown={enterAdiciona}>
            <CardContent className="space-y-3 p-4">
              <h2 className="text-base font-semibold">Nova reserva</h2>
              <Campo texto="Propriedade">
                <select
                  value={nova.propriedade_id}
                  onChange={(e) => setN("propriedade_id")(e.target.value)}
                  className={CELULA_CARTAO}
                  disabled={gravando} aria-label="Nova reserva: propriedade"
                >
                  <option value="">Propriedade…</option>
                  {propriedades.map((p) => (
                    <option key={p._id} value={p._id}>{p.nome}</option>
                  ))}
                </select>
              </Campo>
              <div className="grid grid-cols-2 gap-3">
                <Campo texto="Check-in">
                  <input type="date" value={nova.check_in} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: check-in"
                    onChange={(e) => setNova((n) => ({ ...n, check_in: e.target.value, check_out: n.check_out || e.target.value }))} />
                </Campo>
                <Campo texto="Check-out">
                  <input type="date" value={nova.check_out} onChange={(e) => setN("check_out")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: check-out" />
                </Campo>
                <Campo texto="Hora de check-in">
                  <input value={nova.hora_checkin} onChange={(e) => setN("hora_checkin")(e.target.value)} placeholder="18:00" className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: hora de check-in" />
                </Campo>
                <Campo texto="Hóspedes">
                  <input type="number" inputMode="numeric" min={0} value={nova.hospedes} onChange={(e) => setN("hospedes")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: hóspedes" />
                </Campo>
              </div>
              <Campo texto="Nome do hóspede">
                <input value={nova.nome_hospede} onChange={(e) => setN("nome_hospede")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: nome do hóspede" />
              </Campo>
              <Campo texto="Plataforma">
                <select value={nova.plataforma} onChange={(e) => setN("plataforma")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: plataforma">
                  <option value="">—</option>
                  {PLATAFORMAS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Campo>
              <Campo texto="Tipo de limpeza">
                <select value={nova.tipo_limpeza} onChange={(e) => mudarTipoNova(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: tipo de limpeza">
                  {OPCOES_TIPO.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
                </select>
              </Campo>
              {tipoPedeData(nova.tipo_limpeza) && (
                <Campo texto="Data da limpeza">
                  <input type="date" {...limitesDataLimpeza(nova.tipo_limpeza, nova.check_in, nova.check_out)} value={nova.data_limpeza} onChange={(e) => setN("data_limpeza")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: data da limpeza" />
                </Campo>
              )}
              <Campo texto="Horário preferido de limpeza">
                <input value={nova.horario_preferido} onChange={(e) => setN("horario_preferido")(e.target.value)} placeholder="11h - 14h" className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: horário preferido de limpeza" />
              </Campo>
              <Campo texto="Notas">
                <input value={nova.observacoes} onChange={(e) => setN("observacoes")(e.target.value)} className={CELULA_CARTAO} disabled={gravando} aria-label="Nova reserva: notas" />
              </Campo>
              {novaErro && <p role="alert" className="text-sm text-destructive">{novaErro}</p>}
              <Button size="touch" variant="outline" className="w-full" onClick={acrescentarNova} disabled={gravando} aria-label="Acrescentar reserva por gravar">
                <Plus className="h-4 w-4" />
                Acrescentar (fica por gravar)
              </Button>
            </CardContent>
          </Card>

          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
              Ordenar por
              <select
                value={ordem.chave}
                onChange={(e) => mudarColunaOrdem(e.target.value)}
                className={`${CELULA_CARTAO} mt-1`}
                aria-label="Ordenar reservas por"
              >
                {COLUNAS_ORDEM.map((c) => (
                  <option key={c.chave} value={c.chave}>{c.rotulo}</option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" size="touch" onClick={inverterOrdem} aria-label={ordem.direcao === "asc" ? "Ordem ascendente: mudar para descendente" : "Ordem descendente: mudar para ascendente"}>
              {ordem.direcao === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
              {ordem.direcao === "asc" ? "Ascendente" : "Descendente"}
            </Button>
          </div>

          {linhas.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">
              Sem reservas. Preenche o cartão &quot;Nova reserva&quot; e grava para adicionar a primeira.
            </p>
          )}

          {linhas.map((l) => {
            const ci = l.valores.check_in;
            const co = l.valores.check_out;
            const nome = l.propNome;
            const p = (c: Campo) => l.pendentes.has(c);
            const cor = corDaLinha(l);
            return (
              <Card
                key={l.key}
                aria-label={`${l.nova ? "Reserva nova por gravar" : "Reserva"}, ${nome}, ${formatarData(ci)}`}
                className={cor.cartao || undefined}
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold">{nome}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <TipoLimpezaBadge tipo={l.valores.tipo_limpeza} />
                        {l.nova ? (
                          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">Por gravar</span>
                        ) : l.eliminada ? (
                          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">A eliminar</span>
                        ) : l.estado ? (
                          <EstadoTarefaBadge estado={estadoParaParceiro(l.estado)} />
                        ) : (
                          <span className="text-xs text-muted-foreground">Sem limpeza</span>
                        )}
                        {!l.nova && l.pendentes.size > 0 && (
                          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">Alterada, por gravar</span>
                        )}
                      </div>
                    </div>
                    {l.nova ? (
                      <Button
                        variant="ghost"
                        className="h-11 w-11 shrink-0"
                        onClick={() => removerNova(l.key)}
                        title="Tirar das reservas por gravar"
                        aria-label={`Tirar a reserva nova de ${nome} das alterações por gravar`}
                      >
                        <X className="h-5 w-5" />
                      </Button>
                    ) : (
                      l.eliminada ? (
                      <Button variant="outline" className="h-11 shrink-0" disabled={gravando} onClick={() => anularEliminacao(l.key)} aria-label={`Anular a eliminação da reserva de ${nome}`}>
                        Anular
                      </Button>
                      ) : (
                      <Button
                        variant="ghost"
                        className="h-11 w-11 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => l.reserva && setEliminar(l.reserva)}
                        disabled={l.bloqueada || gravando}
                        title={l.bloqueada ? "A limpeza já começou ou foi concluída." : "Eliminar reserva"}
                        aria-label={`Eliminar reserva de ${nome}, ${formatarData(l.reserva?.check_in ?? "")}`}
                      >
                        <Trash2 className="h-5 w-5" />
                      </Button>
                      )
                    )}
                  </div>
                  {avisosLinha(l)}
                  <div className="grid grid-cols-2 gap-3">
                    <Campo texto="Check-in">
                      <Celula cartao type="date" value={ci} pendente={p("check_in")} rotulo={`Check-in, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "check_in", v)} />
                    </Campo>
                    <Campo texto="Check-out">
                      <Celula cartao type="date" value={co} pendente={p("check_out")} rotulo={`Check-out, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "check_out", v)} />
                    </Campo>
                    <Campo texto="Hora de check-in">
                      <Celula cartao value={l.valores.hora_checkin} pendente={p("hora_checkin")} rotulo={`Hora de check-in, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "hora_checkin", v)} />
                    </Campo>
                    <Campo texto="Noites">
                      <Celula cartao type="number" value={String(noites(ci, co))} pendente={p("check_out")} rotulo={`Noites, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "noites", v)} />
                    </Campo>
                    <Campo texto="Hóspedes">
                      <Celula cartao type="number" value={l.valores.hospedes} pendente={p("hospedes")} rotulo={`Hóspedes, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "hospedes", v)} />
                    </Campo>
                    <Campo texto="Plataforma">
                      <Celula cartao type="select" options={PLATAFORMAS} value={l.valores.plataforma} pendente={p("plataforma")} rotulo={`Plataforma, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "plataforma", v)} />
                    </Campo>
                  </div>
                  <Campo texto="Nome do hóspede">
                    <Celula cartao value={l.valores.nome_hospede} pendente={p("nome_hospede")} rotulo={`Nome do hóspede, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "nome_hospede", v)} />
                  </Campo>
                  <Campo texto="Tipo de limpeza">
                    <Celula cartao type="select" opcoes={OPCOES_TIPO} value={tipoOuNormal(l.valores.tipo_limpeza)} pendente={p("tipo_limpeza")} rotulo={`Tipo de limpeza, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "tipo_limpeza", v)} />
                  </Campo>
                  {tipoPedeData(l.valores.tipo_limpeza) && (
                    <Campo texto="Data da limpeza">
                      <Celula cartao type="date" {...limitesDataLimpeza(l.valores.tipo_limpeza, l.valores.check_in, l.valores.check_out)} value={l.valores.data_limpeza} pendente={p("data_limpeza")} rotulo={`Data da limpeza, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "data_limpeza", v)} />
                    </Campo>
                  )}
                  <Campo texto="Horário preferido de limpeza">
                    <Celula cartao value={l.valores.horario_preferido} pendente={p("horario_preferido")} rotulo={`Horário preferido, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "horario_preferido", v)} />
                  </Campo>
                  <Campo texto="Notas">
                    <Celula cartao value={l.valores.observacoes} pendente={p("observacoes")} rotulo={`Observações, ${nome}`} disabled={l.semEdicao} onCommit={(v) => alterar(l, "observacoes", v)} />
                  </Campo>
                </CardContent>
              </Card>
            );
          })}
        </div>
        </>
      )}

      {/* Descartar o rascunho */}
      <Dialog open={descartarAberto} onOpenChange={(o) => !o && setDescartarAberto(false)}>
        <DialogHeader>
          <div>
            <DialogTitle>Descartar alterações</DialogTitle>
            <DialogDescription>
              Vais perder: {textoPendentes(pendentes)} (guardadas só neste aparelho). As reservas já gravadas não mudam.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setDescartarAberto(false)} />
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDescartarAberto(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={descartarTudo}>Descartar</Button>
        </DialogFooter>
      </Dialog>

      {/* Confirmação de eliminação: só marca a linha; envia-se ao Gravar */}
      <Dialog open={!!eliminar} onOpenChange={(o) => !o && setEliminar(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Eliminar reserva
            </DialogTitle>
            <DialogDescription>
              {eliminar
                ? `Eliminar a reserva de ${eliminar.propriedade_id?.nome ?? "propriedade"} (${formatarData(eliminar.check_in)} → ${formatarData(eliminar.check_out)})? A reserva fica marcada «a eliminar» e só é eliminada (com a limpeza associada cancelada) quando carregares em «Gravar». Podes anular antes.`
                : ""}
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setEliminar(null)} />
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEliminar(null)}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={marcarParaEliminar}>
            <Trash2 className="mr-2 h-4 w-4" />
            Marcar para eliminar
          </Button>
        </DialogFooter>
      </Dialog>

    </main>
  );
}

/** Linha da tabela + (se houver) uma linha extra com os avisos/erros dessa reserva. */
function FragmentoLinha({ avisos, children }: { avisos: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      {children}
      {avisos && (
        <tr className="border-b">
          <td colSpan={12} className="px-3 py-2">{avisos}</td>
        </tr>
      )}
    </>
  );
}
