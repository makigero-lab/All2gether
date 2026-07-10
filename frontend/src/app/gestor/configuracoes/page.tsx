"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Save,
  Building2,
  Calendar,
  Webhook,
  Clock,
  CheckCircle2,
  AlertCircle,
  Settings,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Toast = { tipo: "sucesso" | "erro"; msg: string } | null;

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

  function showToast(tipo: "sucesso" | "erro", msg: string) {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 6000);
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/gestor/configuracoes", { credentials: "include" });
      const data = await res.json();
      if (res.ok) {
        setNome(data.nome || "");
        setApiKeyMascarada(data.smoobu_api_key_mascarada || "");
        setTemApiKey(data.tem_api_key || false);
      }
    } catch {
      // silencioso
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

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        A carregar configuração…
      </div>
    );
  }

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
                {editApiKey ? (
                  <div className="space-y-2">
                    <Input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="Cola aqui a API Key do Smoobu" autoComplete="off" />
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setEditApiKey(false); setApiKeyInput(""); }}>Cancelar</Button>
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
            <p className="text-sm text-muted-foreground">Sincroniza dados com o Smoobu usando a API Key desta empresa.</p>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Importar Propriedades", "/api/gestor/smoobu/propriedades")} disabled={actionLoading !== null}>
              {actionLoading === "Importar Propriedades" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
              Importar Propriedades
            </Button>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Sincronizar Reservas", "/api/gestor/smoobu/sincronizar")} disabled={actionLoading !== null}>
              {actionLoading === "Sincronizar Reservas" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
              Sincronizar Reservas
            </Button>
            <Button variant="outline" className="w-full gap-2" onClick={() => executarAcao("Registrar Webhooks", "/api/admin/registrar-webhooks")} disabled={actionLoading !== null}>
              {actionLoading === "Registrar Webhooks" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Webhook className="h-4 w-4" />}
              Registrar Webhooks
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
      </div>
    </div>
  );
}
