/**
 * Proxy route: PATCH /api/admin/empresas/:empresaId/utilizadores/:utilizadorId/estado
 *
 * Alterna ativo/inativo de um utilizador de uma empresa terceira (Prompt 101).
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "fisiocell_token";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ empresaId: string; utilizadorId: string }> }
) {
  try {
    const { empresaId, utilizadorId } = await params;
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;

    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const res = await fetch(
      `${BACKEND_URL}/api/admin/empresas/${empresaId}/utilizadores/${utilizadorId}/estado`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }
    );

    const data = await res.json();
    const response = NextResponse.json(data, { status: res.status });
    if (res.status === 401) {
      response.cookies.delete(COOKIE_NAME);
    }
    return response;
  } catch {
    return NextResponse.json(
      { erro: "Erro ao comunicar com o backend." },
      { status: 502 }
    );
  }
}
