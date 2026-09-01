/**
 * Middleware de Proteção de Rotas — All2gether (Next.js)
 *
 * Executado no Edge (servidor) antes de renderizar qualquer página. Lê o
 * cookie httpOnly `all2gether_token` (o Edge consegue ler cookies httpOnly
 * via req.cookies) e descodifica o payload para saber o role.
 *
 *   1. **Rotas privadas** (`/gestor/*`, `/staff/*`):
 *      - Sem token → redireciona para /login
 *      - Token inválido → redireciona para /login
 *      - Token válido + role errado → redireciona para o painel correto
 *
 *   Rebrand SSO (satélite single-tenant): as rotas /admin/* foram eliminadas
 *   (gestão cross-tenant de empresas deixou de fazer sentido neste
 *   repositório dedicado). O Super Admin entra diretamente em /gestor.
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

const TOKEN_COOKIE = "all2gether_token";

type Role = "admin" | "gestor" | "staff" | "parceiro" | "fornecedor";

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
  // Rebrand SSO (satélite single-tenant): o Super Admin entra diretamente
  // no programa operacional (/gestor). O painel /admin deixou de fazer
  // sentido neste repositório dedicado. A auto-impersonação da empresa
  // principal é tratada no layout do gestor (<AutoImpersonarEmpresa/>).
  // HF27 — Parceiros (B2B) têm portal próprio em /parceiro.
  if (role === "admin") return "/gestor";
  if (role === "gestor") return "/gestor";
  if (role === "parceiro") return "/parceiro";
  if (role === "fornecedor") return "/fornecedor";
  return "/staff";
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(TOKEN_COOKIE)?.value ?? null;
  const payload = token ? descodificarToken(token) : null;
  const autenticado = payload !== null && !!payload.role;

  // --- Rotas privadas ---
  // (Rebrand SSO: /admin/* eliminado — gestão de empresas pertence à Nave-Mãe)
  // HF27 — /parceiro/* é o portal B2B para parceiros externos.
  const isGestor = pathname === "/gestor" || pathname.startsWith("/gestor/");
  const isStaff = pathname === "/staff" || pathname.startsWith("/staff/");
  const isParceiro = pathname === "/parceiro" || pathname.startsWith("/parceiro/");
  // FIX (portal lavandaria) — /fornecedor/* é o portal da lavandaria.
  const isFornecedor = pathname === "/fornecedor" || pathname.startsWith("/fornecedor/");

  // Não aplicar proteção às rotas /api/* (são proxy routes, têm a sua própria lógica).
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (isGestor || isStaff || isParceiro || isFornecedor) {
    if (!autenticado) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = `?from=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(loginUrl);
    }

    const role = payload!.role!;
    const rotaEsperada = rotaPorRole(role);
    // Rebrand SSO (satélite single-tenant): o Super Admin (role 'admin') tem
    // acesso ao programa operacional /gestor — alinha com o backend, onde
    // isGestor = requireRole('admin', 'gestor').
    const rotaErrada =
      (isGestor && role !== "gestor" && role !== "admin") ||
      (isStaff && role !== "staff") ||
      (isParceiro && role !== "parceiro") ||
      (isFornecedor && role !== "fornecedor");
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
  // Rebrand SSO: /admin/:path* removido (páginas eliminadas).
  // HF27 — /parceiro/:path* adicionado (portal B2B).
  matcher: ["/", "/login", "/gestor/:path*", "/staff/:path*", "/parceiro/:path*", "/fornecedor/:path*"],
};
