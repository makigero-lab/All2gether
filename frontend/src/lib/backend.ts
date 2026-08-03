/**
 * Helper de proxy — All2gether (frontend)
 *
 * Constrói URLs de destino para o backend de forma segura a partir da
 * variável de ambiente NEXT_PUBLIC_API_URL, usando o construtor `URL` para
 * evitar erros de composição (barras finais duplicadas, protocolos em falta,
 * concatenação de strings frágil, etc.).
 *
 * Se a variável não estiver definida ou for inválida, as funções devolvem
 * `null` — o proxy deve então devolver um erro explícito (com mensagem que
 * nomeia a variável em falta) em vez de um 502 silencioso, para facilitar
 * o diagnóstico nos logs da Vercel.
 *
 * Variável de ambiente esperada (ver `.env.example`):
 *   NEXT_PUBLIC_API_URL=https://all2gether-backend.onrender.com
 * (com protocolo, SEM barra final)
 */

const RAW_BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * URL base do backend normalizada: trim + remoção de barras finais.
 * String vazia se a variável de ambiente não estiver definida.
 */
export const BACKEND_URL = RAW_BACKEND_URL.trim().replace(/\/+$/, "");

/**
 * Constrói um URL absoluto para o backend, de forma segura.
 *
 * Usa `new URL(path, base)` para combinar o caminho com a base, o que:
 *   - tolera barras finais na base (ex: "https://host/" → "https://host/api/...");
 *   - valida a base (lança se não for um URL absoluto válido);
 *   - NÃO adiciona protocolo hardcoded (usa o que vier na env var).
 *
 * @param path Caminho relativo, deve começar por "/" (ex: "/api/gestor/propriedades").
 * @param queryString Query string COM o "?" inicial (ex: "?foo=bar") ou string vazia.
 * @returns URL absoluto validado, ou `null` se o backend não estiver configurado
 *          ou a base for inválida.
 */
export function buildBackendUrl(
  path: string,
  queryString: string = ""
): string | null {
  if (!BACKEND_URL) return null;
  try {
    const url = new URL(path, BACKEND_URL);
    if (queryString) {
      // O setter aceita a query com ou sem o "?" inicial.
      url.search = queryString;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Mensagem de erro standard para devolver quando o backend não está
 * configurado (env var em falta/inválida). Usada pelos proxies para
 * devolver um erro diagnosável em vez de um 502 silencioso.
 */
export const ERRO_BACKEND_NAO_CONFIGURADO =
  "Backend não configurado (NEXT_PUBLIC_API_URL em falta ou inválida).";
