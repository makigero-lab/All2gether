"use client";

import { useCallback, useEffect, useState } from "react";
import { HandHeart, Loader2, Clock, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { mensagemErro } from "@/lib/rascunho-staff";

interface VagaLivre {
  _id: string;
  casa: string;
  morada?: string | null;
  dia: string; // AAAA-MM-DD
  tempo_limpeza_minutos: number;
  vagas: number;
  expira_em: string;
}

const dataCurta = (dia: string) => {
  const [a, m, d] = dia.split("-");
  return a && m && d ? `${d}/${m}` : dia;
};

const horaLisboa = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });

/**
 * Limpezas livres: vagas que ninguém da equipa tinha disponibilidade para fazer e que são
 * oferecidas a toda a equipa. Fica com ela quem aceitar primeiro (o servidor decide).
 * Funciona em desktop e em 375 px (cartão em coluna, botão de largura total no telemóvel).
 */
export function LimpezasLivres({ onAceite }: { onAceite?: () => void }) {
  const [vagas, setVagas] = useState<VagaLivre[]>([]);
  const [aAceitar, setAAceitar] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<{ tipo: "ok" | "aviso" | "erro"; texto: string } | null>(null);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch("/api/staff/vagas-livres", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setVagas(Array.isArray(data.vagas) ? data.vagas : []);
    } catch {
      /* sem rede: mantém o que já estava */
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function aceitar(id: string) {
    setAAceitar(id);
    setMensagem(null);
    try {
      const res = await fetch(`/api/staff/vagas-livres/${id}/aceitar`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMensagem({ tipo: "erro", texto: data?.erro || `Erro ${res.status}` });
      } else {
        setMensagem({
          tipo: data.aviso ? "aviso" : "ok",
          texto: data.aviso ? `Ficou contigo. Atenção: ${data.aviso}` : "Ficou contigo. Já está na tua agenda.",
        });
        onAceite?.();
      }
    } catch (e) {
      setMensagem({ tipo: "erro", texto: mensagemErro(e, "Não foi possível aceitar. Tenta outra vez.") });
    } finally {
      setAAceitar(null);
      await carregar();
    }
  }

  if (vagas.length === 0 && !mensagem) return null;

  return (
    <section aria-label="Limpezas livres" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Limpezas livres ({vagas.length})
        </h2>
        <div className="h-px flex-1 bg-border" />
      </div>
      {mensagem && (
        <p
          role={mensagem.tipo === "erro" ? "alert" : "status"}
          className={
            "rounded-md border px-3 py-2 text-sm " +
            (mensagem.tipo === "erro"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : mensagem.tipo === "aviso"
              ? "border-amber-500/50 bg-amber-500/10"
              : "border-emerald-500/40 bg-emerald-500/10")
          }
        >
          {mensagem.texto}
        </p>
      )}
      {vagas.map((v) => (
        <Card key={v._id} className="border-primary/40">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="flex items-start gap-2 font-semibold">
                <HandHeart className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="break-words">Limpeza livre em {v.casa}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                Dia {dataCurta(v.dia)} · {v.tempo_limpeza_minutos} min
                {v.vagas > 1 ? ` · ${v.vagas} vagas` : ""}
              </p>
              {v.morada && (
                <p className="flex items-start gap-1 text-xs text-muted-foreground">
                  <MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="break-words">{v.morada}</span>
                </p>
              )}
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                Aceita até às {horaLisboa(v.expira_em)} ({dataCurta(v.expira_em.slice(0, 10))})
              </p>
            </div>
            <Button
              size="touch"
              className="w-full sm:w-auto"
              onClick={() => aceitar(v._id)}
              disabled={aAceitar !== null}
            >
              {aAceitar === v._id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Aceitar
            </Button>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
