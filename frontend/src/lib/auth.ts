/**
 * Utilitários de Autenticação (frontend) — All2gether
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

import { contarRascunhos, limparTodosRascunhos } from "@/lib/rascunho-staff";

export type Role = "admin" | "gestor" | "staff" | "parceiro" | "fornecedor";

export interface UtilizadorAuth {
  id: string;
  nome: string;
  email: string;
  role: Role;
  empresa_id: string;
  /** Telemóvel do próprio (vem do /api/auth/me). */
  telefone?: string;
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
let inFlight: Promise<ResultadoSessao> | null = null;

/**
 * Estado da sessão:
 *  - "ok": utilizador autenticado;
 *  - "sem_sessao": o backend disse que não há sessão (401/404): é caso de login;
 *  - "erro": não foi possível saber (5xx, 429, falha de rede, servidor a acordar).
 *    NÃO é fim de sessão: o cliente mantém tudo e tenta outra vez.
 */
export type EstadoSessao = "ok" | "sem_sessao" | "erro";
export interface ResultadoSessao {
  estado: EstadoSessao;
  user: UtilizadorAuth | null;
}

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
 * Consulta o backend (via proxy /api/auth/me) e distingue "sem sessão" (401/404)
 * de "erro temporário" (5xx, 429, rede). O token é lido do cookie httpOnly no
 * servidor — o browser nunca o vê. Só "sem_sessao" justifica ir para o login.
 *
 * Cache:
 *   - Resultado "ok": 60s. Resultado "sem_sessao": 3s (evita burst de 401s).
 *   - "erro" nunca é guardado em cache (pode ser temporário).
 *   - Pedidos concorrentes partilham a mesma Promise.
 *
 * NÃO redireciona. A responsabilidade de redirecionar pertence ao caller.
 */
export async function lerSessao(): Promise<ResultadoSessao> {
  const cached = cacheValido();
  if (cached) return { estado: cached.user ? "ok" : "sem_sessao", user: cached.user };

  if (inFlight) return inFlight;

  inFlight = (async (): Promise<ResultadoSessao> => {
    try {
      const res = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "include",
      });

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        cache = { user: null, expiraEm: Date.now() + TTL_NEGATIVO_MS };
        return { estado: "sem_sessao", user: null };
      }
      if (!res.ok) {
        // 5xx / 429 / gateway: o servidor pode estar a acordar. Não é fim de sessão.
        return { estado: "erro", user: null };
      }

      const data = await res.json();
      if (!data?.utilizador) {
        // Resposta 200 sem utilizador: não sabemos quem é. Trata como erro, não como logout.
        return { estado: "erro", user: null };
      }

      const user = data.utilizador as UtilizadorAuth;
      cache = { user, expiraEm: Date.now() + TTL_POSITIVO_MS };
      return { estado: "ok", user };
    } catch {
      // Erro de rede / resposta ilegível — não cacheamos (pode ser temporário).
      return { estado: "erro", user: null };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Utilizador autenticado, ou null se não houver sessão OU se não foi possível
 * saber (erro temporário). Quem precisa de distinguir usa `lerSessao()`.
 */
export async function lerUtilizador(): Promise<UtilizadorAuth | null> {
  return (await lerSessao()).user;
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
export async function fazerLogout(opcoes: { sessaoExpirada?: boolean; acessosMudaram?: boolean } = {}): Promise<void> {
  if (!opcoes.sessaoExpirada) {
    // Saída explícita: avisa se há alterações por gravar, que se perdem ao sair
    // (os rascunhos têm nomes e notas de hóspedes e não ficam em aparelho partilhado).
    if (contarRascunhos() > 0 && typeof window !== "undefined" && !window.confirm(
      "Tens alterações por gravar neste aparelho. Se saíres agora perdem-se. Sair mesmo assim?"
    )) {
      return;
    }
    limparTodosRascunhos();
  }
  // Sessão expirada: mantém os rascunhos (a pessoa volta a entrar e continua; expiram aos 7 dias).
  limparCacheAuth();
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Mesmo que o fetch falhe, tentamos redirecionar (o middleware vai
    // bloquear o acesso às páginas privadas sem cookie).
  }
  window.location.href = opcoes.acessosMudaram ? "/login?aviso=acessos" : "/login";
}

/**
 * Determina para onde redirecionar o utilizador após login, com base no role.
 *
 * Rebrand SSO (satélite single-tenant): o repositório passou de Nave-Mãe
 * (multi-tenant) para Satélite dedicado à All2gether. O painel /admin (gestão
 * cross-tenant de empresas) deixou de fazer sentido — o Super Admin entra
 * diretamente no programa operacional (/gestor). A auto-impersonação da
 * empresa principal é tratada pelo <AutoImpersonarEmpresa/> no layout do gestor.
 *
 * - admin   -> /gestor  (Super Admin — entra no programa operacional; a
 *                        empresa principal é assumida automaticamente)
 * - gestor  -> /gestor  (Gestor de Operações — painel operacional)
 * - staff   -> /staff   (executante de limpezas)
 * - parceiro -> /parceiro (B2B externo — portal de reservas manuais)
 */
export function rotaPorRole(role: Role): string {
  if (role === "admin") return "/gestor";
  if (role === "gestor") return "/gestor";
  if (role === "parceiro") return "/parceiro";
  if (role === "fornecedor") return "/fornecedor";
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
