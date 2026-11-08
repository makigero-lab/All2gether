/**
 * Utilitários partilhados pelos proxies /api/gestor e /api/parceiro.
 *
 *  - segmentosSeguros: impede path traversal (`..`, `%2f`, caracteres estranhos)
 *    para o proxy nunca sair do prefixo /api/<área> do backend.
 *  - lerCorpo: preserva corpos binários (upload .xlsx) em vez de os forçar a texto.
 *  - responderBackend: devolve respostas não-JSON (download .xlsx) sem rebentar.
 */

import { NextResponse } from "next/server";

const SEGMENTO_VALIDO = /^[A-Za-z0-9_\-:.@]+$/;

export function segmentosSeguros(path: string[]): boolean {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((s) => s !== "." && s !== ".." && SEGMENTO_VALIDO.test(s))
  );
}

/** Corpo + Content-Type a reencaminhar para o backend. */
export async function lerCorpo(
  req: Request
): Promise<{ body: string | ArrayBuffer; contentType: string }> {
  const ct = req.headers.get("content-type") || "";
  const ehJson = ct === "" || ct.toLowerCase().includes("application/json");
  if (ehJson) {
    return { body: await req.text(), contentType: "application/json" };
  }
  return { body: await req.arrayBuffer(), contentType: ct };
}

/** Converte a resposta do backend numa NextResponse (JSON ou binário). */
export async function responderBackend(
  res: Response,
  cookieName: string
): Promise<NextResponse> {
  const ct = res.headers.get("content-type") || "";
  let response: NextResponse;

  const anexo = (res.headers.get("content-disposition") || "").toLowerCase().startsWith("attachment");

  if (anexo && res.ok && res.body) {
    // Ficheiro para descarregar (ex.: exportação RGPD, que pode ser grande): passa em streaming,
    // sem o ler para memória nem o reescrever.
    const headers = new Headers();
    if (ct) headers.set("Content-Type", ct);
    headers.set("Content-Disposition", res.headers.get("content-disposition") as string);
    headers.set("Cache-Control", "no-store");
    return new NextResponse(res.body, { status: res.status, headers });
  }

  if (ct.toLowerCase().includes("application/json")) {
    const data = await res.json();
    response = NextResponse.json(data, { status: res.status });
  } else {
    const buf = await res.arrayBuffer();
    const headers = new Headers();
    if (ct) headers.set("Content-Type", ct);
    const cd = res.headers.get("content-disposition");
    if (cd) headers.set("Content-Disposition", cd);
    headers.set("Cache-Control", "no-store");
    response = new NextResponse(buf, { status: res.status, headers });
  }

  // Token expirado/inválido: limpa o cookie.
  if (res.status === 401) {
    response.cookies.delete(cookieName);
  }
  return response;
}
