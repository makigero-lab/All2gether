import type { Metadata, Viewport } from "next";
import Script from "next/script";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-PT" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}

        {/*
         * Prompt 119 — Captura Global do ChunkLoadError.
         *
         * Após um novo deployment, o browser pode ter em memória referências
         * a chunks de JS antigos (com hashes que já não existem no servidor).
         * Quando o Next.js tenta carregar esses chunks (lazy loading de
         * páginas), ocorre um ChunkLoadError e a página fica em branco.
         *
         * Este script (beforeInteractive — corre antes do hidrate) instala
         * dois listeners:
         *   1. window.addEventListener('error') — interceta erros de loading
         *      de chunks (a mensagem contém "Loading chunk" ou "ChunkLoadError").
         *   2. window.addEventListener('unhandledrejection') — interceta
         *      promessas rejeitadas com o mesmo padrão (dynamic imports).
         *
         * Em ambos os casos, faz window.location.reload() para forçar o
         * browser a ir buscar a nova versão ao servidor. Um flag
         * (sessionStorage) previne loops infinitos se o reload também falhar.
         */}
        <Script id="chunk-load-error-handler" strategy="beforeInteractive">
          {`
            (function() {
              var CHUNK_ERROR_PATTERNS = ['ChunkLoadError', 'Loading chunk', 'Loading CSS chunk', 'Failed to fetch dynamically imported module'];
              var RELOAD_FLAG = 'autocell_chunk_reload';

              function isChunkError(msg) {
                if (!msg) return false;
                var lower = String(msg).toLowerCase();
                return CHUNK_ERROR_PATTERNS.some(function(p) {
                  return lower.indexOf(p.toLowerCase()) !== -1;
                });
              }

              function handleChunkError() {
                // Previne loop infinito: se já fizemos reload há menos de
                // 10 segundos, não volta a fazer (deixa o erro aparecer).
                try {
                  var last = sessionStorage.getItem(RELOAD_FLAG);
                  var now = Date.now();
                  if (last && (now - Number(last)) < 10000) {
                    return; // já reloadamos há pouco, não repetir
                  }
                  sessionStorage.setItem(RELOAD_FLAG, String(now));
                } catch (e) {
                  // sessionStorage pode falhar (modo privado) — reload à mesma.
                }
                // Força reload bypassando a cache do browser.
                if (window.location.reload) {
                  window.location.reload();
                }
              }

              // 1. Erros síncronos (ex.: <script> tag loading).
              window.addEventListener('error', function(event) {
                var msg = event.message || (event.error && event.error.message) || '';
                if (isChunkError(msg)) {
                  handleChunkError();
                }
              });

              // 2. Promessas rejeitadas (ex.: dynamic import() falha).
              window.addEventListener('unhandledrejection', function(event) {
                var msg = event.reason && (event.reason.message || event.reason.name || String(event.reason));
                if (isChunkError(msg)) {
                  handleChunkError();
                }
              });
            })();
          `}
        </Script>
      </body>
    </html>
  );
}
