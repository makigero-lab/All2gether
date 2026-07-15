"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Save,
  Bell,
  Clock,
  Webhook,
  Calendar,
  Settings,
  Power,
  ListChecks,
  UserSearch,
  Route,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { WebhookLogsCard } from "@/components/admin/webhook-logs-card";

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

/**
 * Gaveta da Empresa — /admin/empresas/[id] (Prompt 117).
 *
 * Ecrã exclusivo do Super Admin para gerir um tenant específico. Move para
 * aqui TODO o "Cockpit de Sistema" que era global:
 *   - Smoobu API Key (input + guardar)
 *   - Sincronizar Reservas / Propriedades (scoped a esta empresa)
 *   - Registar Webhooks (scoped)
 *   - Forçar Rotinas (Daily Briefing, Agenda de Amanhã — globais, mas o
 *     admin vê o resultado aqui)
 *   - Push Notification de Teste
 *   - Hard Reset (scoped a esta empresa — apaga só propriedades+tarefas)
 *
 * Também permite Suspender/Ativar a empresa (toggle do campo `ativa`).
 */
export default function EmpresaGavetaPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const empresaId = params?.id;

  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  // Config da empresa.
  const [nome, setNome] = useState("");
  const [ativa, setAtiva] = useState<boolean | null>(null);
  const [apiKeyMascarada, setApiKeyMascarada] = useState("");
  const [temApiKey, setTemApiKey] = useState(false);
  const [editApiKey, setEditApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  const carregarConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await fetch(`/api/admin/empresas/${empresaId}/config`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) {
        setNome(data.nome || "");
        setAtiva(data.ativa !== false);
        setApiKeyMascarada(data.smoobu_api_key_mascarada || "");
        setTemApiKey(data.tem_api_key || false);
      } else {
        showToast("erro", data?.erro || "Erro ao carregar configuração.");
      }
    } catch {
      showToast("erro", "Erro ao carregar configuração.");
    } finally {
      setConfigLoading(false);
    }
  }, [empresaId]);

  // Auth check.
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
        return carregarConfig();
      })
      .catch(() => {
        if (!redirecionado) router.replace("/login");
      });
  }, [router, carregarConfig]);

  async function executarAcao(nomeAcao: string, url: string, method: "POST" | "DELETE" = "POST") {
    setLoading(nomeAcao);
    setToast(null);
    try {
      const res = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || data?.message || `Erro ${res.status}`);
      showToast("sucesso", data?.message || `${nomeAcao} concluído.`);
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : `Erro em ${nomeAcao}.`);
    } finally {
      setLoading(null);
    }
  }

  async function handleSalvarConfig(e: React.FormEvent) {
    e.preventDefault();
    setConfigSaving(true);
    setToast(null);
    try {
      const body: Record<string, string> = {};
      if (nome) body.nome = nome;
      if (editApiKey && apiKeyInput) body.smoobu_api_key = apiKeyInput;
      const res = await fetch(`/api/admin/empresas/${empresaId}/config`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setApiKeyMascarada(data.smoobu_api_key_mascarada || "");
      setTemApiKey(data.tem_api_key || false);
      setEditApiKey(false);
      setApiKeyInput("");
      showToast("sucesso", data.message || "Configuração guardada.");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao guardar.");
    } finally {
      setConfigSaving(false);
    }
  }

  async function handleToggleStatus() {
    setTogglingStatus(true);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/empresas/${empresaId}/toggle-status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativa: !ativa }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setAtiva(data.empresa?.ativa);
      showToast("sucesso", data.message || "Estado alterado.");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao alterar estado.");
    } finally {
      setTogglingStatus(false);
    }
  }

  async function handleHardReset() {
    if (confirmText !== "CONFIRMAR") return;
    setResetLoading(true);
    try {
      const res = await fetch(`/api/admin/empresas/${empresaId}/hard-reset`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
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
        disabled={loading !== null || togglingStatus}
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

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Cabeçalho com voltar */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/admin")} title="Voltar à lista de empresas">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Building2 className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {configLoading ? "A carregar…" : nome || "Empresa"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Gaveta de gestão do tenant — integrações, automação e manutenção
          </p>
        </div>
        {/* Badge de estado + botão Suspender/Ativar */}
        {ativa !== null && (
          <div className="flex items-center gap-2">
            <Badge variant={ativa ? "default" : "destructive"}>
              {ativa ? "Ativa" : "Suspensa"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleStatus}
              disabled={togglingStatus}
              className={
                ativa
                  ? "text-amber-600 border-amber-400 hover:bg-amber-50"
                  : "text-emerald-600 border-emerald-400 hover:bg-emerald-50"
              }
            >
              {togglingStatus ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Power className="mr-1.5 h-4 w-4" />
              )}
              {ativa ? "Suspender" : "Ativar"}
            </Button>
          </div>
        )}
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

      {/* Aviso de empresa suspensa */}
      {ativa === false && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>
              Esta empresa está <strong>suspensa</strong>. Logins estão bloqueados e os webhooks do Smoobu são rejeitados.
              Carrega em <strong>Ativar</strong> para restaurar o acesso.
            </span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Configuração Smoobu */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings className="h-5 w-5 text-primary" />
              Configuração Smoobu
            </CardTitle>
          </CardHeader>
          <CardContent>
            {configLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
              </div>
            ) : (
              <form onSubmit={handleSalvarConfig} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="cfg-nome">Nome da Empresa</label>
                  <Input id="cfg-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome da empresa" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Smoobu API Key</label>
                  {editApiKey ? (
                    <div className="space-y-2">
                      <Input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="Cola aqui a API Key do Smoobu"
                        autoComplete="off"
                      />
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setEditApiKey(false); setApiKeyInput(""); }}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono text-muted-foreground">
                        {temApiKey ? apiKeyMascarada : "Não configurada"}
                      </code>
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditApiKey(true)}>
                        {temApiKey ? "Alterar" : "Definir"}
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Cada empresa tem a sua própria API Key do Smoobu. Substitui a variável de ambiente global.
                  </p>
                </div>
                <Button type="submit" disabled={configSaving} className="gap-2">
                  {configSaving ? <><Loader2 className="h-4 w-4 animate-spin" />A guardar…</> : <><Save className="h-4 w-4" />Guardar</>}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* Sincronizações Smoobu */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5 text-primary" />
              Sincronizações Smoobu
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Importa propriedades, sincroniza reservas e regista webhooks (scoped a esta empresa).</p>
            <ActionButton nome="Importar Propriedades" icon={Building2} label="Importar Propriedades" url={`/api/admin/empresas/${empresaId}/sincronizar-propriedades`} variant="outline" />
            <ActionButton nome="Sincronizar Reservas" icon={Calendar} label="Sincronizar Reservas" url={`/api/admin/empresas/${empresaId}/sincronizar-reservas`} variant="outline" />
            <ActionButton nome="Registrar Webhooks" icon={Webhook} label="Registrar Webhooks" url={`/api/admin/empresas/${empresaId}/registrar-webhooks`} variant="outline" />
          </CardContent>
        </Card>

        {/* Forçar Rotinas (globais) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-5 w-5 text-primary" />
              Forçar Rotinas (Cron Jobs)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Dispara manualmente os cron jobs diários (correm para todas as empresas).</p>
            <ActionButton nome="Daily Briefing" icon={Clock} label="Daily Briefing (08h)" url="/api/admin/forcar-daily-briefing" variant="outline" />
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

        {/* Prompt 135 — Seed de Checklists */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="h-5 w-5 text-primary" />
              Checklists Padrão
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Cria 2 modelos de checklist (&ldquo;Limpeza Standard&rdquo; e &ldquo;Limpeza Detalhada V2&rdquo;)
              e associa o modelo Standard a todas as propriedades desta empresa.
              Idempotente — pode ser corrido múltiplas vezes.
            </p>
            <ActionButton
              nome="Seed Checklists"
              icon={ListChecks}
              label="Criar Checklists Padrão"
              url={`/api/admin/seed-checklists?empresa_id=${empresaId}`}
            />
          </CardContent>
        </Card>

        {/* Prompt 137 — Backfill de Nomes de Hóspedes */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserSearch className="h-5 w-5 text-primary" />
              Nomes de Hóspedes em Falta
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Percorre as tarefas desta empresa com reserva do Smoobu mas sem nome
              de hóspede e busca o nome via REST API do Smoobu. Útil para preencher
              nomes em tarefas antigas criadas antes do fix do enriquecimento.
              Requer <strong>API Key do Smoobu</strong> configurada.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={async () => {
                setLoading("Backfill Nomes");
                setToast(null);
                try {
                  const res = await fetch("/api/admin/backfill-nomes-hospedes", {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ empresa_id: empresaId }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
                  showToast(
                    "sucesso",
                    `Backfill concluído: ${data.atualizadas} de ${data.totalTarefas} tarefas atualizadas${data.falhadas ? ` (${data.falhadas} sem nome no Smoobu)` : ""}.`
                  );
                } catch (e) {
                  showToast("erro", e instanceof Error ? e.message : "Erro no backfill.");
                } finally {
                  setLoading(null);
                }
              }}
              disabled={loading !== null}
            >
              {loading === "Backfill Nomes" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserSearch className="h-4 w-4" />
              )}
              {loading === "Backfill Nomes" ? "A executar…" : "Preencher Nomes em Falta"}
            </Button>
          </CardContent>
        </Card>

        {/* Prompt 139 — Backfill de Tempos de Viagem */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Route className="h-5 w-5 text-primary" />
              Tempos de Viagem em Falta
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Percorre as tarefas atribuídas desta empresa sem tempo de viagem
              calculado e estima a deslocação (Haversine, máx. 60min) com base
              na tarefa anterior do mesmo funcionário no mesmo dia. Útil para
              preencher viagens em tarefas antigas criadas antes do Prompt 138.
              <strong> Não requer API Key</strong> — usa as coordenadas das propriedades.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={async () => {
                setLoading("Backfill Viagens");
                setToast(null);
                try {
                  const res = await fetch("/api/admin/backfill-tempos-viagem", {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ empresa_id: empresaId }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
                  showToast(
                    "sucesso",
                    `Backfill concluído: ${data.atualizadas} de ${data.totalTarefas} tarefas com viagem calculada${data.semViagem ? ` (${data.semViagem} sem viagem — 1ª do dia)` : ""}.`
                  );
                } catch (e) {
                  showToast("erro", e instanceof Error ? e.message : "Erro no backfill.");
                } finally {
                  setLoading(null);
                }
              }}
              disabled={loading !== null}
            >
              {loading === "Backfill Viagens" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Route className="h-4 w-4" />
              )}
              {loading === "Backfill Viagens" ? "A executar…" : "Calcular Tempos de Viagem"}
            </Button>
          </CardContent>
        </Card>

        {/* Prompt 140 — Caixa Negra de Webhooks (filtrada por empresa) */}
        {empresaId && <WebhookLogsCard empresaId={empresaId} />}

        {/* Zona de Perigo (Hard Reset scoped) */}
        <Card className="border-destructive/50 md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Zona de Perigo
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Apaga <strong>TODAS as Propriedades e Tarefas DESTA empresa</strong> (não afeta outras empresas). Ação irreversível.
            </p>
            <Button variant="destructive" className="w-full gap-2" onClick={() => setShowResetModal(true)} disabled={loading !== null || togglingStatus}>
              <AlertTriangle className="h-4 w-4" />
              Hard Reset (desta empresa)
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
              Esta ação vai apagar <strong>TODAS as Propriedades e Tarefas de &ldquo;{nome}&rdquo;</strong>.
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
