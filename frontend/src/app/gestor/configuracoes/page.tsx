"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Save,
  Building2,
  Webhook,
  Clock,
  CheckCircle2,
  AlertCircle,
  Settings,
  ScrollText,
  RefreshCw,
  Eye,
  EyeOff,
  Trash2,
  Download,
  ShieldAlert,
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
import { adminGet, adminDelete, adminPost } from "@/lib/api";
import { lerUtilizador, type Role } from "@/lib/auth";

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

// Prompt 126 — Tipos para os logs de webhooks (smoobu) exibidos no modal.
interface WebhookLogDTO {
  _id: string;
  payload: Record<string, unknown>;
  status: "recebido" | "processado" | "erro";
  erro_msg: string | null;
  createdAt: string;
}
interface WebhooksResponse {
  webhooks: WebhookLogDTO[];
  total: number;
}

/**
 * /gestor/configuracoes — Página principal de Configurações.
 *
 * FIX (centraliza ações smoobu) — Esta página é o ponto central de configuração
 * do gestor. O cliente acede aqui (não à sub-página de integrações) pelo menu
 * lateral "Configurações". Por isso:
 *   - Lê `smoobu_ativo` do backend e mostra o estado real da integração.
 *   - Se smoobu_ativo for true mas a chave da BD estiver vazia (configurada
 *     via env var global), mostra um placeholder verde "Configurada (Global/Env)".
 *   - A secção "Ações de Manutenção" (Eliminar Limpezas Futuras + Sincronizar
 *     Smoobu) vive aqui, visível apenas para admin.
 */
