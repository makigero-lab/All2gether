/**
 * Proxy route: POST /api/auth/logout
 *
 * Limpa o cookie httpOnly que guarda o token JWT. Como o token vive
 * exclusivamente no cookie httpOnly, o cliente não consegue removê-lo
 * diretamente — tem de passar por esta rota de servidor.
 *
 * Prompt 113 — Limpa também o cookie de backup de admin (`autocell_admin_token`)
 * para não deixar sessões de impersonação órfãs.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "autocell_token";
const ADMIN_COOKIE_NAME = "autocell_admin_token";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(ADMIN_COOKIE_NAME);

  return NextResponse.json({ mensagem: "Logout efetuado com sucesso." });
}
