import { PerfilSimples } from "@/components/portal/perfil-simples";

/** /staff/perfil — perfil da equipa (inclui «Descarregar os meus dados»). */
export default function StaffPerfilPage() {
  return (
    <div className="mx-auto w-full max-w-md md:max-w-2xl">
      <PerfilSimples voltarPara="/staff" />
    </div>
  );
}
