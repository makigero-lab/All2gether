/**
 * Proxy route: GET /api/auth/sso
 *
 * Single Sign-On (SSO) com o portal Autocell — ponte cross-domain.
 *
 * PROBLEMA QUE RESOLVE:
 *   O backend (Render) e o frontend (Vercel) estão em domínios diferentes.
 *   Cookies httpOnly definidos pelo backend NÃO são guardados pelo browser
 *   para o domínio do frontend. Sem esta proxy, o SSO do backend setava
 *   cookies "órfãos" que o frontend nunca via → sessão nunca iniciada.
 *
 * SOLUÇÃO (arquitetura proxy):
 *   1. O Autocell redireciona o browser do admin para ESTA rota no frontend:
 *        https://all2gether.vercel.app/api/auth/sso?token=<jwt_externo>
 *   2. Esta rota (no MESMO domínio do frontend) faz fetch ao backend em
 *      modo JSON (?json=true) — o backend valida o token SSO e devolve
 *      { sucesso: true, token: <jwt_interno> } SEM setar cookies.
 *   3. Esta rota define os cookies httpOnly no DOMÍNIO do frontend (que o
 *      browser aceita porque é same-origin) e redireciona para /admin.
 *
 * Vantagens:
 *   - Os cookies ficam no domínio do frontend → o middleware do Next.js
 *     consegue lê-los em todos os pedidos subsequentes.
 *   - O token interno nunca é exposto ao browser (httpOnly + sameSite).
 *   - Mantém a retrocompatibilidade: o endpoint do backend continua a
 *     suportar o modo REDIRECT (cookies+redirect) para quem tiver backend
 *     e frontend no mesmo domínio.
 *
 * Segurança:
 *   - secure: NODE_ENV === 'production' (HTTPS obrigatório em prod).
 *   - sameSite: 'lax' — necessário para o redirect top-level do SSO
 *     (Autocell → frontend); 'strict' bloquearia a chegada.
 *   - httpOnly: true — o JS do browser não consegue ler o token (anti-XSS).
 *
 * Erros: qualquer falha (token em falta, backend indisponível, SSO falhado
 *   no backend) redireciona para /login?erro=sso_falhou.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildBackendUrl } from "@/lib/backend";

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 dias (em segundos)

export async function GET(req: Request) {
  // URL canónica de erro de SSO (login com flag de erro).
  const urlErro = new URL("/login?erro=sso_falhou", req.url);

  try {
    // 1. Extrai o token SSO externo da query string.
    const { searchParams } = new URL(req.url);
    const tokenSso = searchParams.get("token");

    if (!tokenSso) {
      console.warn("⚠️  [SSO proxy] token SSO em falta na query string.");
      return NextResponse.redirect(urlErro);
    }

    // 2. Faz fetch ao backend em modo JSON (?json=true).
    //    O backend valida o token SSO com AUTOCELL_SSO_SECRET e devolve o
    //    JWT interno do All2gether SEM setar cookies (o backend não consegue
    //    setar cookies válidos para o domínio do frontend).
    const ssoUrl = buildBackendUrl(
      "/api/auth/sso",
      `?token=${encodeURIComponent(tokenSso)}&json=true`
    );
    if (!ssoUrl) {
      console.warn("⚠️  [SSO proxy] NEXT_PUBLIC_API_URL em falta ou inválida.");
      return NextResponse.redirect(urlErro);
    }

    const backendRes = await fetch(ssoUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    // 3. Se o backend devolver não-OK (401/500/etc.), redireciona para login.
    if (!backendRes.ok) {
      console.warn(
        `⚠️  [SSO proxy] backend devolveu ${backendRes.status} — SSO falhou.`
      );
      return NextResponse.redirect(urlErro);
    }

    const data = await backendRes.json();

    // 4. Valida a resposta do backend (espera { sucesso: true, token: "..." }).
    if (!data?.sucesso || !data?.token) {
      console.warn("⚠️  [SSO proxy] resposta backend sem sucesso/token.");
      return NextResponse.redirect(urlErro);
    }

    // 5. Define os cookies httpOnly no DOMÍNIO do frontend.
    //    sameSite: 'lax' é obrigatório para o redirect top-level do SSO.
    const cookieStore = await cookies();
    const opcoesCookie = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    };

    // Cookie de sessão principal (lido pelo middleware do frontend).
    cookieStore.set("all2gether_token", data.token, opcoesCookie);
    // Cookie de marcação de admin (também serve de backup para impersonação:
    // se este admin impersonar um gestor, o "Voltar a Admin" restaura a partir
    // deste cookie).
    cookieStore.set("all2gether_admin_token", data.token, opcoesCookie);

    console.log("✅ [SSO proxy] sessão de admin iniciada via SSO (Autocell).");

    // 6. Redireciona para o programa operacional (/gestor).
    //
    // Rebrand SSO (satélite single-tenant): este repositório deixou de ser a
    // Nave-Mãe (multi-tenant) e passou a Satélite dedicado à All2gether. O
    // painel /admin (gestão cross-tenant de empresas) deixou de fazer sentido
    // — o Super Admin entra diretamente no programa operacional.
    //
    // A auto-impersonação da empresa principal (para o admin, que é
    // cross-tenant e tem empresa_id = empresa-sistema) é tratada pelo
    // componente <AutoImpersonarEmpresa/> no layout do /gestor.
    return NextResponse.redirect(new URL("/gestor", req.url));
  } catch (err) {
    console.error("❌ [SSO proxy] erro inesperado:", err);
    return NextResponse.redirect(urlErro);
  }
}
