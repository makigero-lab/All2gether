/** Tipos e ajudas da área Integrações do gestor (respostas de /api/gestor/integracoes/resumo e afins). */

export type EstadoCelula = "ativa" | "erro" | "pausada" | "suspensa";
export type EstadoLinha = "ok" | "erro" | "por_aceitar" | "pausada" | "sem_ligacao";

export interface CelulaCanal {
  fonte_id: string;
  canal: "airbnb" | "booking" | "vrbo" | "outro";
  canal_texto: string;
  estado: EstadoCelula;
  motivo_estado: string | null;
  estado_texto: string | null;
  url_mascara: string | null;
  ultima_leitura_em: string | null;
  ultimo_sucesso_em: string | null;
  em_validacao: boolean;
  aviso_validacao: string | null;
  erro: { codigo: string; mensagem: string; em: string | null; /** Passa sozinho (5xx, tempo esgotado): não pede «Corrigir». */ temporario?: boolean; /** Início da série de falhas seguidas (nunca inventado: null se o servidor não o sabe). */ falha_desde?: string | null; /** Quando o servidor volta a tentar ler. */ proxima_leitura_em?: string | null } | null;
}

export interface CasaResumo {
  _id: string;
  nome: string;
  ativo: boolean;
  smoobu: boolean;
  por_confirmar: number;
  airbnb: CelulaCanal | null;
  booking: CelulaCanal | null;
  outros: CelulaCanal[];
  /** Morada curta (rua e localidade) para distinguir casas com o mesmo nome. */
  morada_curta?: string | null;
}

export interface ErroDaLigacao { casa: string; canal: string; fonte_id: string; codigo?: string; mensagem: string; em: string | null; temporario?: boolean; falha_desde?: string | null; proxima_leitura_em?: string | null }

export interface ProprietarioResumo {
  _id: string;
  nome: string;
  email: string;
  ativo: boolean;
  acordo: "nao_exigido" | "aceite" | "por_aceitar";
  estado: EstadoLinha;
  n_erros: number;
  n_ligadas: number;
  n_ligacoes: number;
  n_por_confirmar: number;
  /** Casas inativas (não aparecem na matriz): o assistente explica porque não há casas para ligar. */
  n_casas_inativas?: number;
  ultima_leitura_em: string | null;
  primeiro_erro: ErroDaLigacao | null;
  /** Uma entrada por ligação com erro ou à espera de validação (até 10): o painel «Precisam de atenção» lista-as uma a uma. */
  erros?: ErroDaLigacao[];
  casas: CasaResumo[];
}

export interface ResumoIntegracoes {
  proprietarios: ProprietarioResumo[];
  totais: { erros: number; por_confirmar: number; sem_ligacao: number; em_pausa: number; por_aceitar: number };
  ligado: boolean;
  modo_teste: boolean;
  acordo_obrigatorio: boolean;
}

export type Filtro = "todos" | "erro" | "por_confirmar" | "sem_ligacao" | "pausada";

/** Aplica o filtro de uma linha (função pura, testável). */
export function passaFiltro(p: ProprietarioResumo, f: Filtro): boolean {
  switch (f) {
    case "erro": return p.n_erros > 0;
    case "por_confirmar": return p.n_por_confirmar > 0;
    case "sem_ligacao": return p.estado === "sem_ligacao";
    case "pausada": return p.estado === "pausada" || p.estado === "por_aceitar";
    default: return true;
  }
}

/** Linhas com erro primeiro; a ordem alfabética (já vinda do servidor) mantém-se dentro de cada grupo. */
export function ordenarLinhas(l: ProprietarioResumo[]): ProprietarioResumo[] {
  return [...l].sort((a, b) => Number(b.n_erros > 0) - Number(a.n_erros > 0));
}

