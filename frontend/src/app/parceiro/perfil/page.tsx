import { PerfilContent } from "@/components/portal/perfil-content";

/**
 * /parceiro/perfil/page.tsx — Página de perfil do parceiro.
 *
 * FIX (botão perfil) — Cria a página que faltava. O botão "Perfil" no
 * UserMenu do cabeçalho agora navega para esta rota.
 */
export default function ParceiroPerfilPage() {
  return <PerfilContent portalLabel="Parceiro" />;
}
