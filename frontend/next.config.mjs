import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
  disable: process.env.NODE_ENV === "development",
  customWorkerSrc: "worker",
  // Prompt 129 — Exclui rotas dinâmicas de API da intercetação do SW.
  // O SW não deve cachear nem intercetar chamadas a /api/ (são dinâmicas,
  // requerem cookies de auth, e POST não pode ser cached). Sem isto, o
  // Workbox gera "FetchEvent resulted in a network error" + "no-response".
  publicExcludes: [
    "/api/*",
    "/gestor/relatorios/*",
    "/_next/data/*",
  ],
});

export default withPWA(nextConfig);
