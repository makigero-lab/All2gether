import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  // Desativa o service worker em desenvolvimento (evita cache stale).
  disable: process.env.NODE_ENV === "development",
  // Custom worker com event listeners para Web Push (notificações push nativas).
  // O ficheiro é compilado com esbuild e importado pelo SW gerado.
  customWorkerSrc: "worker",
});

export default withPWA(nextConfig);
