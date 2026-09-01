"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /fornecedor/page.tsx — Redireciona para /fornecedor/tarefas.
 *
 * FIX (portal lavandaria) — Página raiz do portal do fornecedor (lavandaria).
 */
export default function FornecedorPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/fornecedor/tarefas");
  }, [router]);
  return null;
}
