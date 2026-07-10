"use client";

import { useCallback, useEffect, useState } from "react";
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
  Bell,
  Clock,
  Save,
  Settings,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

export default function SistemaPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  // Tab 2 — Config da empresa.
  const [configNome, setConfigNome] = useState("");
  const [configApiKey, setConfigApiKey] = useState("");
  const [configMascarada, setConfigMascarada] = useState("");
  const [configTemKey, setConfigTemKey] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [editApiKey, setEditApiKey] = useState(false);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  const carregarConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await fetch("/api/admin/config-empresa", { credentials: "include" });
      const data = await res.json();
      if (res.ok) {
        setConfigNome(data.nome || "");
        setConfigMascarada(data.smoobu_api_key_mascarada || "");
        setConfigTemKey(data.tem_api_key || false);
      }
    } catch {
      // silencioso
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarConfig();
  }, [carregarConfig]);

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

  async function salvarConfig(e: React.FormEvent) {
    e.preventDefault();
    setConfigSaving(true);
    setToast(null);
    try {
      const body: Record<string, string> = {};
      if (configNome) body.nome = configNome;
      if (editApiKey && configApiKey) body.smoobu_api_key = configApiKey;

      const res = await fetch("/api/admin/config-empresa", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setConfigMascarada(data.smoobu_api_key_mascarada || "");
      setConfigTemKey(data.tem_api_key || false);
      setEditApiKey(false);
      setConfigApiKey("");
      showToast("sucesso", data.message || "Configuração guardada com sucesso.");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao guardar configuração.");
    } finally {
      setConfigSaving(false);
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
            <p className="text-sm text-muted-foreground">Operações, manutenção e configuração</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => (window.location.href = "/admin")} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <Button variant="ghost" className="text-sm text-muted-foreground hover:text-destructive" onClick={() => fazerLogout()}>
            <LogOut className="mr-2 h-4 w-4" />
            Sair
          </Button>
        </div>
      </div>

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

      {/* Tabs */}
      <Tabs defaultValue="operacoes" className="w-full">
        <TabsList>
          <TabsTrigger value="operacoes" className="gap-1.5">
            <Wrench className="h-4 w-4" />
            Operações
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-1.5">
            <Settings className="h-4 w-4" />
            Configuração
          </TabsTrigger>
        </TabsList>

        {/* =================== TAB 1: OPERAÇÕES =================== */}
        <TabsContent value="operacoes" className="mt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Sincronizações */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="h-5 w-5 text-primary" />
                  Sincronizações Smoobu
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Importa propriedades, sincroniza reservas e regista webhooks.</p>
                <ActionButton nome="Sincronizar Propriedades" icon={Building2} label="Importar Propriedades" url="/api/admin/sincronizar-propriedades" variant="outline" />
                <ActionButton nome="Sincronizar Reservas" icon={Calendar} label="Sincronizar Reservas" url="/api/admin/sincronizar-reservas" variant="outline" />
                <ActionButton nome="Registrar Webhooks" icon={Webhook} label="Registrar Webhooks" url="/api/admin/registrar-webhooks" variant="outline" />
              </CardContent>
            </Card>

            {/* Forçar Rotinas */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-5 w-5 text-primary" />
                  Forçar Rotinas (Cron Jobs)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Dispara manualmente os cron jobs diários.</p>
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
                <p className="text-sm text-muted-foreground">Envia uma notificação push de teste para o teu dispositivo.</p>
                <ActionButton nome="Push de Teste" icon={Bell} label="Enviar Push de Teste" url="/api/admin/push-teste" />
              </CardContent>
            </Card>

            {/* Zona de Perigo */}
            <Card className="border-destructive/50">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  Zona de Perigo
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Apaga <strong>TODAS as Propriedades e Tarefas</strong>. Ação irreversível.
                </p>
                <Button variant="destructive" className="w-full gap-2" onClick={() => setShowResetModal(true)} disabled={loading !== null}>
                  <AlertTriangle className="h-4 w-4" />
                  Hard Reset (Limpar DB)
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* =================== TAB 2: CONFIGURAÇÃO =================== */}
        <TabsContent value="config" className="mt-4">
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings className="h-5 w-5 text-primary" />
                Configuração da Empresa
              </CardTitle>
            </CardHeader>
            <CardContent>
              {configLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  A carregar configuração…
                </div>
              ) : (
                <form onSubmit={salvarConfig} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="cfg-nome">Nome da Empresa</label>
                    <Input id="cfg-nome" value={configNome} onChange={(e) => setConfigNome(e.target.value)} placeholder="Nome da empresa" />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Smoobu API Key</label>
                    {editApiKey ? (
                      <div className="space-y-2">
                        <Input
                          type="password"
                          value={configApiKey}
                          onChange={(e) => setConfigApiKey(e.target.value)}
                          placeholder="Cola aqui a API Key do Smoobu"
                          autoComplete="off"
                        />
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setEditApiKey(false); setConfigApiKey(""); }}>
                          Cancelar
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono text-muted-foreground">
                          {configTemKey ? configMascarada : "Não configurada"}
                        </code>
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditApiKey(true)}>
                          {configTemKey ? "Alterar" : "Definir"}
                        </Button>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Cada empresa (tenant) pode ter a sua própria API Key do Smoobu.
                      Quando definida, substitui a variável de ambiente global.
                    </p>
                  </div>

                  <Button type="submit" disabled={configSaving} className="gap-2">
                    {configSaving ? (
                      <><Loader2 className="h-4 w-4 animate-spin" />A guardar…</>
                    ) : (
                      <><Save className="h-4 w-4" />Guardar Configuração</>
                    )}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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
