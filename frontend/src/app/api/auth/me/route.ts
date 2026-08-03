/**
 * Proxy route: GET /api/auth/me
 *
 * Lê o token do cookie httpOnly (que o browser não consegue ler), envia-o
 * ao backend (GET /api/auth/me com Authorization: Bearer) e devolve os
 * dados do utilizador. Permite que os componentes client-side saibam quem
 * está autenticado sem terem acesso ao token.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildBackendUrl,
  ERRO_BACKEND_NAO_CONFIGURADO,
} from "@/lib/backend";

const COOKIE_NAME = "all2gether_token";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;

    if (!token) {
      return NextResponse.json(
        { erro: "Não autenticado." },
        { status: 401 }
      );
    }

    const meUrl = buildBackendUrl("/api/auth/me");
    if (!meUrl) {
      return NextResponse.json(
        { erro: ERRO_BACKEND_NAO_CONFIGURADO },
        { status: 502 }
      );
    }

    const res = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      // Token inválido/expirado — limpa o cookie.
      const response = NextResponse.json(data, { status: res.status });
      response.cookies.delete(COOKIE_NAME);
      return response;
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}
