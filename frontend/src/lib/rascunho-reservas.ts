/**
 * Rascunho local das reservas do parceiro (/parceiro/reservas).
 *
 * Sair de uma célula só guarda aqui (localStorage). Nada vai para o servidor
 * até carregar em "Gravar". Este módulo é lógica pura (sem React) para poder
 * ser testada: ler/guardar, aplicar uma edição, validar, detetar conflitos com
 * dados mais recentes do servidor e preparar o pedido.
 *
 * RGPD: o rascunho tem o nome do hóspede e notas da reserva; a chave inclui
 * utilizador e empresa e começa pelo prefixo limpo no logout
 * (`limparTodosRascunhos` em rascunho-staff.ts).
 */

import { PREFIXO_RASCUNHO } from "@/lib/rascunho-staff";

export const CAMPOS = [
  "check_in",
  "check_out",
  "hora_checkin",
  "hospedes",
  "nome_hospede",
  "plataforma",
  "horario_preferido",
  "observacoes",
] as const;

export type Campo = (typeof CAMPOS)[number];
export type Valores = Record<Campo, string>;

/** Edição pendente de uma reserva já gravada: o que mudou e o valor que havia ANTES. */
export interface Edicao {
  campos: Partial<Valores>;
  antes: Partial<Valores>;
}

/** Reserva nova ainda não enviada. */
export interface NovaReserva extends Valores {
  tmp: string;
  propriedade_id: string;
}

export interface Rascunho {
  edicoes: Record<string, Edicao>;
  novas: NovaReserva[];
  /**
   * Reservas marcadas para eliminar (só se eliminam ao carregar em Gravar).
   * Guarda os valores do servidor no momento em que foram marcadas, para
   * detetar se a reserva mudou entretanto.
   */
  eliminar: Record<string, Valores>;
}

