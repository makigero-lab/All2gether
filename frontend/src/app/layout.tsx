import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Autocell — Gestão de Alojamento Local",
  description:
    "SaaS de gestão para Alojamento Local: atribuição automática de tarefas de limpeza.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Autocell",
  },
  // mobile-web-app-capable é o standard moderno (apple-mobile-web-app-capable
  // está deprecated). Mantemos ambos para compatibilidade com iOS antigo.
  other: {
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#B8860B",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

/**
 * Prompt 120 — Remoção do Script Agressivo de Reload.
 *
 * O <Script id="chunk-load-error-handler"> que foi adicionado no Prompt 119
 * estava a causar um loop infinito de reloads (White Screen of Death). O
 * listener 'error' intercetava não só ChunkLoadError mas também erros
 * benignos de hidratação e recursos, disparando window.location.reload()
 * repetidamente antes da renderização completar.
 *
 * Removido completamente. A resiliência a ChunkLoadError agora confia
 * APENAS na configuração do next-pwa (skipWaiting + clientsClaim +
 * runtimeCaching NetworkFirst) no next.config.mjs, que atualiza os
 * ficheiros obsoletos sem forçar reloads agressivos no DOM.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-PT" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
