/**
 * Limpeza provisória por falta de data de saída (reserva do Smoobu sem departure e sem conseguir consultá-la):
 * a limpeza fica no dia de chegada, por atribuir, com o motivo. O gestor tem de ver, em todas as vistas,
 * «Data de saída por confirmar» (em vez de «Por atribuir») e o motivo. Este módulo é a única fonte dos textos
 * e das regras; os componentes só o usam (sem decidir por palavras do texto do aviso).
 */

export const ROTULO_SAIDA_POR_CONFIRMAR = "Data de saída por confirmar";

export interface CamposSaida {
  estado?: string;
  data_saida_desconhecida?: boolean;
  motivo_nao_atribuicao?: string | null;
}

const POR_ATRIBUIR = ["por_atribuir", "nao_atribuida"];
const FECHADAS = ["concluida", "cancelada"];

/** A data desta limpeza é provisória (e a limpeza ainda conta). */
export function saidaPorConfirmar(t: CamposSaida): boolean {
  return t.data_saida_desconhecida === true && !FECHADAS.includes(t.estado ?? "");
}

/** O rótulo substitui «Por atribuir» (limpeza ainda sem pessoa). */
export function rotuloSubstituiEstado(t: CamposSaida): boolean {
  return saidaPorConfirmar(t) && POR_ATRIBUIR.includes(t.estado ?? "");
}

/** «Data de saída por confirmar: <motivo>» (ou só o rótulo); null se a data não é provisória. */
export function textoSaidaPorConfirmar(t: CamposSaida): string | null {
  if (!saidaPorConfirmar(t)) return null;
  const motivo = (t.motivo_nao_atribuicao ?? "").trim();
  return motivo ? `${ROTULO_SAIDA_POR_CONFIRMAR}. ${motivo}` : ROTULO_SAIDA_POR_CONFIRMAR;
}

/** Motivo para mostrar por baixo da casa; null se não há motivo ou a data não é provisória. */
export function motivoSaida(t: CamposSaida): string | null {
  if (!saidaPorConfirmar(t)) return null;
  const motivo = (t.motivo_nao_atribuicao ?? "").trim();
  return motivo || null;
}
