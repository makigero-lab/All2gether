import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const emDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy. O browser só fala com o próprio site (a API é chamada pelos proxies do
 * Next, no servidor); as fontes são servidas por next/font (self-host); as fotos seguem como
 * data:/blob:. O Next precisa de scripts/estilos inline (sem nonces), por isso 'unsafe-inline';
 * 'unsafe-eval' só em desenvolvimento (React refresh). O Service Worker (push) é do mesmo
 * origin ('self'); blob: nos workers por causa de bibliotecas de gráficos/Excel.
 */
function politicaCsp() {
  let api = "";
  try {
    if (process.env.NEXT_PUBLIC_API_URL) api = new URL(process.env.NEXT_PUBLIC_API_URL).origin;
  } catch {
    /* URL inválido: ignora */
  }
  const diretivas = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${emDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${api ? " " + api : ""}${emDev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return diretivas.join("; ");
}

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: politicaCsp() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

/**
 * Configuração PWA — Prompt 129.
 *
 * Prompt 129 — Adicionado publicExcludes para /api/ e /gestor/relatorios
 * para o Service Worker NÃO intercetar chamadas de API dinâmicas. Sem isto,
 * o Workbox interceta POST /api/gestor/relatorios e devolve "no-response"
 * porque não tem cache para POST e falha o fetch.
 *
 * Mantém skipWaiting + clientsClaim do Prompt 121.
 */
const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  clientsClaim: true,
  // O padrao (true) faz location.reload() ao voltar a rede e apaga o que o utilizador estava a editar.
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === "development",
  customWorkerSrc: "worker",
  // Prompt 129 — Exclui rotas dinâmicas de API da intercetação do SW.
  // O SW não deve cachear nem intercetar chamadas a /api/ (são dinâmicas,
  // requerem cookies de auth, e POST não pode ser cached). Sem isto, o
  // Workbox gera "FetchEvent resulted in a network error" + "no-response".
  // Dados privados (API) nunca ficam em cache do Service Worker: a cache partilha-se entre
  // sessões/utilizadores do mesmo browser. As regras abaixo vêm ANTES das predefinidas (a
  // primeira que corresponde ganha) e as predefinidas mantêm o modo sem rede dos ficheiros estáticos.
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    runtimeCaching: [
      {
        // Qualquer /api/ (proxies do Next e API) vai sempre à rede.
        urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
      },
      {
        // Outras origens (ex.: a API no Render, chamada diretamente) também, exceto os tipos de letra.
        urlPattern: ({ url, sameOrigin }) =>
          !sameOrigin && !/(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname),
        handler: "NetworkOnly",
      },
    ],
  },
  publicExcludes: [
    "/api/*",
    "/gestor/relatorios/*",
    "/_next/data/*",
  ],
});

export default withPWA(nextConfig);
