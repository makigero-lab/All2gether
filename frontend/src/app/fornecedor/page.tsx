import { redirect } from "next/navigation";

/**
 * /fornecedor/page.tsx — Redireciona para /fornecedor/tarefas.
 *
 * FIX (portal lavandaria) — Página raiz do portal do fornecedor (lavandaria).
 *
 * Server Component com redirect() do next/navigation — o redirecionamento
 * acontece no servidor antes de enviar HTML, sem flash de página em branco.
 * (Antes era um Client Component com useRouter + useEffect que causava um
 * flash de página vazia durante 1 frame.)
 */
export default function FornecedorPage() {
  redirect("/fornecedor/tarefas");
}
