"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, CheckCircle2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * PushNotificationSetup — banner para ativar notificações push nativas.
 *
 * Comportamento:
 *   1. Verifica se o browser suporta Push (serviceWorker + PushManager).
 *      Se não suportar, não renderiza nada.
 *   2. Verifica se a permissão é 'default' (ainda não perguntada).
 *      Se for 'granted' ou 'denied', não renderiza nada.
 *   3. Mostra um banner com botão "Ativar".
 *   4. Ao clicar:
 *      a) Pede permissão via Notification.requestPermission()
 *      b) Obtém o Service Worker (navigator.serviceWorker.ready)
 *      c) Faz pushManager.subscribe({ userVisibleOnly, applicationServerKey })
 *      d) Envia a subscrição para POST /api/auth/me/push-subscribe
 *   5. Em caso de sucesso, o banner desaparece.
 *
 * Requer NEXT_PUBLIC_VAPID_PUBLIC_KEY no ambiente do frontend.
 */
export function PushNotificationSetup() {
  const [mostrar, setMostrar] = useState(false);
  const [ativando, setAtivando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Prompt 118 — feedback de sucesso (banner verde momentâneo).
  const [sucesso, setSucesso] = useState(false);

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // Verifica suporte e permissão ao montar.
  useEffect(() => {
    const suportaPush =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;

    if (!suportaPush || !vapidPublicKey) {
      return; // não renderiza
    }

    // Só mostra o banner se a permissão for 'default' (ainda não perguntada).
    if (Notification.permission === "default") {
      setMostrar(true);
    }
  }, [vapidPublicKey]);

  // Não renderiza nada se não for para mostrar.
  if (!mostrar) return null;

  /**
   * Converte uma chave pública VAPID (base64url) para Uint8Array,
   * formato exigido pelo pushManager.subscribe().
   */
  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function handleAtivar() {
    setAtivando(true);
    setErro(null);

    try {
      // a) Pede permissão.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setErro("Permissão de notificações negada.");
        setMostrar(false); // esconde o banner (user negou)
        return;
      }

      // b) Obtém o Service Worker registado.
      const registration = await navigator.serviceWorker.ready;

      // c) Subscreve push.
      // Converte a chave pública VAPID (base64url) para Uint8Array.
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey!);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
      });

      // d) Envia a subscrição para o backend.
      const res = await fetch("/api/auth/me/push-subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.erro || `Erro ${res.status}`);
      }

      // Prompt 118 — Confirmação visual de sucesso antes de esconder o banner.
      setSucesso(true);
      setTimeout(() => setMostrar(false), 1500);
    } catch (err) {
      setErro(
        err instanceof Error
          ? `Erro ao ativar notificações: ${err.message}`
          : "Erro ao ativar notificações."
      );
    } finally {
      setAtivando(false);
    }
  }

  return (
    <div className={`flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors ${
      sucesso
        ? "border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/20"
        : "border-primary/30 bg-primary/5"
    }`}>
      {sucesso ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <Bell className="h-4 w-4 shrink-0 text-primary" />
      )}
      <span className={`flex-1 ${sucesso ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
        {sucesso
          ? "✅ Notificações ativadas com sucesso! A subscrição foi guardada."
          : "🔔 Ative as notificações para ser avisado de novas limpezas e alterações."}
      </span>
      {!sucesso && erro && (
        <span className="text-xs text-destructive">{erro}</span>
      )}
      {!sucesso && (
        <>
          <Button
            size="sm"
            onClick={handleAtivar}
            disabled={ativando}
            className="shrink-0"
          >
            {ativando ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                A ativar…
              </>
            ) : (
              "Ativar"
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setMostrar(false)}
            aria-label="Dispensar"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
