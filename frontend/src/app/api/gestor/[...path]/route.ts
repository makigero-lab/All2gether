/**
 * Catch-all proxy route: /api/gestor/[...path]
 *
 * Encaminha TODOS os pedidos para /api/gestor/* do frontend para o backend,
 * injetando o token JWT do cookie httpOnly no header Authorization.
 *
 * Isto significa que o browser NUNCA tem acesso ao token — o token vive
 * exclusivamente no cookie httpOnly, e apenas o servidor Next.js o lê
 * para adicionar o header ao encaminhar para o backend.
 *
 * Métodos suportados: GET, POST, PUT, PATCH, DELETE.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "fisiocell_token";

async function proxyHandler(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const pathString = path.join("/");

    // Lê o token do cookie httpOnly.
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;

    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    // Constrói os headers para o backend.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    // Se houver body (POST/PUT/PATCH), copia o Content-Type e o corpo.
    const method = req.method;
    let body: string | undefined;
    if (method !== "GET" && method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = await req.text();
    }

    // Encaminha para o backend (incluindo query params).
    const url = new URL(req.url);
    const queryString = url.search; // preserva ?futuras=true etc.
    const backendUrl = `${BACKEND_URL}/api/gestor/${pathString}${queryString}`;

    const res = await fetch(backendUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });

    const data = await res.json();

    // Se 401, o token pode estar expirado — limpa o cookie.
    const response = NextResponse.json(data, { status: res.status });
    if (res.status === 401) {
      response.cookies.delete(COOKIE_NAME);
    }
    return response;
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}

export const GET = proxyHandler;
export const POST = proxyHandler;
export const PUT = proxyHandler;
export const PATCH = proxyHandler;
export const DELETE = proxyHandler;