export default function ConfiguracoesPage() {
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [nome, setNome] = useState("");
  const [apiKeyMascarada, setApiKeyMascarada] = useState("");
  const [temApiKey, setTemApiKey] = useState(false);
  const [editApiKey, setEditApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  // FIX (status smoobu configs principais) — Estado real da integração Smoobu
  // (env var SMOOBU_API_KEY OU chave da BD). Se for true mas temApiKey for
  // false, a key está configurada via env var global → mostrar placeholder verde.
  const [smoobuAtivo, setSmoobuAtivo] = useState(false);

  // FIX (ações de massa no admin) — A secção "Ações de Manutenção" só é
  // visível para role === 'admin'.
  const [userRole, setUserRole] = useState<Role | null>(null);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      // FIX (cache-busting) — Adiciona timestamp para evitar cache do Next.js.
      const res = await fetch(
        `/api/gestor/configuracoes?_t=${Date.now()}`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (res.ok) {
        setNome(data.nome || "");
        setApiKeyMascarada(data.smoobu_api_key_mascarada || "");
        setTemApiKey(data.tem_api_key || false);
        setSmoobuAtivo(data.smoobu_ativo || false);
      }
    } catch {
      // silencioso
    } finally {
      setLoading(false);
    }
  }, []);

  // FIX (ações de massa no admin) — Carrega o role do utilizador.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (!cancelado) setUserRole(user?.role ?? null);
    })();
    return () => { cancelado = true; };
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const body: Record<string, string> = {};
      if (nome) body.nome = nome;
      if (editApiKey && apiKeyInput) body.smoobu_api_key = apiKeyInput;

      const res = await fetch("/api/gestor/configuracoes", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setApiKeyMascarada(data.smoobu_api_key_mascarada || "");
      setTemApiKey(data.tem_api_key || false);
      setSmoobuAtivo(data.smoobu_ativo || false);
      setEditApiKey(false);
      setApiKeyInput("");
      showToast("sucesso", data.message || "Configuração guardada.");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function executarAcao(nomeAcao: string, url: string) {
    setActionLoading(nomeAcao);
    setToast(null);
    try {
      const res = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.erro || data?.message || `Erro ${res.status}`);
      showToast("sucesso", data?.message || `${nomeAcao} concluído.`);
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : `Erro em ${nomeAcao}.`);
    } finally {
      setActionLoading(null);
    }
  }

  // FIX (ações de manutenção) — Handlers para Eliminar Futuras e Sincronizar Smoobu.
  const [confirmarLimpar, setConfirmarLimpar] = useState(false);
  const [limpando, setLimpando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  async function handleEliminarFuturas() {
    setLimpando(true);
    setConfirmarLimpar(false);
    try {
      const res = await adminDelete<{ mensagem: string; apagadas: number }>(
        "/api/gestor/tarefas/futuras"
      );
      const msg = res.mensagem || `${res.apagadas} tarefa(s) apagada(s).`;
      showToast("sucesso", msg);
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao apagar.");
    } finally {
      setLimpando(false);
    }
  }

  async function handleSincronizarSmoobu() {
    setSincronizando(true);
    try {
      const res = await adminPost<{
        totalRecebidas: number; criadas: number; existentes: number; erros: number;
        message?: string;
      }>("/api/gestor/smoobu/sincronizar", {});
      const msg = res.message ||
        `${res.criadas} tarefa(s) criada(s)` +
        (res.existentes > 0 ? `, ${res.existentes} já existiam` : "") +
        (res.erros > 0 ? `, ${res.erros} com erro` : "") + ".";
      showToast("sucesso", msg);
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao sincronizar.");
    } finally {
      setSincronizando(false);
    }
  }

  // Prompt 126 — Modal de Logs de Sincronização Smoobu (webhooks).
  const [mostrarLogs, setMostrarLogs] = useState(false);
  const [logs, setLogs] = useState<WebhookLogDTO[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsErro, setLogsErro] = useState<string | null>(null);

  const carregarLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsErro(null);
    try {
      const res = await adminGet<WebhooksResponse>("/api/gestor/webhooks");
      setLogs(res.webhooks ?? []);
    } catch (e) {
      setLogsErro(e instanceof Error ? e.message : "Erro ao carregar logs.");
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mostrarLogs) {
      carregarLogs();
    }
  }, [mostrarLogs, carregarLogs]);

  function formatarDataLog(iso: string): string {
    try {
      return new Date(iso).toLocaleString("pt-PT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function extrairEvento(payload: WebhookLogDTO["payload"]): string {
    const action = (payload?.action as string | undefined) ??
      ((payload?.content as Record<string, unknown> | undefined)?.action as string | undefined);
    return action ?? "—";
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        A carregar configuração…
      </div>
    );
  }

  // FIX (status smoobu configs principais) — Determina o texto a mostrar no
  // input da API Key. Se smoobu_ativo for true mas a chave da BD estiver vazia,
  // mostra um placeholder verde "Configurada (Global/Env)" em vez de "Não
  // configurada" — indica que a integração está ativa via env var global.
  const keyConfiguradaGlobal = smoobuAtivo && !temApiKey;
  const keyDisplayText = temApiKey
    ? apiKeyMascarada
    : keyConfiguradaGlobal
      ? "Configurada (Global/Env)"
      : "Não configurada";

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">Configurações</h1>
      </div>

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
        {/* Configuração da Empresa */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-5 w-5 text-primary" />
              Dados da Empresa
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSalvar} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="cfg-nome">Nome da Empresa</label>
                <Input id="cfg-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome da empresa" />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Smoobu API Key</label>
                {/* FIX (status smoobu configs principais) — Badge de estado real. */}
                <div className="flex items-center gap-2">
                  {smoobuAtivo ? (
                    <Badge variant="success" className="shrink-0 gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Ativo
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      Inativo
                    </Badge>
                  )}
                  {keyConfiguradaGlobal && (
                    <Badge variant="outline" className="shrink-0 border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
                      Global/Env
                    </Badge>
                  )}
                </div>
                {editApiKey ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <Input type={showApiKey ? "text" : "password"} value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="Cola aqui a API Key do Smoobu" autoComplete="off" className="pr-10" />
                      <button type="button" onClick={() => setShowApiKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showApiKey ? "Ocultar" : "Mostrar"}>
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setEditApiKey(false); setApiKeyInput(""); }}>Cancelar</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <code
                      className={`flex-1 rounded-md border px-3 py-2 text-sm font-mono ${
                        keyConfiguradaGlobal
                          ? "border-emerald-500/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                          : "bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      {keyDisplayText}
                    </code>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditApiKey(true)}>
                      {temApiKey ? "Alterar" : "Definir"}
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {keyConfiguradaGlobal
                    ? "A integração está ativa via variável de ambiente global (SMOOBU_API_KEY). Podes definir uma chave específica da empresa que terá prioridade sobre a global."
                    : "Cada empresa tem a sua própria API Key do Smoobu. Substitui a variável de ambiente global."}
                </p>
              </div>

              <Button type="submit" disabled={saving} className="gap-2">
                {saving ? <><Loader2 className="h-4 w-4 animate-spin" />A guardar…</> : <><Save className="h-4 w-4" />Guardar</>}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Ações Smoobu */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Webhook className="h-5 w-5 text-primary" />
              Ações Smoobu
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              O sistema é 100% reativo a webhooks — o Smoobu envia eventos que
              são processados automaticamente. A API Key é usada para validar
              a autenticidade dos webhooks recebidos.
            </p>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Registrar Webhooks", "/api/admin/registrar-webhooks")} disabled={actionLoading !== null}>
              {actionLoading === "Registrar Webhooks" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Webhook className="h-4 w-4" />}
              Registrar Webhooks
            </Button>
            {/* Prompt 126 — Botão para abrir o modal de logs de sincronização Smoobu. */}
            <Button variant="outline" className="w-full gap-2" onClick={() => setMostrarLogs(true)}>
              <ScrollText className="h-4 w-4" />
              Logs de Webhooks Smoobu
            </Button>
          </CardContent>
        </Card>

        {/* Testes Manuais (Cron Jobs) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-5 w-5 text-primary" />
              Testes Manuais (Cron Jobs)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Dispara as rotinas para a tua empresa.</p>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Daily Briefing", "/api/gestor/configuracoes/forcar-daily-briefing")} disabled={actionLoading !== null}>
              {actionLoading === "Daily Briefing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Forçar Daily Briefing
            </Button>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Agenda de Amanhã", "/api/gestor/configuracoes/forcar-agenda-amanha")} disabled={actionLoading !== null}>
              {actionLoading === "Agenda de Amanhã" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Forçar Agenda de Amanhã
            </Button>
          </CardContent>
        </Card>

        {/* FIX (centraliza ações smoobu) — Secção "Ações de Manutenção"
            movida para a página principal de Configurações (visível para admin).
            Contém ações destrutivas em massa (Eliminar Limpezas Futuras) e
            sincronização do Smoobu. */}
        {userRole === "admin" && (
        <Card className="border-destructive/30 md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <ShieldAlert className="h-5 w-5" />
              Ações de Manutenção
              <Badge variant="outline" className="ml-1 text-[10px]">Admin</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Ações destrutivas em massa e sincronização do Smoobu. Restritas
              ao <strong>admin</strong> por segurança. Usa-as apenas quando
              necessário (ex.: sincronização inicial, reset do calendário,
              recriar limpezas a partir das reservas ativas).
            </p>
            <div className="flex flex-wrap gap-2">
              {/* Sincronizar Smoobu — recria limpezas futuras a partir das
                  reservas ativas (POST /api/gestor/smoobu/sincronizar). */}
              <Button
                variant="outline"
                onClick={handleSincronizarSmoobu}
                disabled={sincronizando}
                title="Recria as limpezas futuras a partir das reservas ativas do Smoobu."
              >
                {sincronizando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {sincronizando ? "A sincronizar…" : "Sincronizar Smoobu"}
              </Button>

              {/* Eliminar Limpezas Futuras */}
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmarLimpar(true)}
                disabled={limpando}
                title="Apaga todas as tarefas futuras não concluídas/canceladas (limpa a agenda)."
              >
                {limpando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Eliminar Limpezas Futuras
              </Button>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Aviso para não-admin: explica onde estão as ações de massa. */}
        {userRole !== null && userRole !== "admin" && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-100 md:col-span-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Ações de Manutenção restritas ao Admin</p>
              <p className="text-xs">
                As ações destrutivas em massa (Eliminar Limpezas Futuras) e a
                sincronização do Smoobu estão restritas ao administrador por
                segurança. Contacta o administrador se precisares de executá-las.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* FIX (ações de manutenção) — Dialog de confirmação: Eliminar Limpezas
          Futuras. */}
      <Dialog open={confirmarLimpar} onOpenChange={setConfirmarLimpar}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Eliminar Limpezas Futuras
          </DialogTitle>
          <DialogDescription>
            Isto vai apagar todas as tarefas não concluídas de hoje para a frente.
            As concluídas e canceladas serão preservadas. Queres continuar?
          </DialogDescription>
          <DialogClose onClick={() => setConfirmarLimpar(false)} />
        </DialogHeader>
        <DialogContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Depois de apagar, podes clicar em &ldquo;Sincronizar Smoobu&rdquo; para recriar
            as tarefas a partir das reservas ativas.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmarLimpar(false)}
            disabled={limpando}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleEliminarFuturas}
            disabled={limpando}
          >
            {limpando ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                A apagar…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                Sim, apagar
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Prompt 126 — Modal de Logs de Sincronização Smoobu (webhooks). */}
      <Dialog open={mostrarLogs} onOpenChange={setMostrarLogs}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="h-5 w-5 text-primary" />
              Logs de Sincronização Smoobu
            </DialogTitle>
            <DialogDescription>
              Histórico de webhooks recebidos do Smoobu (ordem decrescente).
            </DialogDescription>
          </div>
          <DialogClose onClick={() => setMostrarLogs(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {logs.length} webhook(s)
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={carregarLogs}
              disabled={logsLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
          </div>

          {logsLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              A carregar logs…
            </div>
          ) : logsErro ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{logsErro}</span>
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <ScrollText className="h-8 w-8 opacity-40" />
              <p className="text-sm">Sem webhooks registados.</p>
              <p className="text-xs">
                Quando o Smoobu enviar uma reserva, o evento aparecerá aqui.
              </p>
            </div>
          ) : (
            <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
              {logs.map((w) => {
                const evento = extrairEvento(w.payload);
                const variant =
                  w.status === "processado"
                    ? "success"
                    : w.status === "erro"
                    ? "destructive"
                    : "outline";
                const label =
                  w.status === "processado"
                    ? "Processado"
                    : w.status === "erro"
                    ? "Erro"
                    : "Recebido";
                return (
                  <li key={w._id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={variant} className="shrink-0 text-[10px]">
                          {label}
                        </Badge>
                        <span className="truncate text-sm font-medium">
                          {evento}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatarDataLog(w.createdAt)}
                      </span>
                      {w.erro_msg && (
                        <span className="text-xs text-destructive">
                          {w.erro_msg}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
