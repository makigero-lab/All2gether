/**
 * Proxy route: /api/admin/empresas
 *
 * Encaminha pedidos para o backend /api/admin/empresas, injetando o token
 * JWT do Super Admin do cookie httpOnly.
 *
 *   GET    /api/admin/empresas       — lista todas as empresas (Prompt 111)
 *   POST   /api/admin/empresas       — cria nova empresa (Prompt 111)
 *   DELETE /api/admin/empresas/:id   — eliminado pelo catch-all [...path]
 *
 * O browser não tem acesso ao token — o proxy lê-o do cookie e adiciona
 * o header Authorization ao encaminhar para o backend.
 *
 * Prompt 113 (fix) — Adicionado o handler POST. Antes só existia GET, pelo
 * que o botão "Criar Nova Empresa" recebia 405 Method Not Allowed.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "fisiocell_token";

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
export async function GET() {
  try {
    const token = await lerToken();
    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    const res = await fetch(`${BACKEND_URL}/api/admin/empresas`, {
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

// POST — cria nova empresa. Body: { nome, smoobu_api_key? }.
export async function POST(req: Request) {
  try {
    const token = await lerToken();
    if (!token) {
      return NextResponse.json(
        { erro: "Autenticação obrigatória." },
        { status: 401 }
      );
    }

    // Lê o corpo do pedido (JSON) para reenviar ao backend.
    const body = await req.text();

    const res = await fetch(`${BACKEND_URL}/api/admin/empresas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
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
