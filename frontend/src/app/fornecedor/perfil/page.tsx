import { PerfilContent } from "@/components/portal/perfil-content";

/**
 * /fornecedor/perfil/page.tsx — Página de perfil do fornecedor (lavandaria).
 *
 * FIX (botão perfil) — Cria a página que faltava. O botão "Perfil" no
 * UserMenu do cabeçalho agora navega para esta rota.
 */
export default function FornecedorPerfilPage() {
  return <PerfilContent portalLabel="Lavandaria" />;
}
