/**
 * Proxy route: GET /api/admin/empresas
 *
 * Encaminha o pedido para o backend GET /api/admin/empresas,
 * injetando o token JWT do Super Admin do cookie httpOnly.
 *
 * O browser não tem acesso ao token — o proxy lê-o do cookie e
 * adiciona o header Authorization ao encaminhar para o backend.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const COOKIE_NAME = "autocell_token";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;

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
