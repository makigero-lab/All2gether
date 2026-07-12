import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

/**
 * Configuração PWA — versão standard segura (Prompt 121).
 *
 * Prompt 121 — Revertida para a configuração minimalista. O runtimeCaching
 * experimental com NetworkFirst para /_next/static/chunks/ foi REMOVIDO
 * porque podia estar a bloquear o build silenciosamente (o Workbox gerava
 * SW com referências a caches que não existiam, causando ecrã branco).
 *
 * Mantemos apenas:
 *   - dest: "public" (gera o SW na pasta public)
 *   - register: true (auto-regista o SW)
 *   - skipWaiting + clientsClaim (SW novo assume controlo imediatamente)
 *   - disable em desenvolvimento (evita cache stale)
 *   - customWorkerSrc: "worker" (Web Push notifications)
 *
 * A resiliência a ChunkLoadError fica a cargo do skipWaiting+clientsClaim,
 * que fazem o SW novo substituir o antigo sem precisar de runtimeCaching
 * customizado. Os chunks do Next.js já têm hashes no nome — quando o SW
 * faz skipWaiting, o browser vai buscar os chunks novos ao servidor na
 * próxima navegação, sem precisar de NetworkFirst forçado.
 */
const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  clientsClaim: true,
  disable: process.env.NODE_ENV === "development",
  customWorkerSrc: "worker",
});

export default withPWA(nextConfig);
