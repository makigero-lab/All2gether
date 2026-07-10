"use client";

import { useState } from "react";
import {
  ShieldCheck,
  LogOut,
  Loader2,
  Building2,
  Calendar,
  Webhook,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { fazerLogout } from "@/lib/auth";

/**
 * /admin/sistema — Cockpit de Sistema (Prompt 109).
 *
 * Centraliza as operações críticas de infraestrutura:
 *   - Sincronizar Propriedades (importar apartamentos do Smoobu)
 *   - Sincronizar Reservas (forçar atualização de tarefas)
 *   - Registrar Webhooks no Smoobu
 *   - Hard Reset (zona de perigo — com confirmação por texto)
 *
 * Apenas role === 'admin' (protegido pelo middleware).
 */

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

export default function SistemaPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  async function executarAcao(
    nome: string,
    url: string,
    method: "POST" | "DELETE" = "POST"
  ) {
    setLoading(nome);
    setToast(null);
    try {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.erro || data?.message || `Erro ${res.status}`);
      }
      const msg =
        data?.message ||
        data?.detalhe?.mensagem ||
        `${nome} concluído com sucesso.`;
      showToast("sucesso", msg);
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : `Erro em ${nome}.`);
    } finally {
      setLoading(null);
    }
  }

  async function handleHardReset() {
    if (confirmText !== "CONFIRMAR") return;
    setResetLoading(true);
    try {
      const res = await fetch("/api/admin/hard-reset", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.erro || `Erro ${res.status}`);
      }
      showToast(
        "sucesso",
        `${data.message} (${data.detalhe?.propriedades_apagadas ?? 0} propriedades, ${data.detalhe?.tarefas_apagadas ?? 0} tarefas).`
      );
      setShowResetModal(false);
      setConfirmText("");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro no hard reset.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cockpit de Sistema</h1>
            <p className="text-sm text-muted-foreground">
              Operações de infraestrutura e manutenção
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => (window.location.href = "/admin")}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <Button
            variant="ghost"
            className="text-sm text-muted-foreground hover:text-destructive"
            onClick={() => fazerLogout()}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Terminar Sessão
          </Button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <Card
          className={toast.tipo === "sucesso" ? "border-emerald-500/50" : "border-destructive/50"}
        >
          <CardContent
            className={`flex items-center gap-3 p-4 text-sm ${
              toast.tipo === "sucesso"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive"
            }`}
          >
            {toast.tipo === "sucesso" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" />
            )}
            <span className="flex-1">{toast.msg}</span>
            <Button variant="ghost" size="sm" onClick={() => setToast(null)}>
              Fechar
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Grelha de Cartões de Ação */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Sincronizar Propriedades */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5 text-primary" />
              Sincronizar Propriedades
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Importa todos os apartamentos do Smoobu para a base de dados.
              Cria os novos e atualiza a capacidade dos existentes. A morada
              só é preenchida se estiver em branco.
            </p>
            <Button
              className="w-full gap-2"
              onClick={() =>
                executarAcao("Sincronizar Propriedades", "/api/admin/sincronizar-propriedades")
              }
              disabled={loading !== null}
            >
              {loading === "Sincronizar Propriedades" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A sincronizar…
                </>
              ) : (
                <>
                  <Building2 className="h-4 w-4" />
                  Importar do Smoobu
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Sincronizar Reservas */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Calendar className="h-5 w-5 text-primary" />
              Sincronizar Reservas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Vai buscar todas as reservas futuras do Smoobu via REST API e
              cria/atualiza as tarefas de limpeza correspondentes. Útil quando
              o webhook falha ou para recuperar dados perdidos.
            </p>
            <Button
              className="w-full gap-2"
              onClick={() =>
                executarAcao("Sincronizar Reservas", "/api/admin/sincronizar-reservas")
              }
              disabled={loading !== null}
            >
              {loading === "Sincronizar Reservas" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A sincronizar…
                </>
              ) : (
                <>
                  <Calendar className="h-4 w-4" />
                  Sincronizar Reservas
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Registrar Webhooks */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Webhook className="h-5 w-5 text-primary" />
              Registrar Webhooks Smoobu
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Configura o webhook no Smoobu para que o Autocell receba
              automaticamente as notificações de novas reservas, edições e
              cancelamentos. Requer SMOOBU_WEBHOOK_URL configurada.
            </p>
            <Button
              className="w-full gap-2"
              onClick={() =>
                executarAcao("Registrar Webhooks", "/api/admin/registrar-webhooks")
              }
              disabled={loading !== null}
            >
              {loading === "Registrar Webhooks" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  A registrar…
                </>
              ) : (
                <>
                  <Webhook className="h-4 w-4" />
                  Registrar Webhook
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Zona de Perigo — Hard Reset */}
        <Card className="border-destructive/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Zona de Perigo
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Apaga <strong>TODAS as Propriedades e Tarefas</strong> da base de
              dados. Esta ação é irreversível. Usa apenas para fazer uma
              importação limpa do Smoobu.
            </p>
            <Button
              variant="destructive"
              className="w-full gap-2"
              onClick={() => setShowResetModal(true)}
              disabled={loading !== null}
            >
              <AlertTriangle className="h-4 w-4" />
              Limpar Base de Dados
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Modal de Confirmação — Hard Reset */}
      <Dialog open={showResetModal} onOpenChange={(o) => !o && setShowResetModal(false)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Confirmar Hard Reset
            </DialogTitle>
            <DialogDescription>
              Esta ação vai apagar <strong>TODAS as Propriedades e Tarefas</strong>.
              Não pode ser desfeita. Para confirmar, escreve{" "}
              <strong>CONFIRMAR</strong> em maiúsculas no campo abaixo.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setShowResetModal(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="confirm-text">
              Escreve &ldquo;CONFIRMAR&rdquo; para continuar:
            </label>
            <Input
              id="confirm-text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="CONFIRMAR"
              className="font-mono"
              autoComplete="off"
            />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setShowResetModal(false);
              setConfirmText("");
            }}
            disabled={resetLoading}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleHardReset}
            disabled={confirmText !== "CONFIRMAR" || resetLoading}
          >
            {resetLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A limpar…
              </>
            ) : (
              <>
                <AlertTriangle className="mr-2 h-4 w-4" />
                Apagar Tudo
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
