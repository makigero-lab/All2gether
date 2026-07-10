"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Bell,
  Clock,
  Settings,
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
import { lerUtilizador } from "@/lib/auth";

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

/**
 * Cockpit de Sistema do Super Admin — Prompt 109 / 113.
 *
 * Prompt 113 — Limpeza da Arquitetura SaaS:
 *   Este painel é ESTRITAMENTE para operações de sistema globais:
 *     - Forçar Cron Jobs globais (Daily Briefing, Cão de Guarda, Agenda de Amanhã)
 *     - Push de teste (infraestrutura de notificações)
 *     - Hard Reset (apagar todas as Propriedades + Tarefas)
 *
 *   TODAS as opções de Smoobu, Sincronizações, Webhooks e Configuração de
 *   empresa (nome, API key) foram REMOVIDAS daqui. Essas integrações
 *   pertencem apenas a /gestor/configuracoes (escopo por tenant).
 */
export default function SistemaPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  // Auth check — valida o token antes de carregar qualquer dados.
  // Previne o loop de 401 quando o token está expirado/inválido.
  useEffect(() => {
    let redirecionado = false;
    lerUtilizador()
      .then((u) => {
        if (u === null) {
          redirecionado = true;
          router.replace("/login");
          return;
        }
        if (u.role !== "admin") {
          redirecionado = true;
          router.replace("/gestor");
          return;
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (!redirecionado) {
          router.replace("/login");
        }
      });
  }, [router]);

  async function executarAcao(nome: string, url: string, method: "POST" | "DELETE" = "POST") {
    setLoading(nome);
    setToast(null);
    try {
      const res = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || data?.message || `Erro ${res.status}`);
      const msg = data?.message || `${nome} concluído com sucesso.`;
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
      const res = await fetch("/api/admin/hard-reset", { method: "DELETE", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      showToast("sucesso", `${data.message} (${data.detalhe?.propriedades_apagadas ?? 0} propriedades, ${data.detalhe?.tarefas_apagadas ?? 0} tarefas).`);
      setShowResetModal(false);
      setConfirmText("");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro no hard reset.");
    } finally {
      setResetLoading(false);
    }
  }

  // Botão reutilizável.
  function ActionButton({
    nome,
    icon: Icon,
    label,
    url,
    variant = "default",
  }: {
    nome: string;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    url: string;
    variant?: "default" | "outline" | "destructive";
  }) {
    return (
      <Button
        variant={variant}
        className="w-full gap-2"
        onClick={() => executarAcao(nome, url)}
        disabled={loading !== null}
      >
        {loading === nome ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
        {loading === nome ? "A executar…" : label}
      </Button>
    );
  }

  // Enquanto o auth não é validado, mostra loading (previne 401 loop).
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cockpit de Sistema</h1>
            <p className="text-sm text-muted-foreground">
              Operações globais de manutenção e automação
            </p>
          </div>
        </div>
      </div>

      {/* Aviso de arquitetura SaaS */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <Settings className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="text-muted-foreground">
            <strong className="text-foreground">Painel de Sistema (global).</strong>{" "}
            Aqui só operações globais: forçar cron jobs, push de teste e hard reset.
            As integrações de cada empresa (Smoobu, sincronizações, webhooks,
            configuração) estão em{" "}
            <strong className="text-foreground">/gestor/configuracoes</strong>.
          </div>
        </CardContent>
      </Card>

      {/* Toast */}
      {toast && (
        <Card className={toast.tipo === "sucesso" ? "border-emerald-500/50" : "border-destructive/50"}>
          <CardContent className={`flex items-center gap-3 p-4 text-sm ${toast.tipo === "sucesso" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {toast.tipo === "sucesso" ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertCircle className="h-5 w-5 shrink-0" />}
            <span className="flex-1">{toast.msg}</span>
            <Button variant="ghost" size="sm" onClick={() => setToast(null)}>Fechar</Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Forçar Rotinas (Cron Jobs globais) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-5 w-5 text-primary" />
              Forçar Rotinas (Cron Jobs)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Dispara manualmente os cron jobs diários globais (todas as empresas).
            </p>
            <ActionButton nome="Daily Briefing" icon={Clock} label="Daily Briefing (08h)" url="/api/admin/forcar-daily-briefing" variant="outline" />
            <ActionButton nome="Cão de Guarda" icon={Clock} label="Cão de Guarda (18h)" url="/api/admin/forcar-cao-guarda" variant="outline" />
            <ActionButton nome="Agenda de Amanhã" icon={Clock} label="Agenda de Amanhã (19h)" url="/api/admin/forcar-agenda-amanha" variant="outline" />
          </CardContent>
        </Card>

        {/* Push Notifications */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="h-5 w-5 text-primary" />
              Push Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Envia uma notificação push de teste para o teu dispositivo.
            </p>
            <ActionButton nome="Push de Teste" icon={Bell} label="Enviar Push de Teste" url="/api/admin/push-teste" />
          </CardContent>
        </Card>

        {/* Zona de Perigo */}
        <Card className="border-destructive/50 md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Zona de Perigo
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Apaga <strong>TODAS as Propriedades e Tarefas</strong> de todas as
              empresas. Ação irreversível.
            </p>
            <Button variant="destructive" className="w-full gap-2" onClick={() => setShowResetModal(true)} disabled={loading !== null}>
              <AlertTriangle className="h-4 w-4" />
              Hard Reset (Limpar DB)
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Modal Hard Reset */}
      <Dialog open={showResetModal} onOpenChange={(o) => !o && setShowResetModal(false)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Confirmar Hard Reset
            </DialogTitle>
            <DialogDescription>
              Esta ação vai apagar <strong>TODAS as Propriedades e Tarefas</strong>.
              Não pode ser desfeita. Escreve <strong>CONFIRMAR</strong> para continuar.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setShowResetModal(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="confirm-text">Escreve &ldquo;CONFIRMAR&rdquo;:</label>
            <Input id="confirm-text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="CONFIRMAR" className="font-mono" autoComplete="off" />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { setShowResetModal(false); setConfirmText(""); }} disabled={resetLoading}>Cancelar</Button>
          <Button type="button" variant="destructive" onClick={handleHardReset} disabled={confirmText !== "CONFIRMAR" || resetLoading}>
            {resetLoading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />A limpar…</>) : (<><AlertTriangle className="mr-2 h-4 w-4" />Apagar Tudo</>)}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
