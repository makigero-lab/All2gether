"use client";

import { RouteGuard } from "@/components/auth/route-guard";
import { PortalHeader } from "@/components/portal/portal-header";

/**
 * Layout da Área do Parceiro (B2B).
 *
 * Protegido por RouteGuard (role "parceiro") — camada client-side
 * complementar ao middleware.ts. Sem token válido (ou role errado) →
 * redireciona para /login.
 *
 * HF27 — O portal do parceiro é separado do /gestor e /staff porque os
 * parceiros são externos à equipa de limpezas: só criam reservas manuais
 * nas suas propriedades e veem as tarefas de limpeza geradas a partir
 * dessas reservas. Não têm acesso ao calendário da equipa, ausências,
 * nem gestão de staff.
 *
 * FIX (header parceiro) — Adicionado PortalHeader com avatar/menu/logout.
 * O parceiro agora tem acesso ao menu de utilizador (Perfil + Terminar
 * Sessão) que antes só existia no layout do gestor/staff.
 */
export default function ParceiroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role="parceiro">
      <PortalHeader portalLabel="Parceiro" />
      {children}
    </RouteGuard>
  );
}