/** Validade máxima do rascunho (tem nomes e notas de hóspedes): 7 dias desde a última alteração. */
export const VALIDADE_RASCUNHO_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArmazemMinimo {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const RASCUNHO_VAZIO: Rascunho = { edicoes: {}, novas: [], eliminar: {} };

export function chaveRascunho(utilizadorId: string, empresaId: string): string {
  return `${PREFIXO_RASCUNHO}reservas_${empresaId}_${utilizadorId}`;
}

const eTexto = (v: unknown): v is string => typeof v === "string";

/** Lê o rascunho; qualquer coisa inválida vira rascunho vazio. */
export function lerRascunhoReservas(chave: string, armazem: ArmazemMinimo, agora: number = Date.now()): Rascunho {
  const vazio = (): Rascunho => ({ edicoes: {}, novas: [], eliminar: {} });
  try {
    const bruto = armazem.getItem(chave);
    if (!bruto) return vazio();
    const r = JSON.parse(bruto);
    // Rascunho expirado (ou sem data, de versões antigas e sem prazo): apaga.
    if (typeof r?.guardado_em === "number" && agora - r.guardado_em > VALIDADE_RASCUNHO_MS) {
      try { armazem.removeItem(chave); } catch { /* ignora */ }
      return vazio();
    }
    const edicoes: Record<string, Edicao> = {};
    for (const [id, e] of Object.entries<{ campos?: Record<string, unknown>; antes?: Record<string, unknown> }>(
      r?.edicoes && typeof r.edicoes === "object" ? r.edicoes : {}
    )) {
      const campos: Partial<Valores> = {};
      const antes: Partial<Valores> = {};
      for (const c of CAMPOS) {
        const vc = e?.campos?.[c];
        if (eTexto(vc)) {
          campos[c] = vc.slice(0, 2000);
          const va = e?.antes?.[c];
          antes[c] = eTexto(va) ? va : "";
        }
      }
      if (Object.keys(campos).length > 0) edicoes[id] = { campos, antes };
    }
    const novas: NovaReserva[] = [];
    for (const n of Array.isArray(r?.novas) ? r.novas : []) {
      if (!n || !eTexto(n.tmp) || !eTexto(n.propriedade_id)) continue;
      const nova = { tmp: n.tmp, propriedade_id: n.propriedade_id } as NovaReserva;
      for (const c of CAMPOS) nova[c] = eTexto(n[c]) ? n[c].slice(0, 2000) : "";
      novas.push(nova);
    }
    const eliminar: Record<string, Valores> = {};
    for (const [id, v] of Object.entries<Record<string, unknown>>(
      r?.eliminar && typeof r.eliminar === "object" ? r.eliminar : {}
    )) {
      const snap = {} as Valores;
      for (const c of CAMPOS) snap[c] = eTexto(v?.[c]) ? (v[c] as string).slice(0, 2000) : "";
      eliminar[id] = snap;
    }
    return { edicoes, novas, eliminar };
  } catch {
    return vazio();
  }
}

/** Guarda (ou apaga, se vazio) o rascunho. Falhas de quota/modo privado são ignoradas. */
export function guardarRascunhoReservas(chave: string, r: Rascunho, armazem: ArmazemMinimo, agora: number = Date.now()): void {
  try {
    if (Object.keys(r.edicoes).length === 0 && r.novas.length === 0 && Object.keys(r.eliminar ?? {}).length === 0) {
      armazem.removeItem(chave);
      return;
    }
    armazem.setItem(chave, JSON.stringify({ ...r, guardado_em: agora }));
  } catch {
    // ignora
  }
}

/**
 * Número de linhas com alterações por gravar: reservas editadas + reservas
 * novas + reservas a eliminar. Uma edição numa linha marcada para eliminar
 * não conta (não é enviada).
 */
export function contarPendentes(r: Rascunho): number {
  const elim = r.eliminar ?? {};
  const editadas = Object.keys(r.edicoes).filter((id) => !(id in elim)).length;
  return editadas + r.novas.length + Object.keys(elim).length;
}

/** Marca a reserva para eliminar (só se elimina ao Gravar). `servidor` = valores atuais. */
export function marcarEliminar(r: Rascunho, id: string, servidor: Valores): Rascunho {
  return { ...r, eliminar: { ...r.eliminar, [id]: servidor } };
}

/** Anula a marca "a eliminar" (as edições pendentes dessa linha voltam a contar). */
export function anularEliminar(r: Rascunho, id: string): Rascunho {
  const { [id]: _x, ...resto } = r.eliminar;
  return { ...r, eliminar: resto };
}

export interface ReconciliacaoEliminar {
  /** Marcas que continuam válidas (reservas ainda existentes). */
  eliminar: Record<string, Valores>;
  /** Reservas que já não existem no servidor: a eliminação já está feita (marca removida). */
  jaEliminadas: string[];
  /** Reservas alteradas no servidor desde que foram marcadas: a pessoa confirma ou anula. */
  alteradas: string[];
}

/** Compara as marcas "a eliminar" com o servidor (nunca elimina às cegas uma reserva que mudou). */
export function reconciliarEliminacoes(
  eliminar: Record<string, Valores>,
  servidorPorId: Record<string, Valores>
): ReconciliacaoEliminar {
  const out: Record<string, Valores> = {};
  const jaEliminadas: string[] = [];
  const alteradas: string[] = [];
  for (const [id, snap] of Object.entries(eliminar)) {
    const s = servidorPorId[id];
    if (!s) {
      jaEliminadas.push(id);
      continue;
    }
    out[id] = snap;
    if (CAMPOS.some((c) => s[c] !== snap[c])) alteradas.push(id);
  }
  return { eliminar: out, jaEliminadas, alteradas };
}

/** O rascunho tem dados (para avisar no logout)? */
export function temPendentes(r: Rascunho): boolean {
  return contarPendentes(r) > 0;
}

/** "1 alteração por gravar" / "3 alterações por gravar". */
export function textoPendentes(n: number): string {
  return n === 1 ? "1 alteração por gravar" : `${n} alterações por gravar`;
}

/**
 * Aplica uma edição de uma célula a uma reserva existente. Se o valor volta a
 * ser igual ao do servidor, a alteração deixa de ser pendente.
 */
export function aplicarCampo(
  edicoes: Record<string, Edicao>,
  id: string,
  campo: Campo,
  valor: string,
  servidor: Valores
): Record<string, Edicao> {
  const atual = edicoes[id] ?? { campos: {}, antes: {} };
  const campos = { ...atual.campos };
  const antes = { ...atual.antes };
  if (valor === servidor[campo]) {
    delete campos[campo];
    delete antes[campo];
  } else {
    campos[campo] = valor;
    // "antes" é o valor do servidor quando a edição começou (para detetar conflitos).
    if (!(campo in antes)) antes[campo] = servidor[campo];
  }
  const out = { ...edicoes };
  if (Object.keys(campos).length === 0) delete out[id];
  else out[id] = { campos, antes };
  return out;
}

/** Valores a mostrar/enviar: servidor + edição pendente por cima. */
export function valoresEfetivos(servidor: Valores, edicao?: Edicao): Valores {
  return { ...servidor, ...(edicao?.campos ?? {}) };
}

function dataValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Erro de validação (texto pt-PT) ou null. `propriedade` só se exige nas reservas novas. */
export function validarReserva(v: Valores, propriedade?: string): string | null {
  if (propriedade !== undefined && !propriedade) return "Escolhe a propriedade.";
  if (!dataValida(v.check_in)) return "Check-in em falta ou inválido.";
  if (!dataValida(v.check_out)) return "Check-out em falta ou inválido.";
  if (v.check_out < v.check_in) return "O check-out não pode ser anterior ao check-in.";
  if (v.hospedes !== "" && !/^\d{1,3}$/.test(v.hospedes.trim())) {
    return "Número de hóspedes inválido.";
  }
  return null;
}

/** Corpo do PUT/POST: só os campos indicados, com hóspedes como número (ou null). */
export function paraPayload(v: Partial<Valores>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of CAMPOS) {
    if (!(c in v)) continue;
    const val = v[c] as string;
    if (c === "hospedes") out[c] = val.trim() === "" ? null : Number(val);
    else out[c] = val;
  }
  return out;
}

