/**
 * Google Maps no browser (Maps JavaScript API + Places API New).
 *
 * Só existe se NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY estiver definida (chave de
 * browser, restrita por referrer e às APIs Maps JavaScript + Places New). Sem
 * ela, googleMapsDisponivel() é false e as sugestões e o mapa ficam escondidos.
 * O script só é carregado quando é preciso (ao focar o campo morada ou ao abrir
 * o mapa), nunca no arranque da página.
 */

const CHAVE = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

/** Canal fixo da API (não «weekly»): atualizações só de 3 em 3 meses. */
const VERSAO_API = "quarterly";

let promessa: Promise<typeof google.maps> | null = null;

/** true se há chave de browser configurada. */
export function googleMapsDisponivel(): boolean {
  return typeof CHAVE === "string" && CHAVE.trim() !== "";
}

/** Carrega o script do Google (uma só vez) e devolve `google.maps`. */
export function carregarGoogleMaps(): Promise<typeof google.maps> {
  if (!googleMapsDisponivel()) return Promise.reject(new Error("Google Maps não está configurado."));
  if (promessa) return promessa;
  promessa = new Promise<typeof google.maps>((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Google Maps só carrega no browser."));
      return;
    }
    if (typeof window.google?.maps?.importLibrary === "function") {
      resolve(window.google.maps);
      return;
    }
    // Chave recusada (referrer não autorizado, API não ativada, sem faturação...).
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      promessa = null;
      reject(new Error("O Google Maps recusou a chave."));
    };
    const s = document.createElement("script");
    s.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(String(CHAVE).trim())}` +
      `&v=${VERSAO_API}&loading=async&language=pt-PT&region=PT`;
    s.async = true;
    s.onload = () => {
      if (typeof window.google?.maps?.importLibrary === "function") resolve(window.google.maps);
      else {
        promessa = null;
        reject(new Error("O Google Maps não arrancou."));
      }
    };
    s.onerror = () => {
      promessa = null;
      reject(new Error("Não foi possível carregar o Google Maps."));
    };
    document.head.appendChild(s);
  });
  return promessa;
}
