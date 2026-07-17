/**
 * Catch-all proxy: /api/auth/me/[...path]
 *
 * Encaminha pedidos para /api/auth/me/* (tarefas, calendario, concluir, etc.)
 * do frontend para o backend, injetando o token JWT do cookie httpOnly.
 *
 * Isto permite que o browser aceda a endpoints como:
 *   GET  /api/auth/me/tarefas
 *   GET  /api/auth/me/tarefas/:id
 *   PATCH /api/auth/me/tarefas/:id/concluir
 *   GET  /api/auth/me/calendario
 *
 * sem nunca ter acesso ao token (cookie httpOnly).
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

    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;

    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    const method = req.method;
    let body: string | undefined;
    if (method !== "GET" && method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = await req.text();
    }

    const url = new URL(req.url);
    const queryString = url.search;
    const backendUrl = `${BACKEND_URL}/api/auth/me/${pathString}${queryString}`;

    const res = await fetch(backendUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });

    const data = await res.json();

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
