/**
 * Catch-all proxy: /api/parceiro/[...path]
 *
 * Encaminha pedidos para /api/parceiro/* do frontend para o backend,
 * injetando o token JWT do cookie httpOnly no header Authorization.
 *
 * FIX (portal parceiro) — Cria o proxy que faltava para que as páginas
 * /parceiro/tarefas e /parceiro/reservas consigam chamar a API do backend.
 *
 * Métodos suportados: GET, POST, PUT, PATCH, DELETE.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildBackendUrl,
  ERRO_BACKEND_NAO_CONFIGURADO,
} from "@/lib/backend";
import {
  lerCorpo,
  responderBackend,
  segmentosSeguros,
} from "@/lib/proxy-utils";

const COOKIE_NAME = "all2gether_token";

async function proxyHandler(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    if (!segmentosSeguros(path)) {
      return NextResponse.json({ erro: "Caminho inválido." }, { status: 400 });
    }
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
    let body: string | ArrayBuffer | undefined;
    if (method !== "GET" && method !== "DELETE") {
      const corpo = await lerCorpo(req);
      headers["Content-Type"] = corpo.contentType;
      body = corpo.body;
    }

    const url = new URL(req.url);
    const queryString = url.search;
    const backendUrl = buildBackendUrl(`/api/parceiro/${pathString}`, queryString);

    if (!backendUrl) {
      return NextResponse.json(
        { erro: ERRO_BACKEND_NAO_CONFIGURADO },
        { status: 502 }
      );
    }

    const res = await fetch(backendUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });

    return responderBackend(res, COOKIE_NAME);
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
