/**
 * Descarregar um ficheiro devolvido pela API (via proxy same-origin, com o cookie httpOnly).
 * Usado nas exportações RGPD (os meus dados, dados de uma pessoa, dados de uma empresa).
 */

/** Nome do ficheiro a partir do Content-Disposition (só nomes simples); senão o nome por omissão. */
export function nomeDoFicheiro(contentDisposition: string | null, padrao: string): string {
  const m = /filename="([A-Za-z0-9._-]{1,120})"/.exec(contentDisposition ?? "");
  return m ? m[1] : padrao;
}

export async function descarregarFicheiro(url: string, nomePadrao: string): Promise<void> {
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
  if (!res.ok) {
    let mensagem = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.erro) mensagem = data.erro;
    } catch {
      /* corpo não-JSON */
    }
    throw new Error(mensagem);
  }
  const nome = nomeDoFicheiro(res.headers.get("content-disposition"), nomePadrao);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}
