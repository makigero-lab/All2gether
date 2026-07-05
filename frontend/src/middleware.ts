/**
 * Middleware de Proteção de Rotas — Autocell (Next.js)
 *
 * Executado no Edge (servidor) antes de renderizar qualquer página. Lê o
 * cookie httpOnly `autocell_token` (o Edge consegue ler cookies httpOnly
 * via req.cookies) e descodifica o payload para saber o role.
 *
 *   1. **Rotas privadas** (`/admin/*`, `/gestor/*`, `/staff/*`):
 *      - Sem token → redireciona para /login
 *      - Token inválido → redireciona para /login
 *      - Token válido + role errado → redireciona para o painel correto
 *
 *   2. **Rotas públicas para autenticados** (`/`, `/login`):
 *      - Com token válido → redireciona para o painel do role
 *      - Sem token → deixa passar
 *
 * NOTA: o middleware NÃO verifica a assinatura do JWT (seria arriscado no
 * Edge). Valida apenas formato + expiração. A verificação real é feita pelo
 * backend (ou pelo proxy /api/gestor/[...path]) em cada pedido à API.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const TOKEN_COOKIE = "autocell_token";

type Role = "admin" | "gestor" | "staff";

interface JwtPayload {
  id?: string;
  role?: Role;
  empresa_id?: string;
  exp?: number;
}

/** Descodifica o payload do JWT (base64url) SEM verificar a assinatura. */
function descodificarToken(token: string): JwtPayload | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;

  try {
    const base64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const payload = JSON.parse(json) as JwtPayload;

    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function rotaPorRole(role: Role): string {
  if (role === "admin") return "/admin";
  if (role === "gestor") return "/gestor";
  return "/staff";
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(TOKEN_COOKIE)?.value ?? null;
  const payload = token ? descodificarToken(token) : null;
  const autenticado = payload !== null && !!payload.role;

  // --- Rotas privadas ---
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const isGestor = pathname === "/gestor" || pathname.startsWith("/gestor/");
  const isStaff = pathname === "/staff" || pathname.startsWith("/staff/");

  // Não aplicar proteção às rotas /api/* (são proxy routes, têm a sua própria lógica).
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (isAdmin || isGestor || isStaff) {
    if (!autenticado) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = `?from=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(loginUrl);
    }

    const role = payload!.role!;
    const rotaEsperada = rotaPorRole(role);
    const rotaErrada =
      (isAdmin && role !== "admin") ||
      (isGestor && role !== "gestor") ||
      (isStaff && role !== "staff");
    if (rotaErrada) {
      const url = req.nextUrl.clone();
      url.pathname = rotaEsperada;
      url.search = "";
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  // --- Rotas públicas para autenticados: / e /login ---
  if (autenticado && (pathname === "/" || pathname === "/login")) {
    const url = req.nextUrl.clone();
    url.pathname = rotaPorRole(payload!.role!);
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/admin/:path*", "/gestor/:path*", "/staff/:path*"],
};
