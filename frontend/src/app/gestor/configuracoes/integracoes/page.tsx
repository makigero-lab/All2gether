"use client";

/**
 * Página: /gestor/configuracoes/integracoes (HF6)
 *
 * Gestão descentralizada das integrações externas (Smoobu) e rotinas de
 * sincronização automática. Antes desta página, a configuração do Smoobu
 * vivia na Nave-Mãe (Autocell); agora passa a viver no All2gether.
 *
 * Comunica com:
 *   GET  /api/gestor/configuracoes/integracoes  → lê config atual
 *   PUT  /api/gestor/configuracoes/integracoes  → guarda config
 *   POST /api/gestor/smoobu/propriedades        → importar propriedades (manual)
 */

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Save,
  Key,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertCircle,
  Plug,
  Power,
  Building2,
  Eye,
  EyeOff,
  Download,
  Trash2,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { adminGet, adminPut, adminPost, adminDelete } from "@/lib/api";
import { lerUtilizador, type Role } from "@/lib/auth";

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

interface IntegracoesConfig {
  smoobu: {
    api_key_mascarada: string;
    configurado: boolean;
    ativo: boolean;
    ultima_sincronizacao: string | null;
  };
  rotinas: {
    sincronizacao_automatica: boolean;
    frequencia_horas: number;
  };
  env_var_ativa: boolean;
  // FIX (status smoobu real) — Estado real da integração Smoobu (chave na BD
  // OU env var). O frontend usa este booleano para mostrar a bolinha verde.
  smoobu_ativo?: boolean;
  // FIX (google maps integration) — Indica se o Google Maps está configurado.
  google_maps_ativo?: boolean;
}