/** Canal que o link parece ser, pelo domínio (sugere trocar em vez de recusar). */
export function canalDoLink(texto: string): "airbnb" | "booking" | "outro" | null {
  const t = texto.trim().toLowerCase();
  if (!t) return null;
  if (/^https?:\/\/([a-z0-9-]+\.)*airbnb\.[a-z.]+\//.test(t)) return "airbnb";
  if (/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//.test(t)) return "booking";
  return /^https?:\/\//.test(t) ? "outro" : null;
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** «14 nov» a partir de 2026-11-14. */
export function diaMes(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1] ?? ""}`;
}

/** «há 20 min», «há 3 h», «há 2 dias». */
export function haQuanto(iso: string | null, agora: number = Date.now()): string {
  if (!iso) return "ainda não";
  const min = Math.max(0, Math.round((agora - new Date(iso).getTime()) / 60000));
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  const dias = Math.round(min / 1440);
  return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
}

const FUSO = "Europe/Lisbon";
const horaLisboa = (d: Date) => new Intl.DateTimeFormat("pt-PT", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const diaLisboa = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * «Falha há 2 h · nova tentativa às 14:10» (hora de Lisboa). Só usa o que o servidor sabe: sem `falha_desde` não diz
 * desde quando; sem `proxima_leitura_em` não diz a próxima tentativa; sem nenhum dos dois devolve null (não mostra nada).
 * Uma tentativa já atrasada (o job corre de 5 em 5 min) diz «em breve» em vez de uma hora passada.
 */
export function textoFalha(e: { falha_desde?: string | null; proxima_leitura_em?: string | null } | null | undefined, agora: Date = new Date()): string | null {
  if (!e) return null;
  const partes: string[] = [];
  const desde = e.falha_desde ? new Date(e.falha_desde) : null;
  const longa = falhaLonga(e, agora);
  if (desde && !Number.isNaN(desde.getTime())) {
    const q = haQuanto(desde.toISOString(), agora.getTime());
    partes.push(q === "agora mesmo" ? "Falhou agora mesmo" : `Falha ${q}`);
  }
  // Falha de um dia ou mais: «a tentar de novo» (o servidor continua a tentar sozinho) em vez de «nova tentativa».
  const tentativa = longa ? "a tentar de novo" : "nova tentativa";
  const prox = e.proxima_leitura_em ? new Date(e.proxima_leitura_em) : null;
  if (prox && !Number.isNaN(prox.getTime())) {
    if (prox.getTime() <= agora.getTime()) partes.push(`${tentativa} em breve`);
    else {
      const hoje = diaLisboa(agora);
      const dia = diaLisboa(prox);
      const amanha = diaLisboa(new Date(agora.getTime() + 86400000));
      const quando = dia === hoje ? "" : dia === amanha ? "amanhã " : `a ${diaMes(dia)} `;
      partes.push(`${tentativa} ${quando}às ${horaLisboa(prox)}`);
    }
  }
  return partes.length ? partes.join(" · ") : null;
}

/** A falha dura há 24 h ou mais (a interface dá-lhe mais destaque). Só com `falha_desde` conhecido. */
export function falhaLonga(e: { falha_desde?: string | null } | null | undefined, agora: Date = new Date()): boolean {
  const d = e?.falha_desde ? new Date(e.falha_desde).getTime() : NaN;
  return !Number.isNaN(d) && agora.getTime() - d >= 86400000;
}

/** Localidade de uma morada curta («Rua do Ouro 10, Lisboa» → «Lisboa»). */
const localidade = (m: string) => m.split(",").pop()!.trim() || m;

/**
 * Nomes das casas que se distinguem uns dos outros: se um nome se repete (sem diferenças de maiúsculas ou espaços),
 * acrescenta a morada curta («Casa Azul (Rua do Ouro 10, Lisboa)») ou, sem morada, um número. Com `max`, uma morada
 * que faria o nome passar desse tamanho encurta-se para a localidade.
 */
export function nomesDistintos(casas: { _id: string; nome: string; morada_curta?: string | null }[], max = 40): Map<string, string> {
  const repetidos = new Map<string, number>();
  for (const c of casas) { const k = c.nome.trim().toLowerCase(); repetidos.set(k, (repetidos.get(k) ?? 0) + 1); }
  const contador = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of casas) {
    const k = c.nome.trim().toLowerCase();
    if ((repetidos.get(k) ?? 0) <= 1) { out.set(c._id, c.nome); continue; }
    const n = (contador.get(k) ?? 0) + 1;
    if (!c.morada_curta) contador.set(k, n);
    const nome = c.nome.trim();
    const morada = c.morada_curta ? (`${nome} (${c.morada_curta})`.length > max ? localidade(c.morada_curta) : c.morada_curta) : null;
    out.set(c._id, morada ? `${nome} (${morada})` : `${nome} (${n})`);
  }
  return out;
}

/**
 * Nome da casa para o seletor do assistente, com o canal já ligado em forma curta para caber no telemóvel:
 * «Baixa — Airbnb + Booking», «— Airbnb», «— Smoobu» e sem sufixo se nada. Nomes repetidos levam a morada curta
 * (só a localidade se o rótulo passar dos ~40 caracteres).
 */
export function rotulosDasCasas(casas: Pick<CasaResumo, "_id" | "nome" | "smoobu" | "airbnb" | "booking" | "outros" | "morada_curta">[]): Map<string, string> {
  const nomes = nomesDistintos(casas);
  const out = new Map<string, string>();
  for (const c of casas) {
    const canais = [c.airbnb ? "Airbnb" : "", c.booking ? "Booking" : "", ...(c.outros ?? []).map((o) => o.canal_texto)].filter(Boolean);
    const sufixo = c.smoobu ? " — Smoobu" : canais.length ? ` — ${canais.join(" + ")}` : "";
    out.set(c._id, (nomes.get(c._id) ?? c.nome) + sufixo);
  }
  return out;
}

export function msgErro(e: unknown, omissao: string): string {
  const m = (e as { message?: string })?.message;
  return m && m.length < 300 ? m : omissao;
}

/** A regra «uma só fonte por casa», dita uma única vez no topo da matriz e da lista. */
export const REGRA_UMA_FONTE = "Cada casa recebe reservas de uma só origem automática: Smoobu, ou os calendários Airbnb/Booking, que podem coexistir.";

/** Tamanho de cada pedido do lote «Confirmar / É um bloqueio» (blocos pequenos para o progresso andar; o servidor aceita até 200). */
export const TAMANHO_BLOCO = 25;

/** Parte uma lista em blocos de `n` (função pura, testável). */
export function blocos<T>(lista: T[], n: number = TAMANHO_BLOCO): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
  return out;
}

function pl(n: number, um: string, varios: string): string { return `${n} ${n === 1 ? um : varios}`; }

/** Porque é que não há casas para ligar a este proprietário (ou null se há). */
export function semCasasParaLigar(p: Pick<ProprietarioResumo, "ativo" | "casas" | "n_casas_inativas">): string | null {
  if (!p.ativo) return "Este proprietário está inativo, por isso não se podem ligar calendários das casas dele. Reativa-o em Proprietários e volta aqui.";
  if (p.casas.some((c) => c.ativo)) return null;
  const inativas = p.casas.filter((c) => !c.ativo).length + (p.n_casas_inativas ?? 0);
  if (inativas > 0) return `${inativas === 1 ? "A única casa deste proprietário está inativa" : `As ${inativas} casas deste proprietário estão inativas`}. Reativa-${inativas === 1 ? "a" : "as"} em Propriedades para poderes ligar o calendário.`;
  return "Este proprietário ainda não tem casas. Cria ou associa uma casa em Propriedades e volta aqui.";
}

export interface ResultadoTeste {
  canal?: string; reservas?: number; bloqueios?: number; por_confirmar?: number; periodo?: { de: string; ate: string } | null;
}

/**
 * Frase do resultado de um teste bem-sucedido. O Booking não distingue reservas de bloqueios (tudo o que está
 * fechado vem «por confirmar»), por isso nunca se diz «0 reservas e 0 bloqueios».
 */
export function fraseDoTeste(t: ResultadoTeste): string {
  const entre = t.periodo ? ` entre ${diaMes(t.periodo.de)} e ${diaMes(t.periodo.ate)}` : "";
  const pc = t.por_confirmar ?? 0;
  if (t.canal === "booking" || (pc > 0 && !(t.reservas || t.bloqueios))) {
    if (pc === 0) return "O calendário está vazio: ainda não há períodos fechados.";
    return `Encontrámos ${pl(pc, "período por confirmar", "períodos por confirmar")}${entre} (o Booking não distingue reservas de bloqueios).`;
  }
  const base = `Encontrámos ${pl(t.reservas ?? 0, "reserva", "reservas")} e ${pl(t.bloqueios ?? 0, "bloqueio", "bloqueios")}${entre}`;
  return pc > 0 ? `${base} e ${pl(pc, "período por confirmar", "períodos por confirmar")}.` : `${base}.`;
}

export interface RespostaLigar {
  fonte?: { em_validacao?: boolean; aviso_validacao?: string | null } | null;
  leitura?: { resultado?: string; mensagem?: string | null; n_eventos?: number | null; alteracoes?: { criadas: number; por_confirmar: number } | null } | null;
}

/** O que o assistente diz depois de «Ligar»: ligado, ligado mas à espera de validação, ou primeira leitura falhada. */
export function resultadoLigar(r: RespostaLigar): { tipo: "ok" | "validacao" | "erro"; texto: string; n?: number } {
  if (r.fonte?.em_validacao) {
    const n = r.leitura?.n_eventos ?? Number(/(\d+)\s+reservas?/.exec(r.fonte.aviso_validacao ?? "")?.[1] ?? 0);
    return { tipo: "validacao", n, texto: `Ligado, mas à espera da tua validação: encontrámos ${pl(n, "reserva nova", "reservas novas")} de uma vez. Ainda não criámos nenhuma limpeza.` };
  }
  if (r.leitura?.resultado === "erro") return { tipo: "erro", texto: `Ligado, mas a primeira leitura falhou: ${r.leitura.mensagem ?? "tenta mais tarde."}` };
  const a = r.leitura?.alteracoes;
  return { tipo: "ok", texto: a ? `Ligado. ${pl(a.criadas, "limpeza nova", "limpezas novas")}; ${pl(a.por_confirmar, "período por confirmar", "períodos por confirmar")}.` : "Ligado." };
}

/** O que se diz depois de «Aceitar»: quantas limpezas se criaram já. */
export function resultadoAceitar(l: { alteracoes?: { criadas: number; por_confirmar: number } | null } | null | undefined): string {
  const a = l?.alteracoes;
  if (!a) return "Aceite. O calendário passa a ser lido normalmente.";
  return `Aceite. ${pl(a.criadas, "limpeza criada", "limpezas criadas")}; ${pl(a.por_confirmar, "período por confirmar", "períodos por confirmar")}.`;
}

export interface ResultadoItemLote { id: string; ok: boolean; erro?: string | null }

/** Agrupa as falhas de um lote por motivo (para dizer «2 × O proprietário está inativo»). */
export function agruparFalhas(resultados: ResultadoItemLote[]): { texto: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of resultados) if (!r.ok) m.set(r.erro || "Não foi possível tratar.", (m.get(r.erro || "Não foi possível tratar.") ?? 0) + 1);
  return [...m.entries()].map(([texto, n]) => ({ texto, n })).sort((a, b) => b.n - a.n);
}

/** «a mostrar 500 de 612» quando a lista está cortada; vazio quando mostra tudo. */
export function textoCorte(mostrando: number, total: number): string | null {
  return total > mostrando ? `A mostrar ${mostrando} de ${total}.` : null;
}

/** Legenda da mini-barra: «3 casas · 1 com erro». */
export function legendaCasas(estados: string[]): string {
  const erro = estados.filter((e) => e === "com erro").length;
  const pausa = estados.filter((e) => e === "em pausa").length;
  return [pl(estados.length, "casa", "casas"), erro ? `${erro} com erro` : "", pausa ? `${pausa} em pausa` : ""].filter(Boolean).join(" · ");
}

export interface RespostaLote { ok: number; falhas: number; resultados?: ResultadoItemLote[]; nao_tratados?: string[]; incompleto?: boolean }

/**
 * Envia as decisões em blocos de 25, em sequência, e junta o resultado. O servidor pode parar mais cedo para não
 * demorar demasiado (`nao_tratados`): o que ficou por tratar segue no bloco seguinte. `aoProgresso(feitos)` é chamado
 * antes de cada bloco e no fim. Devolve o que foi feito, as falhas e, se parou por erro, a mensagem e os ids por tratar.
 */
export async function enviarEmBlocos(
  ids: string[], acao: "confirmar" | "bloqueio",
  enviar: (corpo: { ids: string[]; acao: string }) => Promise<RespostaLote>,
  aoProgresso: (feitos: number) => void = () => undefined,
): Promise<{ ok: number; falhas: ResultadoItemLote[]; restantes: string[]; erro: string | null }> {
  let ok = 0; let feitos = 0; let erro: string | null = null;
  const falhas: ResultadoItemLote[] = [];
  let fila = [...ids];
  while (fila.length > 0) {
    const bloco = blocos(fila, TAMANHO_BLOCO)[0];
    aoProgresso(feitos);
    let r: RespostaLote;
    try { r = await enviar({ ids: bloco, acao }); } catch (e) { erro = msgErro(e, "Não foi possível guardar a decisão."); break; }
    ok += r.ok;
    falhas.push(...(r.resultados ?? []).filter((x) => !x.ok));
    const por = new Set(r.nao_tratados ?? []);
    const tratados = bloco.length - por.size;
    feitos += tratados;
    fila = [...bloco.filter((i) => por.has(i)), ...fila.slice(bloco.length)];
    if (tratados === 0) { erro = "O servidor não conseguiu tratar mais períodos agora. Tenta outra vez daqui a pouco."; break; }
  }
  aoProgresso(feitos);
  return { ok, falhas, restantes: fila, erro };
}

