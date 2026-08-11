"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, LogOut } from "lucide-react";
import { limparCacheAuth, lerUtilizador } from "@/lib/auth";

/**
 * AutoImpersonarEmpresa — Rebrand SSO (satélite single-tenant).
 *
 * PROBLEMA:
 *   O Super Admin (role 'admin') é cross-tenant: no token, o `empresa_id`
 *   aponta para a empresa-sistema "All2gether (Sistema)" (criada pelo
 *   seed-admin.js, NIF 'SISTEMA'), que NÃO tem propriedades/tarefas reais.
 *   Logo, se o admin entrasse no /gestor com o seu token original, todas as
 *   queries (que filtram por req.user.empresa_id) devolviam dados vazios.
 *
 * SOLUÇÃO:
 *   Quando o admin entra no /gestor (via SSO ou login normal), este
 *   componente deteta que é admin e faz a AUTO-IMPERSONAÇÃO da empresa
 *   principal do satélite (a única empresa operacional ativa):
 *
 *     1. GET /api/admin/empresas — lista todas as empresas.
 *     2. Seleciona a empresa principal: a primeira que esteja ATIVA
 *        (`ativa === true`), NÃO apagada (`apagada !== true`) e que NÃO
 *        seja a empresa-sistema (NIF !== 'SISTEMA'). Num satélite
 *        single-tenant, há tipicamente UMA empresa operacional.
 *     3. POST /api/admin/impersonar/:id — substitui o cookie httpOnly
 *        principal pelo token de gestor dessa empresa (mantendo o
 *        all2gether_admin_token guardado para o "Voltar a Admin").
 *     4. Marca sessionStorage para NÃO repetir a auto-impersonação em
 *        navegações subsequentes dentro da mesma sessão.
 *     5. limparCacheAuth() + window.location.reload() — recarrega com o
 *        novo token de gestor, e o /gestor passa a ver dados reais.
 *
 *   O banner <ImpersonationBanner/> (já existente no layout) mostra
 *   "Voltar a Admin" — o admin pode sair da impersonação a qualquer momento.
 *
 * SEGURANÇA:
 *   - A auto-impersonação só corre para role 'admin' (verificado via
 *     lerUtilizador()). Gestores e staff não são afetados.
 *   - O token de admin original é guardado em all2gether_admin_token pela
 *     rota /api/admin/impersonar/:id (já existente), permitindo restaurar.
 *   - O sessionStorage previne loops: só impersona 1x por sessão de browser.
 *
 * CASOS LIMITE:
 *   - Se não houver nenhuma empresa operacional (só a empresa-sistema), o
 *     componente mostra um erro claro com instrução de criar uma empresa.
 *   - Se a impersonação falhar (backend indisponível, 401, etc.), mostra o
 *     erro e não recarrega (evita loop de reloads).
 */
