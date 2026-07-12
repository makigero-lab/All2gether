import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  // Prompt 119 — O novo Service Worker assume o controlo imediatamente,
  // sem esperar que todas as tabs sejam fechadas. Isto é CRÍTICO para
  // evitar ChunkLoadError após deployments: o SW novo instala, faz
  // skipWaiting, e clientsClaim força-o a controlar todas as páginas
  // abertas de imediato. Sem isto, tabs antigas continuam com o SW
  // antigo que referencia chunks que já não existem no servidor.
  skipWaiting: true,
  clientsClaim: true,
  // Desativa o service worker em desenvolvimento (evita cache stale).
  disable: process.env.NODE_ENV === "development",
  // Custom worker com event listeners para Web Push (notificações push nativas)
  // + cleanup de caches antigas no evento activate (Prompt 119).
  // O ficheiro é compilado com esbuild e importado pelo SW gerado.
  customWorkerSrc: "worker",
  // Prompt 119 — Estratégia de cache para evitar servir chunks obsoletos.
  // Os ficheiros em /_next/static/chunks/ e /_next/static/css/ têm hashes
  // no nome (ex.: chunk-abc123.js). Quando se faz um novo deployment, os
  // hashes mudam e os ficheiros antigos são removidos do servidor. Se o SW
  // os servir a partir da cache, o browser tenta carregar chunks que
  // referenciam outros chunks antigos → ChunkLoadError.
  //
  // Solução: NetworkFirst para estes ficheiros. O SW vai sempre ao servidor
  // primeiro; só usa a cache se o servidor estiver em baixo (offline).
  // Como os ficheiros têm hash, não há risco de servir versão desatualizada
  // (o servidor só tem a versão atual).
  runtimeCaching: [
    {
      // Chunks de JS — NetworkFirst (não servir chunks obsoletos da cache).
      urlPattern: /\/_next\/static\/chunks\/.*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "next-chunks-cache",
        networkTimeoutSeconds: 5,
        expiration: {
          maxEntries: 100,
          maxAgeSeconds: 7 * 24 * 60 * 60, // 7 dias
        },
      },
    },
    {
      // Ficheiros CSS — NetworkFirst (mesma razão que os chunks).
      urlPattern: /\/_next\/static\/css\/.*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "next-css-cache",
        networkTimeoutSeconds: 5,
        expiration: {
          maxEntries: 20,
          maxAgeSeconds: 7 * 24 * 60 * 60,
        },
      },
    },
    {
      // Imagens e outros estáticos — StaleWhileRevalidate (podem ser
      // servidos da cache enquanto revalida em background; não causam
      // ChunkLoadError porque não são importados dinamicamente).
      urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "static-images-cache",
        expiration: {
          maxEntries: 60,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 dias
        },
      },
    },
  ],
});

export default withPWA(nextConfig);
