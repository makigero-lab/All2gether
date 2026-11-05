"use client";

import { CalendarDays, LogIn, LogOut, Users, User, StickyNote, Mail, Phone } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ContactoHospedeDTO, DetalhesReservaDTO } from "@/lib/api";

/**
 * Card de destaque com os detalhes da reserva de Alojamento Local (Prompt 95 / Fase 1.5).
 *
 * Mostra: Dia de Check-in, Dia de Check-out, Número de Hóspedes (pax) e
 * Nome do Hóspede (se existir). É usado tanto pelo Gestor (modal de detalhe
 * da tarefa) como pelo Staff (ecrã de detalhe da tarefa no terreno).
 *
 * Só renderiza se `detalhes_reserva` existir e tiver pelo menos um campo
 * preenchido. Caso contrário devolve `null` (não ocupa espaço).
 *
 * Nota: originalmente (Prompt 95) estes dados vinham da integração Smoobu;
 * com a remoção do Smoobu (F0), passam a ser preenchidos manualmente ou
 * por futuras integrações de Alojamento Local. O schema mantém-se igual.
 */
function formatarData(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

const TIPO_RESERVA_LABEL: Record<string, string> = {
  reservation: "Reserva",
  "modification of booking": "Reserva alterada",
  cancellation: "Cancelada",
};

/** "3 (2 adultos, 1 criança)" quando há a divisão; senão só o total. */
function textoHospedes(d: DetalhesReservaDTO): string {
  if (d.pax == null && d.adultos == null && d.criancas == null) return "—";
  const total = d.pax ?? (d.adultos ?? 0) + (d.criancas ?? 0);
  const partes: string[] = [];
  if (d.adultos != null) partes.push(`${d.adultos} ${d.adultos === 1 ? "adulto" : "adultos"}`);
  if (d.criancas != null && d.criancas > 0) {
    partes.push(`${d.criancas} ${d.criancas === 1 ? "criança" : "crianças"}`);
  }
  return partes.length > 0 ? `${total} (${partes.join(", ")})` : `${total}`;
}

/**
 * `contacto` (email/telefone) só é passado pelo modal do gestor quando o utilizador
 * é admin; nos restantes casos não é recebido nem mostrado.
 */
export function DetalhesReservaCard({
  detalhes,
  contacto,
}: {
  detalhes?: DetalhesReservaDTO | null;
  contacto?: ContactoHospedeDTO | null;
}) {
  if (!detalhes) return null;

  const temAlgum =
    detalhes.checkin ||
    detalhes.checkout ||
    detalhes.pax != null ||
    detalhes.nome_hospede ||
    detalhes.notas_hospede;
  if (!temAlgum) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-5 w-5 text-gold-text" />
          Detalhes da Reserva
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <LogIn className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Check-in
              </p>
              <p className="text-sm font-semibold">
                {formatarData(detalhes.checkin)}
                {detalhes.hora_checkin ? ` · ${detalhes.hora_checkin}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Check-out
              </p>
              <p className="text-sm font-semibold">
                {formatarData(detalhes.checkout)}
                {detalhes.hora_checkout ? ` · ${detalhes.hora_checkout}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Hóspedes
              </p>
              <p className="text-sm font-semibold">{textoHospedes(detalhes)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <User className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Hóspede
              </p>
              <p className="truncate text-sm font-semibold" title={detalhes.nome_hospede ?? undefined}>
                {detalhes.nome_hospede || "—"}
              </p>
            </div>
          </div>
        </div>

        {detalhes.notas_hospede && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-background/60 p-2.5">
            <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Notas do hóspede
              </p>
              <p className="whitespace-pre-line break-words text-sm">{detalhes.notas_hospede}</p>
            </div>
          </div>
        )}

        {detalhes.tipo_reserva && TIPO_RESERVA_LABEL[detalhes.tipo_reserva] && (
          <p className="mt-3 text-xs text-muted-foreground">
            Estado no Smoobu: {TIPO_RESERVA_LABEL[detalhes.tipo_reserva]}
          </p>
        )}

        {contacto && (contacto.email || contacto.telefone) && (
          <div className="mt-3 space-y-1 rounded-md border border-dashed p-2.5 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Contacto (visível só ao admin)
            </p>
            {contacto.email && (
              <p className="flex items-center gap-2 break-all">
                <Mail className="h-4 w-4 shrink-0 text-gold-text" />
                <a href={`mailto:${contacto.email}`} className="hover:underline">{contacto.email}</a>
              </p>
            )}
            {contacto.telefone && (
              <p className="flex items-center gap-2">
                <Phone className="h-4 w-4 shrink-0 text-gold-text" />
                <a href={`tel:${contacto.telefone}`} className="hover:underline">{contacto.telefone}</a>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