export function AutoImpersonarEmpresa() {
  const [estado, setEstado] = useState<
    "idle" | "a-impersonar" | "erro" | "concluido"
  >("idle");
  const [erro, setErro] = useState<string | null>(null);
  const [aFazerLogout, setAFazerLogout] = useState(false);

  useEffect(() => {
    let cancelado = false;

    (async () => {
      try {
        const user = await lerUtilizador();

        // Só auto-impersona admins. Gestores/staff não são afetados.
        if (!user || user.role !== "admin") {
          if (!cancelado) setEstado("concluido");
          return;
        }

        // Se já foi auto-impersonado nesta sessão de browser, não repete.
        // Isto evita loops de impersonação quando o admin navega entre
        // páginas do /gestor (o layout re-mounta, mas o sessionStorage
        // impede a repetição).
        if (
          typeof window !== "undefined" &&
          sessionStorage.getItem("all2gether_auto_impersonado") === "true"
        ) {
          if (!cancelado) setEstado("concluido");
          return;
        }

        if (!cancelado) setEstado("a-impersonar");

        // 1. Lista todas as empresas (cross-tenant — o admin tem acesso).
        const resEmpresas = await fetch("/api/admin/empresas", {
          credentials: "include",
          cache: "no-store",
        });
        if (!resEmpresas.ok) {
          const d = await resEmpresas.json().catch(() => ({}));
          throw new Error(
            d?.erro || `Erro ${resEmpresas.status} ao listar empresas.`
          );
        }
        const dataEmpresas = (await resEmpresas.json()) as {
          empresas: Array<{
            _id: string;
            nome: string;
            nif?: string;
            ativa?: boolean;
            apagada?: boolean;
          }>;
        };

        // 2. Seleciona a empresa principal: ativa, não apagada e que não
        //    seja a empresa-sistema (NIF 'SISTEMA'). Num satélite
        //    single-tenant, há tipicamente UMA empresa operacional.
        const empresaPrincipal = dataEmpresas.empresas.find(
          (e) =>
            e.ativa !== false &&
            e.apagada !== true &&
            (e.nif || "").toUpperCase() !== "SISTEMA"
        );

        if (!empresaPrincipal) {
          throw new Error(
            "Não foi encontrada nenhuma empresa operacional ativa. " +
              "Cria uma empresa (ou restaura da reciclagem) antes de entrar no programa."
          );
        }

        // 3. Impersona o gestor da empresa principal.
        //    A rota /api/admin/impersonar/:id substitui o cookie httpOnly
        //    principal pelo token do gestor e guarda o token de admin em
        //    all2gether_admin_token (para o "Voltar a Admin").
        const resImpersonar = await fetch(
          `/api/admin/impersonar/${empresaPrincipal._id}`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          }
        );
        if (!resImpersonar.ok) {
          const d = await resImpersonar.json().catch(() => ({}));
          throw new Error(
            d?.erro || `Erro ${resImpersonar.status} ao impersonar.`
          );
        }

        // 4. Marca a auto-impersonação como feita (não repete na sessão).
        //    Define AMBAS as flags de sessionStorage:
        //      - all2gether_auto_impersonado: controla este componente (não
        //        repetir a impersonação em navegações subsequentes).
        //      - all2gether_impersonating: lida pelo <ImpersonationBanner/>
        //        para mostrar o botão "Voltar a Admin" no topo do /gestor.
        if (typeof window !== "undefined") {
          sessionStorage.setItem("all2gether_auto_impersonado", "true");
          sessionStorage.setItem("all2gether_impersonating", "true");
        }

        // 5. Limpa o cache de auth (o token mudou) e recarrega.
        //    O reload faz o /gestor voltar a montar com o token de gestor,
        //    e o lerUtilizador() vai buscar o user real (gestor da empresa).
        limparCacheAuth();

        if (!cancelado) setEstado("concluido");

        // Pequeno delay para o cookie ser consolidado antes do reload.
        setTimeout(() => {
          if (!cancelado) window.location.reload();
        }, 150);
      } catch (e) {
        if (!cancelado) {
          setErro(
            e instanceof Error
              ? e.message
              : "Erro inesperado na auto-impersonação."
          );
          setEstado("erro");
        }
      }
    })();

    return () => {
      cancelado = true;
    };
  }, []);

  // Enquanto impersona: ecrã de loading (não renderiza o /gestor ainda,
  // porque o token atual é do admin e as queries devolviam dados vazios).
  if (estado === "a-impersonar") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-muted/30 px-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium text-foreground">
          A preparar o acesso ao programa operacional…
        </p>
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          A assumir automaticamente a empresa principal do satélite.
        </p>
      </div>
    );
  }

  // Erro: mostra mensagem clara com logout real (evita loop de redirect).
  if (estado === "erro") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-muted/30 px-4">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm font-semibold text-foreground">
          Não foi possível entrar no programa operacional
        </p>
        <p className="max-w-md text-center text-xs text-muted-foreground">
          {erro}
        </p>
        <div className="mt-2">
          {/* HF24 — Logout real: o await fetch TEM de terminar antes do redirect.
              Antes o .catch(() => {}) engolia a rejeição mas o redirect podia
              cancelar o fetch a meio (navegador aborta pedidos pendentes ao
              navegar). Agora esperamos o fetch resolver (ou falhar) e SÓ DEPOIS
              fazemos window.location.href. Sem o cookie httpOption limpo, o
              middleware atira o user de volta para /gestor → loop infinito. */}
          <button
            type="button"
            disabled={aFazerLogout}
            onClick={async () => {
              setAFazerLogout(true);
              // Limpa flags de sessionStorage.
              sessionStorage.removeItem("all2gether_auto_impersonado");
              sessionStorage.removeItem("all2gether_impersonating");
              // Limpa o cache de auth (o token vai ser destruído).
              limparCacheAuth();
              // Chama o logout real no backend (limpa cookie httpOnly).
              // NÃO usamos .catch(() => {}) — queremos que o await espere
              // realmente o fim do pedido antes de redirecionar.
              try {
                await fetch("/api/auth/logout", {
                  method: "POST",
                  credentials: "include",
                });
              } catch {
                // Se o fetch falhar (rede, servidor em baixo), continua
                // para o redirect — o middleware bloqueia sem cookie.
                // Mas pelo menos esperámos que o pedido terminasse.
              }
              // SÓ AGORA redireciona — o cookie httpOnly foi apagado.
              window.location.href = "/login";
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-muted disabled:opacity-60"
          >
            {aFazerLogout ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            {aFazerLogout ? "A sair…" : "Voltar ao login"}
          </button>
        </div>
      </div>
    );
  }

  // idle ou concluido: não renderiza nada (o /gestor normal aparece).
  return null;
}
