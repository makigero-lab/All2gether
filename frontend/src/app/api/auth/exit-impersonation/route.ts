/**
 * Proxy route: POST /api/auth/exit-impersonation
 *
 * Restauração da sessão de Super Admin após impersonação.
 *
 * Quando o admin impersona um gestor (POST /api/admin/impersonar/:id), o
 * cookie principal `autocell_token` é substituído pelo token do gestor, mas
 * o token de admin original é guardado em `autocell_admin_token`.
 *
 * Este endpoint reverte a troca:
 *   1. Lê `autocell_admin_token`.
 *   2. Se existir, copia-o de volta para `autocell_token` e apaga
 *      `autocell_admin_token`.
 *   3. Se NÃO existir (não há impersonação ativa), devolve 400.
 *
 * O browser chama isto ao clicar em "Voltar a Admin" no banner de
 * impersonação, e depois faz window.location.href = '/admin'.
 *
 * Prompt 113.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "autocell_token";
const ADMIN_COOKIE_NAME = "autocell_admin_token";
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
