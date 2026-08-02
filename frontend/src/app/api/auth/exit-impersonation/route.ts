/**
 * Proxy route: POST /api/auth/exit-impersonation
 *
 * Restauração da sessão de Super Admin após impersonação.
 *
 * Quando o admin impersona um gestor (POST /api/admin/impersonar/:id), o
 * cookie principal `all2gether_token` é substituído pelo token do gestor, mas
 * o token de admin original é guardado em `all2gether_admin_token`.
 *
 * Este endpoint reverte a troca:
 *   1. Lê `all2gether_admin_token`.
 *   2. Se existir, copia-o de volta para `all2gether_token` e apaga
 *      `all2gether_admin_token`.
 *   3. Se NÃO existir (não há impersonação ativa), devolve 400.
 *
 * O browser chama isto ao clicar em "Sair da empresa" no banner de
 * impersonação (rebrand satélite single-tenant — o painel /admin deixou de
 * existir neste repositório, pelo que "sair" significa logout + /login).
 *
 * Prompt 113.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "all2gether_token";
const ADMIN_COOKIE_NAME = "all2gether_admin_token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 dias

export async function POST() {
  try {
    const cookieStore = await cookies();
    const adminToken = cookieStore.get(ADMIN_COOKIE_NAME)?.value;

    if (!adminToken) {
      return NextResponse.json(
        { erro: "Não há sessão de admin para restaurar." },
        { status: 400 }
      );
    }

    // Restaura o token de admin no cookie principal.
    cookieStore.set(COOKIE_NAME, adminToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    // Apaga o cookie de admin guardado (já foi restaurado).
    cookieStore.delete(ADMIN_COOKIE_NAME);

    return NextResponse.json({ sucesso: true });
  } catch {
    return NextResponse.json(
      { erro: "Erro ao restaurar a sessão de admin." },
      { status: 500 }
    );
  }
}
