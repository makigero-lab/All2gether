/** Aviso de horário/agenda com a ação confirmada à frente: «Limpeza criada. Fica fora do horário de trabalho (…).» */
export function avisoComAcao(acao: string, ...avisos: (string | null | undefined)[]): string {
  const texto = avisos.filter((a): a is string => typeof a === "string" && a.trim().length > 0).join(" | ");
  return texto ? `${acao} ${texto}` : "";
}