function formatarData(iso: string | null): string {
  if (!iso) return "Nunca";
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

export default function IntegracoesPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  // FIX (ações de massa no admin) — A secção de Ações de Manutenção só é
  // visível/utilizável para role === 'admin'. Os gestores vêem a config do
  // Smoobu mas não podem disparar ações destrutivas em massa.
  const [userRole, setUserRole] = useState<Role | null>(null);
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const user = await lerUtilizador();
      if (!cancelado) setUserRole(user?.role ?? null);
    })();
    return () => { cancelado = true; };
  }, []);

  // Estado do formulário.
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [editApiKey, setEditApiKey] = useState(false);
  const [limparChave, setLimparChave] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [smoobuAtivo, setSmoobuAtivo] = useState(false);
  const [sincronizacaoAutomatica, setSincronizacaoAutomatica] = useState(false);
  const [frequenciaHoras, setFrequenciaHoras] = useState(24);

  // HF24 — Estados para "Ações Manuais de Emergência" (movidas de /gestor/tarefas).
  const [sincronizando, setSincronizando] = useState(false);
  const [limpando, setLimpando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [confirmarLimpar, setConfirmarLimpar] = useState(false);
  const [resultadoEmergencia, setResultadoEmergencia] = useState<string | null>(null);

  /** HF24 — Sincroniza reservas futuras do Smoobu (pull via REST API). */
  async function handleSincronizar() {
    setSincronizando(true);
    setResultadoEmergencia(null);
    try {
      const res = await adminPost<{
        totalRecebidas: number; criadas: number; existentes: number; erros: number;
      }>("/api/gestor/smoobu/sincronizar", {});
      let msg = `${res.criadas} tarefa(s) criada(s)`;
      if (res.existentes > 0) msg += `, ${res.existentes} já existiam`;
      if (res.erros > 0) msg += `, ${res.erros} com erro`;
      setResultadoEmergencia(msg + ".");
      showToast("sucesso", msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao sincronizar.";
      setResultadoEmergencia(msg);
      showToast("erro", `Sincronização falhou: ${msg}`);
    } finally {
      setSincronizando(false);
    }
  }

  /** HF24 — Importa propriedades do Smoobu. */
  async function handleImportar() {
    setImportando(true);
    setResultadoEmergencia(null);
    try {
      const res = await adminPost<{
        criadas: number; atualizadas: number; existentes: number; erros: number; message?: string;
      }>("/api/gestor/smoobu/propriedades", {});
      const msg = res.message || `${res.criadas} importada(s), ${res.atualizadas} atualizada(s).`;
      setResultadoEmergencia(msg);
      showToast("sucesso", msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao importar.";
      setResultadoEmergencia(msg);
      showToast("erro", `Importação falhou: ${msg}`);
    } finally {
      setImportando(false);
    }
  }

  /** HF24 — Limpa tarefas futuras (reset do calendário). */
  async function handleLimparFuturas() {
    setLimpando(true);
    setConfirmarLimpar(false);
    try {
      const res = await adminDelete<{ mensagem: string; apagadas: number }>(
        "/api/gestor/tarefas/futuras"
      );
      const msg = res.mensagem || `${res.apagadas} tarefa(s) apagada(s).`;
      setResultadoEmergencia(msg);
      showToast("sucesso", msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao apagar.";
      setResultadoEmergencia(msg);
      showToast("erro", `Limpeza falhou: ${msg}`);
    } finally {
      setLimpando(false);
    }
  }

  // Estado exibido (da BD).
  const [apiKeyMascarada, setApiKeyMascarada] = useState("");
  const [temApiKey, setTemApiKey] = useState(false);
  const [ultimaSincronizacao, setUltimaSincronizacao] = useState<string | null>(null);
  const [envVarAtiva, setEnvVarAtiva] = useState(false);

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      // FIX (bug status smoobu) — Cache-busting: adiciona um timestamp ao
      // query param para garantir que o browser/Next.js nunca sirva uma versão
      // em cache da resposta. Isto resolve o bug em que o cliente via "Não
      // configurada" mesmo depois de a env var estar ativa no backend.
      const url = `/api/gestor/configuracoes/integracoes?_t=${Date.now()}`;
      const data = await adminGet<IntegracoesConfig>(url);
      setApiKeyMascarada(data.smoobu.api_key_mascarada || "");
      setSmoobuAtivo(data.smoobu.ativo || false);
      setUltimaSincronizacao(data.smoobu.ultima_sincronizacao || null);
      setSincronizacaoAutomatica(data.rotinas.sincronizacao_automatica || false);
      setFrequenciaHoras(data.rotinas.frequencia_horas || 24);
      setEnvVarAtiva(data.env_var_ativa || false);
      // FIX (bug status smoobu) — smoobu_ativo (env var OU chave BD) é a fonte
      // de verdade. Lido de forma estrita: se for true, mostra "Configurada".
      // Se for undefined/false, faz fallback para env_var_ativa e configurado.
      const ativo =
        data.smoobu_ativo === true ||
        data.env_var_ativa === true ||
        data.smoobu?.configurado === true;
      setTemApiKey(ativo);
      setEditApiKey(false);
      setLimparChave(false);
      setApiKeyInput("");
    } catch (e) {
      showToast(
        "erro",
        e instanceof Error ? e.message : "Erro ao carregar configurações."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const body: {
        smoobu?: { api_key?: string; ativo?: boolean };
        rotinas?: { sincronizacao_automatica?: boolean; frequencia_horas?: number };
      } = {};

      // Só envia a chave se o utilizador a editou ou pediu para limpar.
      if (editApiKey || limparChave) {
        body.smoobu = { api_key: limparChave ? "" : apiKeyInput };
      }
      // Envia sempre o estado do toggle ativo.
      if (body.smoobu) {
        body.smoobu.ativo = smoobuAtivo;
      } else {
        body.smoobu = { ativo: smoobuAtivo };
      }
      body.rotinas = {
        sincronizacao_automatica: sincronizacaoAutomatica,
        frequencia_horas: frequenciaHoras,
      };

      interface PutResponse {
        message?: string;
        smoobu?: { api_key_mascarada: string; configurado: boolean; ultima_sincronizacao?: string | null };
        rotinas?: { frequencia_horas: number };
        // FIX (bug status smoobu) — smoobu_ativo + env_var_ativa devolvidos pelo PUT.
        smoobu_ativo?: boolean;
        env_var_ativa?: boolean;
      }
      const data = await adminPut<PutResponse>(
        "/api/gestor/configuracoes/integracoes",
        body
      );
      setApiKeyMascarada(data.smoobu?.api_key_mascarada || "");
      // FIX (bug status smoobu) — Usa smoobu_ativo (env var OU chave BD) como
      // fonte de verdade, com fallback para env_var_ativa e configurado.
      const ativo =
        data.smoobu_ativo === true ||
        data.env_var_ativa === true ||
        data.smoobu?.configurado === true;
      setTemApiKey(ativo);
      setEditApiKey(false);
      setLimparChave(false);
      setApiKeyInput("");
      showToast("sucesso", data.message || "Configurações guardadas.");
    } catch (e) {
      showToast("erro", e instanceof Error ? e.message : "Erro ao guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleImportarPropriedades() {
    setImportando(true);
    setToast(null);
    try {
      interface ImportResponse {
        message?: string;
        criadas?: number;
        atualizadas?: number;
        existentes?: number;
        erros?: number;
      }
      const data = await adminPost<ImportResponse>(
        "/api/gestor/smoobu/propriedades",
        {}
      );
      showToast(
        "sucesso",
        data.message ||
          `${data.criadas ?? 0} importada(s), ${data.atualizadas ?? 0} atualizada(s).`
      );
      // Atualiza o timestamp de última sincronização.
      await carregar();
    } catch (e) {
      showToast(
        "erro",
        e instanceof Error ? e.message : "Erro ao importar propriedades."
      );
    } finally {
      setImportando(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        A carregar configurações de integrações…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      {/* Cabeçalho */}
      <div className="flex items-center gap-3">
        <Plug className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Integrações &amp; Rotinas
          </h1>
          <p className="text-sm text-muted-foreground">
            Gestão descentralizada das integrações externas e sincronização
            automática.
          </p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
            toast.tipo === "sucesso"
              ? "border-emerald-500/50 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
              : "border-red-500/50 bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100"
          }`}
        >
          {toast.tipo === "sucesso" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Aviso: env var ativa */}
      {envVarAtiva && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Variável de ambiente SMOOBU_API_KEY ativa</p>
            <p className="text-xs">
              A chave da base de dados (acima) tem prioridade quando a integração
              está ativa. A env var serve apenas de fallback para retrocompatibilidade.
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSalvar} className="space-y-6">
        {/* Secção: Integração Smoobu */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              Integração Smoobu
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* API Key */}
            <div className="space-y-2">
              <label htmlFor="api-key" className="text-sm font-medium leading-none">
                API Key do Smoobu
              </label>
              {!editApiKey && !limparChave ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex h-10 min-w-[200px] flex-1 items-center rounded-md border bg-muted px-3 font-mono text-sm">
                    {temApiKey ? apiKeyMascarada : "Não configurada"}
                  </div>
                  {temApiKey ? (
                    <Badge variant="secondary" className="shrink-0">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Configurada
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      Por configurar
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditApiKey(true);
                      setLimparChave(false);
                    }}
                  >
                    {temApiKey ? "Substituir" : "Configurar"}
                  </Button>
                  {temApiKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-600"
                      onClick={() => {
                        setLimparChave(true);
                        setEditApiKey(false);
                        setApiKeyInput("");
                      }}
                    >
                      Limpar
                    </Button>
                  )}
                </div>
              ) : limparChave ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-md border border-red-500/50 bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950/50 dark:text-red-100">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>A chave será removida ao guardar.</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLimparChave(false)}
                  >
                    Cancelar
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Input
                      id="api-key"
                      type={showApiKey ? "text" : "password"}
                      placeholder="Cola aqui a API key do Smoobu"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      autoComplete="off"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showApiKey ? "Ocultar" : "Mostrar"}
                    >
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditApiKey(false);
                        setApiKeyInput("");
                      }}
                    >
                      Cancelar
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gera a API key no painel do Smoobu → Settings → API. A chave
                    é guardada na base de dados do All2gether (nunca exposta no
                    GET — só mascarada).
                  </p>
                </div>
              )}
            </div>

            {/* Toggle Ativo */}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Power className="h-4 w-4 text-muted-foreground" />
                <div>
                  <label htmlFor="smoobu-ativo" className="cursor-pointer text-sm font-medium leading-none">
                    Integração ativa
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Quando desativada, webhooks e sincronização do Smoobu são
                    ignorados (a chave mantém-se guardada).
                  </p>
                </div>
              </div>
              <Checkbox
                id="smoobu-ativo"
                checked={smoobuAtivo}
                onCheckedChange={(checked) => setSmoobuAtivo(checked === true)}
              />
            </div>

            {/* Última sincronização + Importar agora */}
            <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Última sincronização:</span>
                <span className="font-medium">{formatarData(ultimaSincronizacao)}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleImportarPropriedades}
                disabled={importando}
              >
                {importando ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Importar Propriedades
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Secção: Rotinas de Sincronização */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Rotinas de Sincronização
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Toggle Sincronização Automática */}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <div>
                  <label htmlFor="sync-auto" className="cursor-pointer text-sm font-medium leading-none">
                    Sincronização automática
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Um cron job corre a cada hora e sincroniza as propriedades
                    do Smoobu com a frequência definida abaixo.
                  </p>
                </div>
              </div>
              <Checkbox
                id="sync-auto"
                checked={sincronizacaoAutomatica}
                onCheckedChange={(checked) => setSincronizacaoAutomatica(checked === true)}
              />
            </div>

            {/* Frequência */}
            <div className="space-y-2">
              <label htmlFor="frequencia" className="text-sm font-medium leading-none">
                Frequência de sincronização
              </label>
              <select
                id="frequencia"
                value={frequenciaHoras}
                onChange={(e) => setFrequenciaHoras(Number(e.target.value))}
                className="flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value={1}>A cada 1 hora</option>
                <option value={6}>A cada 6 horas</option>
                <option value={12}>A cada 12 horas</option>
                <option value={24}>Diariamente (24h)</option>
              </select>
              <p className="text-xs text-muted-foreground">
                O cron job verifica a cada hora se passou o tempo desde a última
                sincronização. Se sim, dispara uma nova importação.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Botão Guardar */}
        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Guardar Configurações
          </Button>
        </div>
      </form>

      {/* Nota informativa */}
      <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <Building2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium text-foreground">Arquitetura descentralizada (HF6)</p>
          <p>
            A configuração do Smoobu passou a viver no All2gether (não mais na
            Nave-Mãe). Isto respeita o princípio de separation of concerns: cada
            satélite gere as suas próprias integrações. A variável de ambiente
            <code className="mx-1 rounded bg-muted px-1 py-0.5">SMOOBU_API_KEY</code>
            mantém-se como fallback para retrocompatibilidade.
          </p>
        </div>
      </div>

      {/* FIX (ações de massa no admin) — Secção "Ações de Manutenção" (antes
          "Ações Manuais de Emergência"). Restrita a admin: contém ações
          destrutivas em massa (Eliminar Limpezas Futuras) e sincronização
          do Smoobu que não devem estar acessíveis ao gestor no dia a dia. */}
      {userRole === "admin" && (
      <Card className="border-destructive/30">
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
              onClick={handleSincronizar}
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

            {/* Importar Propriedades */}
            <Button
              variant="outline"
              onClick={handleImportar}
              disabled={importando}
            >
              {importando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Building2 className="h-4 w-4" />
              )}
              {importando ? "A importar…" : "Importar Propriedades"}
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

          {resultadoEmergencia && (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <span className="font-medium">Resultado: </span>
              {resultadoEmergencia}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Aviso para não-admin: explica onde estão as ações de massa. */}
      {userRole !== null && userRole !== "admin" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Ações de Manutenção restritas ao Admin</p>
            <p className="text-xs">
              As ações destrutivas em massa (Eliminar Limpezas Futuras) e a
              sincronização do Smoobu foram movidas para a área de Admin por
              segurança. Contacta o administrador se precisares de executá-las.
            </p>
          </div>
        </div>
      )}

      {/* Dialog de confirmação: Eliminar Limpezas Futuras */}
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
            onClick={handleLimparFuturas}
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
    </div>
  );
}
