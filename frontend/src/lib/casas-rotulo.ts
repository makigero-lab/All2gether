/**
 * Rótulo único das casas nas listas do gestor (limpezas, calendário, filtros, seletores): casas com o mesmo nome
 * distinguem-se pela rua/localidade, com a MESMA regra do assistente Ligar (`distinguirCasas` em integracoes/tipos).
 */
import { nomesDistintos } from "@/components/gestor/integracoes/tipos";

/** O que a API dá de uma casa: a lista de propriedades (morada estruturada ou livre) ou a casa de uma tarefa (morada curta). */
export interface CasaDaApi {
  _id?: string;
  nome: string;
  morada?: string | null;
  morada_estruturada?: { rua?: string | null; cidade?: string | null } | null;
  morada_curta?: string | null;
  morada_rua?: string | null;
  morada_localidade?: string | null;
}

/** Mapa _id -> rótulo («Casa Azul (Rua Augusta)» se o nome se repete) para um conjunto de casas. */
export function rotulosDeCasas(casas: CasaDaApi[]): Map<string, string> {
  const nomeaveis = casas
    .filter((c): c is CasaDaApi & { _id: string } => typeof c._id === "string" && c._id.length > 0)
    .map((c) => ({
      _id: c._id,
      nome: c.nome,
      morada_curta: c.morada_curta ?? c.morada ?? null,
      morada_rua: c.morada_rua ?? c.morada_estruturada?.rua ?? null,
      morada_localidade: c.morada_localidade ?? c.morada_estruturada?.cidade ?? null,
    }));
  return nomesDistintos(nomeaveis);
}

/** Rótulo de uma casa: o do mapa, ou o nome simples (casa desconhecida/sem _id). */
export function rotuloDaCasa(mapa: Map<string, string>, casa: { _id?: string; nome?: string } | null | undefined): string {
  if (!casa) return "—";
  return (casa._id && mapa.get(casa._id)) || casa.nome || "—";
}

/** A tarefa é da casa escolhida? Compara por _id, nunca por nome (casas homónimas). Sem casa escolhida: passa. */
export function tarefaDaCasa(tarefa: { propriedade_id?: { _id?: string } | null }, casaId: string): boolean {
  if (!casaId) return true;
  return tarefa.propriedade_id?._id === casaId;
}
