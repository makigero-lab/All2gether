"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarDays, Loader2, AlertCircle } from "lucide-react";
import { CalendariosCasas, type CasaParaCalendario } from "@/components/parceiro/calendarios-casa";
import { adminGet } from "@/lib/api";

/**
 * Calendários externos do proprietário: em cada casa, cola o link do Airbnb ou da Booking.com, testa a ligação e
 * vê o estado da última leitura. As reservas entram sozinhas e geram as limpezas.
 */
export default function ParceiroCalendariosPage() {
  const [casas, setCasas] = useState<CasaParaCalendario[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    adminGet<{ propriedades: CasaParaCalendario[] }>("/api/parceiro/propriedades")
      .then((r) => setCasas(r.propriedades ?? []))
      .catch(() => setErro("Não foi possível carregar as tuas casas."));
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <div className="space-y-1">
        <Link href="/parceiro/reservas" className="inline-flex min-h-11 items-center gap-1 text-sm text-brand-text hover:underline sm:min-h-9">
          <ArrowLeft className="h-4 w-4" /> Voltar às reservas
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <CalendarDays className="h-6 w-6 text-brand-text" /> Calendários (Airbnb, Booking.com)
        </h1>
        <p className="text-sm text-muted-foreground">
          Cola o link do calendário de cada casa e as reservas entram sozinhas, com a limpeza no dia da saída. O Airbnb confirma-se sozinho; no
          Booking.com perguntamos-te se cada período fechado é uma reserva.
        </p>
      </div>
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {!casas && !erro && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}
      {casas && <CalendariosCasas apiBase="/api/parceiro" casas={casas} />}
    </main>
  );
}
