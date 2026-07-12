/**
 * Custom Worker — Autocell PWA
 *
 * Este ficheiro é importado pelo Service Worker gerado pelo next-pwa.
 * Contém os event listeners para Web Push (notificações push nativas) e
 * limpeza de caches antigas no evento activate (Prompt 119).
 *
 * Eventos:
 *   - activate: limpa caches de versões antigas do Workbox (evita
 *     ChunkLoadError após deployments)
 *   - push: recebe a notificação do servidor e mostra ao utilizador
 *   - notificationclick: abre/foca a janela no URL da notificação
 *
 * Payload esperado (JSON): { title, body, url }
 */

// Prompt 119 — Limpeza de caches antigas no evento activate.
//
// Após um novo deployment, o Workbox cria caches com nomes que incluem
// sufixos de versão (ex.: "next-chunks-cache-v1"). As caches da versão
// anterior ficam órfãs e podem conter chunks de JS com hashes obsoletos
// que já não existem no servidor. Se o SW os servir a partir da cache,
// ocorre ChunkLoadError.
//
// No evento activate, percorremos todas as caches e eliminamos as que
// não correspondem às caches atuais (definidas no runtimeCaching do
// next.config.mjs). Isto garante que só as caches da versão atual
// permanecem.
self.addEventListener("activate", (event) => {
  // Caches válidas da versão atual do SW (devem bater com o runtimeCaching
  // do next.config.mjs + as caches internas do Workbox).
  const CACHES_VALIDAS = [
    "next-chunks-cache",
    "next-css-cache",
    "static-images-cache",
    "workbox-precache-v2",
    "start-url-cache",
  ];

  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames.map((cacheName) => {
            // Elimina qualquer cache que não esteja na lista de válidas.
            // Isto inclui caches de versões antigas (ex.: "next-chunks-cache-v0").
            if (!CACHES_VALIDAS.includes(cacheName)) {
              console.log(`[SW] A eliminar cache antiga: ${cacheName}`);
              return caches.delete(cacheName);
            }
            return Promise.resolve();
          })
        );
      } catch (err) {
        console.error("[SW] Erro ao limpar caches antigas:", err);
      }
    })()
  );
});

// Event listener para mensagens push recebidas do servidor.
self.addEventListener("push", (event) => {
  let data = { title: "Autocell", body: "", url: "/" };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (err) {
    // Se o payload não for JSON, tenta como texto.
    if (event.data) {
      data.body = event.data.text();
    }
  }

  // Garante valores por defeito.
  const title = data.title || "Autocell";
  const body = data.body || "";
  const url = data.url || "/";

  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url },
    requireInteraction: true, // a notificação não desaparece sozinha
    vibrate: [200, 100, 200], // vibração em devices móveis
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Event listener para clique na notificação.
self.addEventListener("notificationclick", (event) => {
  // Fecha a notificação.
  event.notification.close();

  // URL para abrir (do payload, ou "/" por defeito).
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      // Tenta focar uma janela já aberta no mesmo URL.
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of allClients) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }

      // Se não há janela aberta, abre uma nova.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
