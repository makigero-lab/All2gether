/**
 * Proxy route: POST /api/admin/impersonar/:id
 *
 * Permite ao Super Admin "entrar como" o gestor de uma empresa.
 *
 * Fluxo:
 *   1. Lê o cookie httpOnly do Super Admin (token atual).
 *   2. Faz POST /api/admin/empresas/:id/impersonar no backend (com o token do admin).
 *   3. O backend devolve um NOVO token JWT do gestor.
 *   4. Guarda o token de admin atual num cookie httpOnly separado
 *      `fisiocell_admin_token` (para poder restaurar a sessão de admin depois).
 *   5. Substitui o cookie httpOnly principal pelo novo token (do gestor).
 *   6. Devolve os dados do gestor ao browser.
 *
 * O browser faz então window.location.href = '/gestor' e o sistema
 * passa a tratar o Super Admin como o Gestor daquela empresa.
 *
 * Para voltar a ser Super Admin: POST /api/auth/exit-impersonation (restaura
 * o cookie `fisiocell_token` a partir do `fisiocell_admin_token` guardado).
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "fisiocell_token";
const ADMIN_COOKIE_NAME = "fisiocell_admin_token";
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

    // Prompt 113 — Guarda o token de admin atual num cookie separado para
    // permitir "Voltar a Admin" sem re-login. Só guarda se ainda não houver
    // um admin_token guardado (evita encadear impersonações).
    if (!cookieStore.get(ADMIN_COOKIE_NAME)?.value) {
      cookieStore.set(ADMIN_COOKIE_NAME, adminToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
      });
    }

    // Substitui o cookie httpOnly principal pelo novo token (do gestor).
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
