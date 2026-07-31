import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FisioCell — Gestão de Alojamento Local",
  description:
    "SaaS de gestão para Alojamento Local: atribuição automática de tarefas de limpeza.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "FisioCell",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#B8860B",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

/**
 * RootLayout — estrutura base do App Router (Prompt 121).
 *
 * Versão limpa e funcional, sem Scripts de erro, sem handlers de cache,
 * sem manipulações do Service Worker. Apenas a estrutura obrigatória:
 *   <html lang="pt"> <body> {children} </body> </html>
 *
 * O `suppressHydrationWarning` no <html> é necessário porque o next-themes
 * (ThemeToggle) injeta a classe dark/light no <html> via JS — sem esta flag,
 * o Next.js warna sobre mismatch entre SSR e CSR.
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
