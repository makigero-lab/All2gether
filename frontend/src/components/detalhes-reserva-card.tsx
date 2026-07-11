"use client";

import { CalendarDays, LogIn, LogOut, Users, User } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DetalhesReservaDTO } from "@/lib/api";
// Prompt Extra — parsearDataSegura para compatibilidade Safari/iOS.
import { parsearDataSegura } from "@/lib/utils";

/**
 * Card de destaque com os detalhes da reserva Smoobu (Prompt 95 / Fase 1.5).
 *
 * Mostra: Dia de Check-in, Dia de Check-out, Número de Hóspedes (pax) e
 * Nome do Hóspede (se existir). É usado tanto pelo Gestor (modal de detalhe
 * da tarefa) como pelo Staff (ecrã de detalhe da tarefa no terreno).
 *
 * Só renderiza se `detalhes_reserva` existir e tiver pelo menos um campo
 * preenchido. Caso contrário devolve `null` (não ocupa espaço).
 */
function formatarData(iso?: string | null): string {
  if (!iso) return "—";
  // Prompt Extra — parsearDataSegura normaliza "YYYY-MM-DD HH:mm:ss" (Safari).
  const d = parsearDataSegura(iso);
  if (!d) return iso;
  try {
    return d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function DetalhesReservaCard({
  detalhes,
}: {
  detalhes?: DetalhesReservaDTO | null;
}) {
  if (!detalhes) return null;

  const temAlgum =
    detalhes.checkin ||
    detalhes.checkout ||
    detalhes.pax != null ||
    detalhes.nome_hospede;
  if (!temAlgum) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-5 w-5 text-primary" />
          Detalhes da Reserva
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <LogIn className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Check-in
              </p>
              <p className="text-sm font-semibold">
                {formatarData(detalhes.checkin)}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Check-out
              </p>
              <p className="text-sm font-semibold">
                {formatarData(detalhes.checkout)}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Nº de Hóspedes
              </p>
              <p className="text-sm font-semibold">
                {detalhes.pax != null ? `${detalhes.pax}` : "—"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <User className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Nome do Hóspede
              </p>
              <p className="truncate text-sm font-semibold" title={detalhes.nome_hospede ?? undefined}>
                {detalhes.nome_hospede || "—"}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
