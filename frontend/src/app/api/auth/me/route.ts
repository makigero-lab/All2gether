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
/** Tempo máximo à espera do backend em /me (o cliente repete se passar). */
const TEMPO_MAX_BACKEND_MS = 20_000;

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

    // Se o backend não responde (arranque a frio do Render demora 30-60 s), não ficamos
    // à espera até a plataforma cortar: devolvemos 504 e o cliente tenta outra vez.
    const res = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TEMPO_MAX_BACKEND_MS),
    });

    // Corpo ilegível (ex.: página HTML de um 502 do Render a acordar) = erro temporário.
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const response = NextResponse.json(
        data ?? { erro: "O servidor não respondeu. Tenta outra vez." },
        { status: res.status }
      );
      // Só apaga o cookie quando o backend diz que NÃO há sessão (401) ou que o utilizador
      // já não existe (404). 5xx, 429 e falhas de rede são temporários: o cookie fica.
      if (res.status === 401 || res.status === 404) response.cookies.delete(COOKIE_NAME);
      return response;
    }

    if (!data) {
      return NextResponse.json({ erro: "Resposta inválida do servidor." }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (e) {
    const expirou = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return NextResponse.json(
      { erro: expirou ? "O servidor está a acordar. Tenta outra vez." : "Erro ao comunicar com o backend." },
      { status: expirou ? 504 : 502 }
    );
  }
}

/** PATCH /api/auth/me — o utilizador atualiza o seu próprio telemóvel. */
export async function PATCH(req: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) {
      return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
    }
    const meUrl = buildBackendUrl("/api/auth/me");
    if (!meUrl) {
      return NextResponse.json({ erro: ERRO_BACKEND_NAO_CONFIGURADO }, { status: 502 });
    }
    const res = await fetch(meUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: await req.text(),
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ erro: "Erro ao comunicar com o backend." }, { status: 502 });
  }
}
