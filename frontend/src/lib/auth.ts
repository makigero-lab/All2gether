/**
 * Utilitários de Autenticação (frontend) — Autocell
 *
 * v1.14.0 — Cookie HttpOnly:
 *   O token JWT vive EXCLUSIVAMENTE num cookie httpOnly definido pelo
 *   servidor Next.js (via /api/auth/login route handler). O browser
 *   NÃO consegue ler o token (anti-XSS). Todas as verificações de auth
 *   no client-side passam por fetch a /api/auth/me (proxy que lê o
 *   cookie no servidor e consulta o backend).
 *
 *   - Login: POST /api/auth/login (proxy define cookie httpOnly)
 *   - Logout: POST /api/auth/logout (proxy limpa cookie httpOnly)
 *   - Verificar auth: GET /api/auth/me (proxy lê cookie, consulta backend)
 *
 *   O middleware.ts (Edge) ainda consegue ler o cookie httpOnly diretamente
 *   (Edge runtime tem acesso a req.cookies), pelo que a proteção de rotas
 *   não precisa de fetch assíncrono.
 */

export type Role = "admin" | "gestor" | "staff";

export interface UtilizadorAuth {
  id: string;
  nome: string;
  email: string;
  role: Role;
  empresa_id: string;
}

/**
 * Consulta o backend (via proxy /api/auth/me) para saber se o utilizador
 * está autenticado e qual o seu role. O token é lido do cookie httpOnly
 * no servidor — o browser nunca o vê.
 *
 * Devolve null se não estiver autenticado (sem cookie, token inválido, etc.).
 *
 * v1.59.0 (Prompt 81) — Em caso de 401 (token expirado/inválido), se NÃO
 * estivermos já em /login, redireciona para /login para evitar loops de
 * chamadas autenticadas falhadas. Isto resolve o problema de o utilizador
 * ficar preso numa página protegida após expirar a sessão, com dezenas de
 * pedidos 401 acumulados no console.
 */
export async function lerUtilizador(): Promise<UtilizadorAuth | null> {
  try {
    const res = await fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "include",
    });

    if (!res.ok) {
      // 401 = token expirado ou inválido. Redireciona para login se não
      // estivermos já lá (evita loop na própria página de login).
      if (res.status === 401 && typeof window !== "undefined") {
        const pathname = window.location.pathname;
        if (pathname !== "/login" && pathname !== "/") {
          // Adiciona ?from= para o utilizador voltar após login.
          const from = encodeURIComponent(pathname + window.location.search);
          window.location.href = `/login?from=${from}`;
        }
      }
      return null;
    }

    const data = await res.json();
    if (!data?.utilizador) return null;

    return data.utilizador as UtilizadorAuth;
  } catch {
    return null;
  }
}

/** True se o utilizador estiver autenticado (verifica via /api/auth/me). */
export async function estaAutenticado(): Promise<boolean> {
  return (await lerUtilizador()) !== null;
}

/**
 * Termina a sessão do utilizador.
 *
 * Chama a rota de API /api/auth/logout (que limpa o cookie httpOnly no
 * servidor) e depois redireciona o browser para /login.
 *
 * Usa `window.location.href` (em vez de router.push) para garantir que
 * o estado do cliente é totalmente limpo (sem cache de dados do utilizador
 * anterior).
 */
export async function fazerLogout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Mesmo que o fetch falhe, tentamos redirecionar (o middleware vai
    // bloquear o acesso às páginas privadas sem cookie).
  }
  window.location.href = "/login";
}

/**
 * Determina para onde redirecionar o utilizador após login, com base no role.
 * - admin   -> /admin   (Super Admin — painel de administração)
 * - gestor  -> /gestor  (Gestor de Operações — painel operacional)
 * - staff   -> /staff    (executante de limpezas)
 */
export function rotaPorRole(role: Role): string {
  if (role === "admin") return "/admin";
  if (role === "gestor") return "/gestor";
  return "/staff";
}

/* ------------------------------------------------------------------ */
/* Funções legacy (mantidas para compatibilidade do middleware.ts Edge) */
/* ------------------------------------------------------------------ */
// O middleware.ts (Edge) ainda lê o cookie httpOnly diretamente via
// req.cookies.get() — não precisa de fetch. Estas funções são usadas
// APENAS pelo middleware e permanecem síncronas.

export interface JwtPayload {
  id: string;
  role: Role;
  empresa_id: string;
  iat?: number;
  exp?: number;
}

/**
 * Descodifica o payload do JWT a partir de uma string de token.
 * Usado pelo middleware.ts (Edge) que lê o cookie httpOnly diretamente.
 * NÃO faz fetch — recebe o token já extraído do cookie pelo middleware.
 *
 * Devolve null se o token for inválido ou estiver expirado.
 */
export function descodificarToken(token: string): JwtPayload | null {
  if (!token) return null;

  const partes = token.split(".");
  if (partes.length !== 3) return null;

  try {
    const base64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    const payload = JSON.parse(json) as JwtPayload;

    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
