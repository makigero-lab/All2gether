/**
 * Funções puras das sugestões de morada (Google Places) e do pino no mapa.
 * Sem dependências do Google: testáveis em Node.
 */

/** Localização escolhida numa sugestão do Google (enviada ao servidor ao gravar). */
export interface EscolhaMorada {
  lat: number;
  lng: number;
  /** Tipos do lugar (street_address, premise, route...): o servidor decide a precisão. */
  tipos: string[];
}

/** Lisboa: centro do mapa quando ainda não há coordenadas. */
export const LISBOA = { lat: 38.7223, lng: -9.1393 } as const;

/** Tira o país no fim («…, Amadora, Portugal» → «…, Amadora»). */
export function limparPais(formatada: string): string {
  return String(formatada ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,\s]+portugal\s*$/i, "")
    .trim();
}

interface ComponenteMorada {
  types?: string[];
}

/**
 * Tipos do lugar escolhido. Usa os da sugestão; se vierem vazios, deduz
 * «street_address» quando a morada tem rua e número (addressComponents).
 */
export function tiposDoLugar(tipos: readonly string[] | undefined | null, componentes?: readonly ComponenteMorada[] | null): string[] {
  const dados = (tipos ?? []).filter((t) => typeof t === "string" && t.length > 0);
  if (dados.length > 0) return [...dados];
  const tem = (t: string) => (componentes ?? []).some((c) => (c.types ?? []).includes(t));
  return tem("route") && tem("street_number") ? ["street_address"] : [];
}

/** «38.7536, -9.2302» → coordenadas (só o formato que o ecrã escreve) ou null. */
export function lerCoordenadas(texto: string | null | undefined): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(texto ?? ""));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Coordenadas em texto («38.753600, -9.230200»), como o servidor as lê. */
export function formatarCoordenadas(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}
