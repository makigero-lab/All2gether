/**
 * Cor de cada pessoa da equipa no calendário do gestor.
 *
 * A cor da pessoa vai numa faixa à esquerda do cartão e no círculo com a
 * inicial; o fundo e a borda continuam a dizer o estado. Sem cor escolhida,
 * cada pessoa recebe uma da paleta pela ordem de criação (o _id cresce com o
 * tempo), por isso quem já existe não muda de cor quando entra alguém novo.
 * Paleta revista pelo @Designer (2026-11-13): luminosidade média para dar 3:1 contra o cartão claro e escuro,
 * sem vermelho, laranja, âmbar nem cinza (esses são dos estados). A ordem não deve mudar: quem entra primeiro
 * recebe as cores mais distintas.
 */
export const PALETA_EQUIPA = [
  "#2563eb", // azul
  "#db2777", // rosa
  "#15803d", // verde
  "#b02fc4", // magenta
  "#0e7490", // ciano escuro
  "#8c6e5d", // castanho acinzentado
  "#689f38", // lima
  "#8b7cf6", // violeta claro
  "#3b9be0", // azul-céu
  "#9b4f6b", // vinho
  "#1f9d91", // verde-água
  "#7c3aed", // roxo
  "#b07aa1", // malva
  "#4d72a8", // azul-ardósia
  "#4f9d6e", // verde-mar
  "#5b5fe0", // índigo
] as const;

/** Nome de cada cor da paleta (leitores de ecrã e dicas: «Azul», não «#2563eb»). */
export const NOME_COR_EQUIPA: Record<string, string> = {
  "#2563eb": "Azul",
  "#db2777": "Rosa",
  "#15803d": "Verde",
  "#b02fc4": "Magenta",
  "#0e7490": "Ciano escuro",
  "#8c6e5d": "Castanho acinzentado",
  "#689f38": "Lima",
  "#8b7cf6": "Violeta claro",
  "#3b9be0": "Azul-céu",
  "#9b4f6b": "Vinho",
  "#1f9d91": "Verde-água",
  "#7c3aed": "Roxo",
  "#b07aa1": "Malva",
  "#4d72a8": "Azul-ardósia",
  "#4f9d6e": "Verde-mar",
  "#5b5fe0": "Índigo",
};

const COR_VALIDA = /^#[0-9a-fA-F]{6}$/;

export interface PessoaComCor {
  _id: string;
  cor?: string | null;
}

/** Mapa id → cor (#rrggbb) para todas as pessoas indicadas. */
export function mapaCoresEquipa(pessoas: PessoaComCor[]): Map<string, string> {
  const ordenadas = [...pessoas].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const m = new Map<string, string>();
  ordenadas.forEach((p, i) => {
    m.set(p._id, p.cor && COR_VALIDA.test(p.cor) ? p.cor.toLowerCase() : PALETA_EQUIPA[i % PALETA_EQUIPA.length]);
  });
  return m;
}

/** Texto legível sobre a cor (branco ou quase preto), pela luminância. */
export function textoSobreCor(hex: string): string {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.2 ? "#111827" : "#ffffff";
}
