/**
 * Proxy route: POST /api/auth/login
 *
 * Recebe o pedido de login do browser, encaminha-o para o backend
 * (POST /api/auth/login), e guarda o token num cookie **httpOnly**
 * no servidor Next.js. O browser NÃO consegue ler o token (anti-XSS).
 *
 * Devolve ao browser apenas os dados do utilizador (sem o token).
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildBackendUrl,
  ERRO_BACKEND_NAO_CONFIGURADO,
} from "@/lib/backend";

const COOKIE_NAME = "all2gether_token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 dias (em segundos)

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const loginUrl = buildBackendUrl("/api/auth/login");
    if (!loginUrl) {
      return NextResponse.json(
        { erro: ERRO_BACKEND_NAO_CONFIGURADO },
        { status: 502 }
      );
    }

    const res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Guarda o token num cookie httpOnly (o browser não consegue lê-lo).
    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, data.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    // Prompt 113 — Num login fresco, limpa qualquer cookie de backup de
    // admin que tenha ficado de uma impersonação anterior.
    cookieStore.delete("all2gether_admin_token");

    // Devolve ao browser apenas os dados do utilizador (sem o token).
    return NextResponse.json({ utilizador: data.utilizador });
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}
