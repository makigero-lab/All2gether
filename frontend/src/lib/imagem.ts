/**
 * Compressão de fotos no cliente (staff em telemóvel).
 * Fotos de câmara pesam 3–8 MB; reduzimos para ~1600 px / JPEG 0.7 antes de
 * converter para base64, para caberem no payload JSON sem falhar em silêncio.
 */

const LADO_MAX = 1600;
const QUALIDADE = 0.7;
/** Limite do resultado comprimido (≈ 1.5 MB de imagem). */
export const TAMANHO_MAX_BYTES = 1.5 * 1024 * 1024;

export type ResultadoImagem =
  | { ok: true; dataUrl: string }
  | { ok: false; erro: string };

function carregar(ficheiro: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(ficheiro);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("imagem ilegível"));
    };
    img.src = url;
  });
}

export async function comprimirImagem(ficheiro: File): Promise<ResultadoImagem> {
  if (!ficheiro.type.startsWith("image/")) {
    return { ok: false, erro: `"${ficheiro.name}" não é uma imagem.` };
  }
  try {
    const img = await carregar(ficheiro);
    const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * escala));
    const h = Math.max(1, Math.round(img.height * escala));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas indisponível");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALIDADE);
    // base64 ≈ 4/3 do binário.
    if (dataUrl.length * 0.75 > TAMANHO_MAX_BYTES) {
      return { ok: false, erro: `"${ficheiro.name}" continua demasiado grande. Tenta uma foto mais simples.` };
    }
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, erro: `Não foi possível processar "${ficheiro.name}".` };
  }
}
