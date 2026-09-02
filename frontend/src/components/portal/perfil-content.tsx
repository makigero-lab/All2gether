"use client";

import { useEffect, useState } from "react";
import {
  User,
  Mail,
  Phone,
  Shield,
  Loader2,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { lerUtilizador, fazerLogout, type Role } from "@/lib/auth";
import { adminPatch } from "@/lib/api";

/**
 * PerfilContent — Componente partilhado de perfil para parceiro e fornecedor.
 *
 * FIX (botão perfil) — Cria a página de perfil que faltava para os portais
 * externos (parceiro e fornecedor). Mostra os dados do utilizador (nome,
 * email, telemóvel, role) e permite editar o telemóvel.
 *
 * Props:
 *   - portalLabel: etiqueta do portal (ex: "Parceiro", "Lavandaria")
 */
export function PerfilContent({ portalLabel }: { portalLabel: string }) {
  const [user, setUser] = useState<{
    id: string;
    nome: string;
    email: string;
    role: Role;
    telefone?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [telefone, setTelefone] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tipo: "sucesso" | "erro"; msg: string } | null>(null);

  useEffect(() => {
    (async () => {
      const u = await lerUtilizador();
      if (u) {
        setUser({
          id: u.id,
          nome: u.nome,
          email: u.email,
          role: u.role,
          telefone: (u as { telefone?: string }).telefone ?? "",
        });
        setTelefone((u as { telefone?: string }).telefone ?? "");
      }
      setLoading(false);
    })();
  }, []);

  async function handleSalvar() {
    if (!user) return;
    setSaving(true);
    setToast(null);
    try {
      await adminPatch(`/api/gestor/equipa/${user.id}`, { telefone });
      setUser((prev) => (prev ? { ...prev, telefone } : prev));
      setToast({ tipo: "sucesso", msg: "Telemóvel atualizado com sucesso." });
    } catch (e) {
      setToast({
        tipo: "erro",
        msg: e instanceof Error ? e.message : "Erro ao guardar.",
      });
    } finally {
      setSaving(false);
    }
  }

  const ROLE_LABEL: Record<Role, string> = {
    admin: "Admin",
    gestor: "Gestor",
    staff: "Staff",
    parceiro: "Parceiro",
    fornecedor: "Fornecedor",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center gap-2 py-16">
        <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">Não foi possível carregar o perfil.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <User className="h-6 w-6 text-primary" />
          O Meu Perfil
        </h1>
        <p className="text-sm text-muted-foreground">
          {portalLabel} — consulta e atualiza os teus dados.
        </p>
      </div>

      {toast && (
        <Card className={toast.tipo === "sucesso" ? "border-emerald-500/50" : "border-destructive/50"}>
          <CardContent className={`flex items-center gap-2 p-4 text-sm ${toast.tipo === "sucesso" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {toast.msg}
          </CardContent>
        </Card>
      )}

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-5 w-5 text-primary" />
            Dados da Conta
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Nome */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Nome</label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span>{user.nome}</span>
            </div>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Email</label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span>{user.email}</span>
            </div>
          </div>

          {/* Role */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Tipo de Conta</label>
            <div>
              <Badge variant="secondary">{ROLE_LABEL[user.role] ?? user.role}</Badge>
            </div>
          </div>

          {/* Telemóvel (editável) */}
          <div className="space-y-1.5">
            <label htmlFor="telefone" className="text-sm font-medium">Telemóvel (WhatsApp)</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Phone className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="telefone"
                  type="tel"
                  value={telefone}
                  onChange={(e) => setTelefone(e.target.value)}
                  placeholder="+351 912 345 678"
                  className="pl-8"
                />
              </div>
              <Button onClick={handleSalvar} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Usado para notificações WhatsApp (Daily Briefing).
            </p>
          </div>

          {/* Terminar Sessão */}
          <div className="border-t pt-4">
            <Button
              variant="outline"
              className="w-full gap-2 text-destructive hover:bg-destructive/5"
              onClick={() => fazerLogout()}
            >
              Terminar Sessão
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
