/**
 * Custom Worker — Autocell PWA
 *
 * Este ficheiro é importado pelo Service Worker gerado pelo next-pwa.
 * Contém os event listeners para Web Push (notificações push nativas).
 *
 * Eventos:
 *   - push: recebe a notificação do servidor e mostra ao utilizador
 *   - notificationclick: abre/foca a janela no URL da notificação
 *
 * Payload esperado (JSON): { title, body, url }
 */

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