export interface Reconciliacao {
  edicoes: Record<string, Edicao>;
  /** Campos cujo valor mudou no servidor desde que a edição começou: não se enviam sem confirmação. */
  conflitos: Record<string, Campo[]>;
  /** Reservas com rascunho que já não existem no servidor (rascunho descartado). */
  desaparecidas: string[];
}

/**
 * Compara o rascunho com os dados atuais do servidor. Nunca sobrescreve às cegas:
 *  - servidor já igual ao rascunho => a alteração deixa de ser pendente;
 *  - servidor diferente do que havia ANTES => conflito (a pessoa decide);
 *  - reserva apagada => rascunho dessa linha descartado.
 */
export function reconciliar(
  edicoes: Record<string, Edicao>,
  servidorPorId: Record<string, Valores>
): Reconciliacao {
  const out: Record<string, Edicao> = {};
  const conflitos: Record<string, Campo[]> = {};
  const desaparecidas: string[] = [];
  for (const [id, e] of Object.entries(edicoes)) {
    const s = servidorPorId[id];
    if (!s) {
      desaparecidas.push(id);
      continue;
    }
    const campos: Partial<Valores> = {};
    const antes: Partial<Valores> = {};
    const emConflito: Campo[] = [];
    for (const c of CAMPOS) {
      if (!(c in e.campos)) continue;
      if (s[c] === e.campos[c]) continue; // o servidor já tem este valor
      campos[c] = e.campos[c];
      antes[c] = e.antes[c] ?? "";
      if (s[c] !== (e.antes[c] ?? "")) emConflito.push(c);
    }
    if (Object.keys(campos).length > 0) {
      out[id] = { campos, antes };
      if (emConflito.length > 0) conflitos[id] = emConflito;
    }
  }
  return { edicoes: out, conflitos, desaparecidas };
}
