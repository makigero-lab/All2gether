"use client";

import { usePathname } from "next/navigation";
import { RouteGuard } from "@/components/auth/route-guard";
import { PushNotificationSetup } from "@/components/staff/push-notification-setup";
import { StaffBottomNav } from "@/components/staff/staff-bottom-nav";

/**
 * Layout da Área do Staff (mobile-first).
 *
 * Protegido por RouteGuard (role "staff") — camada client-side complementar
 * ao middleware.ts. Sem token válido (ou role errado) → redireciona para /login.
 *
 * v1.66.0 (Prompt 89) — O <PushNotificationSetup /> é renderizado no layout
 * (em vez de só no dashboard) para que o banner de permissão apareça em
 * QUALQUER página do staff que o utilizador abra primeiro (ex: se fizer
 * bookmark de /staff/calendario). O banner só aparece quando a permissão
 * é 'default' (ainda não perguntada) e desaparece automaticamente após
 * o utilizador conceder ou negar — não é intrusivo.
 */
export default function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // A barra inferior aparece nas 4 áreas principais; no detalhe da tarefa o
  // ecrã é dedicado (checklist/fotos) e a barra fica escondida.
  const pathname = usePathname() || "";
  const mostrarNav = !pathname.startsWith("/staff/tarefas");

  return (
    <RouteGuard role="staff">
      <PushNotificationSetup />
      <div className={mostrarNav ? "pb-[calc(5rem+env(safe-area-inset-bottom))]" : undefined}>{children}</div>
      {mostrarNav && <StaffBottomNav />}
    </RouteGuard>
  );
}
