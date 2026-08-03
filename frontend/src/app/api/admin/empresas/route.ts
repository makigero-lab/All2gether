/**
 * Proxy route: /api/admin/empresas
 *
 * Encaminha pedidos para o backend /api/admin/empresas, injetando o token
 * JWT do Super Admin do cookie httpOnly.
 *
 *   GET /api/admin/empresas — lista todas as empresas (cross-tenant)
 *
 * Rebrand SSO (satélite single-tenant): o handler POST (criar empresa) foi
 * removido — o utilizador não pode criar empresas no Satélite (essa gestão
 * pertence à Nave-Mãe). O handler GET é mantido porque o componente
 * <AutoImpersonarEmpresa/> precisa de listar as empresas para encontrar a
 * empresa principal do satélite (a 1ª ativa com NIF ≠ 'SISTEMA').
 *
 * O browser não tem acesso ao token — o proxy lê-o do cookie e adiciona
 * o header Authorization ao encaminhar para o backend.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildBackendUrl,
  ERRO_BACKEND_NAO_CONFIGURADO,
} from "@/lib/backend";

const COOKIE_NAME = "all2gether_token";

/** Lê o token do cookie; devolve null se não existir. */
async function lerToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(COOKIE_NAME)?.value ?? null;
}

/** Constrói a resposta, limpando o cookie se o backend devolver 401. */
function construirResposta(data: unknown, status: number) {
  const response = NextResponse.json(data, { status });
  if (status === 401) {
    response.cookies.delete(COOKIE_NAME);
  }
  return response;
}

// GET — lista todas as empresas (cross-tenant).
// Usado pelo <AutoImpersonarEmpresa/> para encontrar a empresa principal.
export async function GET() {
  try {
    const token = await lerToken();
    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    const empresasUrl = buildBackendUrl("/api/admin/empresas");
    if (!empresasUrl) {
      return NextResponse.json(
        { erro: ERRO_BACKEND_NAO_CONFIGURADO },
        { status: 502 }
      );
    }

    const res = await fetch(empresasUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const data = await res.json();
    return construirResposta(data, res.status);
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}
