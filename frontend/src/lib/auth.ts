/**
 * Utilitários de Autenticação (frontend) — FisioCell
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
 *
 * Prompt 113 — FIX DO LOOP 401 (iteração 2 — mais robusta):
 *   A iterção 1 (Prompt 113) fez lerUtilizador() pura + cache in-flight.
 *   Mas o cache in-flight só deduplica chamadas CONCORRENTES (mesmo tick).
 *   Chamadas SEQUENCIAIS rápidas (ex.: redirect /admin → /login → /admin
 *   em milissegundos) continuavam a bater no backend, gerando dezenas de
 *   401 no console.
 *
 *   Esta iteração adiciona um **cache temporal**:
 *     - Resultado POSITIVO (user): cache 60s → reduz fetches redundantes
 *       durante navegação normal (RouteGuard + página + sub-componentes).
 *     - Resultado NEGATIVO (null/401): cache 3s → bloqueia re-fetches
 *       rápidos durante cascata de redirects, SEM bloquear login (o cache
 *       é limpo por limparCacheAuth() no momento do login com sucesso).
 *
 *   Além disso, limparCacheAuth() é exportado para ser chamado pelo
 *   login page (após cookie definido) e pelo logout (após cookie limpo).
 */

export type Role = "admin" | "gestor" | "staff";

export interface UtilizadorAuth {
  id: string;
  nome: string;
  email: string;
  role: Role;
  empresa_id: string;
}

/* ------------------------------------------------------------------ */
/* Cache temporal de auth (Prompt 113, iteração 2)                     */
/* ------------------------------------------------------------------ */

// Resultado em cache + timestamp de expiração.
interface CacheEntry {
  user: UtilizadorAuth | null;
  expiraEm: number; // epoch ms
}

let cache: CacheEntry | null = null;
let inFlight: Promise<UtilizadorAuth | null> | null = null;

const TTL_POSITIVO_MS = 60_000; // 60s — user válido
const TTL_NEGATIVO_MS = 3_000; // 3s — 401 (curto para não bloquear login)

/**
 * Limpa o cache de auth. DEVE ser chamado:
 *   - Após login com sucesso (antes do redirect para o painel)
 *   - Após logout (antes do redirect para /login)
 *   - Após exit-impersonation (cookie mudou)
 *
 * Isto garante que a próxima chamada a lerUtilizador() vai ao backend
 * buscar o estado real (em vez de devolver um resultado obsoleto).
 */
export function limparCacheAuth(): void {
  cache = null;
  inFlight = null;
}

function cacheValido(): CacheEntry | null {
  if (!cache) return null;
  if (Date.now() >= cache.expiraEm) {
    cache = null;
    return null;
  }
  return cache;
}

/**
 * Consulta o backend (via proxy /api/auth/me) para saber se o utilizador
 * está autenticado e qual o seu role. O token é lido do cookie httpOnly
 * no servidor — o browser nunca o vê.
 *
 * Devolve null se não estiver autenticado (sem cookie, token inválido, etc.).
 *
 * Cache:
 *   - Se houver um resultado em cache válido (dentro do TTL), devolve-o
 *     SEM ir ao backend.
 *   - Se já houver um pedido em curso (in-flight), partilha a mesma
 *     Promise (dedup de chamadas concorrentes).
 *   - O resultado é colocado em cache com TTL diferente consoante seja
 *     positivo (user) ou negativo (null).
 *
 * NÃO redireciona. A responsabilidade de redirecionar pertence ao caller
 * (RouteGuard ou a própria página).
 */
export async function lerUtilizador(): Promise<UtilizadorAuth | null> {
  // 1. Cache temporal — se válido, devolve sem ir ao backend.
  const cached = cacheValido();
  if (cached) return cached.user;

  // 2. Cache in-flight — se um pedido já está a decorrer, partilha.
  if (inFlight) return inFlight;

  // 3. Novo pedido.
  inFlight = (async () => {
    try {
      const res = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "include",
      });

      if (!res.ok) {
        // 401 = sem sessão. Cache negativo curto (3s) para evitar burst
        // de 401s durante redirects, mas não bloquear login.
        cache = { user: null, expiraEm: Date.now() + TTL_NEGATIVO_MS };
        return null;
      }

      const data = await res.json();
      if (!data?.utilizador) {
        cache = { user: null, expiraEm: Date.now() + TTL_NEGATIVO_MS };
        return null;
      }

      const user = data.utilizador as UtilizadorAuth;
      // Cache positivo longo (60s) — reduz fetches durante navegação.
      cache = { user, expiraEm: Date.now() + TTL_POSITIVO_MS };
      return user;
    } catch {
      // Erro de rede — não cacheamos (pode ser temporário).
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
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
 * anterior). Também limpa o cache temporal de auth.
 */
export async function fazerLogout(): Promise<void> {
  limparCacheAuth();
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
