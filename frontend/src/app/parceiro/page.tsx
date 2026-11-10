import { redirect } from "next/navigation";

/**
 * /parceiro/page.tsx — Redireciona para /parceiro/reservas.
 *
 * FIX (404 parceiro) — Página raiz do portal do parceiro. Sem este ficheiro,
 * o login como parceiro caía num 404 porque a rota /parceiro (sem sub-path)
 * não tinha page.tsx associado.
 *
 * Server Component com redirect() do next/navigation — o redirecionamento
 * acontece no servidor antes de enviar HTML, sem flash de página em branco.
 */
export default function ParceiroPage() {
  redirect("/parceiro/reservas");
}
