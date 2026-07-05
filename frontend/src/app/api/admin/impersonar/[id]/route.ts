/**
 * Proxy route: POST /api/admin/impersonar/:id
 *
 * Permite ao Super Admin "entrar como" o gestor de uma empresa.
 *
 * Fluxo:
 *   1. Lê o cookie httpOnly do Super Admin (token atual).
 *   2. Faz POST /api/admin/empresas/:id/impersonar no backend (com o token do admin).
 *   3. O backend devolve um NOVO token JWT do gestor.
 *   4. Substitui o cookie httpOnly pelo novo token (do gestor).
 *   5. Devolve os dados do gestor ao browser.
 *
 * O browser faz então window.location.href = '/gestor' e o sistema
 * passa a tratar o Super Admin como o Gestor daquela empresa.
 *
 * Para voltar a ser Super Admin: Terminar Sessão + login novamente.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "autocell_token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 dias

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const cookieStore = await cookies();
    const adminToken = cookieStore.get(COOKIE_NAME)?.value;

    if (!adminToken) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    // Chama o backend com o token do Super Admin.
    const res = await fetch(
      `${BACKEND_URL}/api/admin/empresas/${id}/impersonar`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        cache: "no-store",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Substitui o cookie httpOnly pelo novo token (do gestor).
    cookieStore.set(COOKIE_NAME, data.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    // Devolve ao browser os dados do gestor (sem o token).
    return NextResponse.json({
      utilizador: data.utilizador,
      empresa: data.empresa,
      impersonado: true,
    });
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}
