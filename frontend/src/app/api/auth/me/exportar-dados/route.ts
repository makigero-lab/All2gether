/**
 * Proxy route: GET /api/auth/me/exportar-dados
 *
 * RGPD: o próprio utilizador descarrega os seus dados pessoais (JSON). Lê o token do cookie
 * httpOnly e devolve o ficheiro tal como vem do backend (com Content-Disposition).
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildBackendUrl, ERRO_BACKEND_NAO_CONFIGURADO } from "@/lib/backend";
import { responderBackend } from "@/lib/proxy-utils";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "all2gether_token";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) {
      return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
    }
    const url = buildBackendUrl("/api/auth/me/exportar-dados");
    if (!url) {
      return NextResponse.json({ erro: ERRO_BACKEND_NAO_CONFIGURADO }, { status: 502 });
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    return responderBackend(res, COOKIE_NAME);
  } catch {
    return NextResponse.json({ erro: "Erro ao comunicar com o backend." }, { status: 502 });
  }
}
