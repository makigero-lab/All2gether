"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, CircleDashed, Loader2, PauseCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { adminGet } from "@/lib/api";

interface Casa { _id: string; nome: string; smoobu_id?: string | null }
interface Fonte {
  propriedade_id: string; canal_texto: string; estado: "ativa" | "erro" | "pausada" | "suspensa";
  estado_texto: string | null; ultimo_erro: { mensagem: string } | null; em_validacao?: boolean; aviso_validacao?: string | null; n_por_confirmar?: number;
}

function EstadoDaFonte({ f }: { f: Fonte }) {
  if (f.em_validacao) return <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {f.canal_texto}: {f.aviso_validacao}</p>;
  if (f.estado === "ativa") return <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> {f.canal_texto}: ligado</p>;
  if (f.estado === "erro") return <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {f.canal_texto}: com erro. {f.ultimo_erro?.mensagem ?? ""} A All2gether já foi avisada.</p>;
  return <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {f.canal_texto}: {f.estado_texto ?? "em pausa"}</p>;
}

/**
 * Estado dos calendários do proprietário (só leitura): ligado, com erro ou por ligar. Quem liga, testa, corrige e remove
 * é a All2gether. As decisões «é uma reserva / é um bloqueio» do Booking continuam na página de reservas.
 */
export default function ParceiroCalendariosPage() {
  const [casas, setCasas] = useState<Casa[] | null>(null);
  const [fontes, setFontes] = useState<Fonte[]>([]);
  const [pendentes, setPendentes] = useState<Record<string, number>>({});
  const [contacto, setContacto] = useState<{ nome: string | null; telefone: string | null; email: string | null } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    // Os períodos por confirmar contam-se pela lista de reservas externas, por isso aparecem mesmo com a ligação em erro ou em pausa.
    adminGet<{ reservas_externas: { propriedade: { _id: string } }[] }>("/api/parceiro/reservas-externas?estado=por_confirmar")
      .then((r) => { const m: Record<string, number> = {}; for (const x of r.reservas_externas ?? []) m[x.propriedade._id] = (m[x.propriedade._id] ?? 0) + 1; setPendentes(m); })
      .catch(() => { /* a contagem das fontes serve de alternativa */ });
    Promise.all([
      adminGet<{ propriedades: Casa[] }>("/api/parceiro/propriedades"),
      adminGet<{ fontes: Fonte[]; contacto?: { nome: string | null; telefone: string | null; email: string | null } | null }>("/api/parceiro/calendarios"),
    ]).then(([c, f]) => { setCasas(c.propriedades ?? []); setFontes(f.fontes ?? []); setContacto(f.contacto ?? null); })
      .catch(() => setErro("Não foi possível carregar as tuas casas."));
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <div className="space-y-1">
        <Link href="/parceiro/reservas" className="inline-flex min-h-11 items-center gap-1 text-sm text-brand-text hover:underline sm:min-h-9"><ArrowLeft className="h-4 w-4" /> Voltar às reservas</Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><CalendarDays className="h-6 w-6 text-brand-text" /> Calendários (Airbnb, Booking.com)</h1>
        <p className="text-sm text-muted-foreground">Aqui vês se o calendário de cada casa está ligado. Para ligar ou mudar, fala com a All2gether.
          {contacto && (
            <span> Contacto: {contacto.telefone && <a href={`tel:${contacto.telefone.replace(/\s+/g, "")}`} className="underline">{contacto.telefone}</a>}
              {contacto.telefone && contacto.email && " · "}
              {contacto.email && <a href={`mailto:${contacto.email}`} className="underline">{contacto.email}</a>}.</span>
          )}
        </p>
        <p className="text-sm"><Link href="/parceiro/acordo" className="inline-flex min-h-11 items-center text-brand-text underline sm:min-h-9">Acordo de tratamento de dados</Link></p>
      </div>
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {!casas && !erro && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}
      {casas && casas.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há casas.</p>}
      {casas?.map((c) => {
        const daCasa = fontes.filter((f) => f.propriedade_id === c._id);
        const porConfirmar = Math.max(pendentes[c._id] ?? 0, daCasa.reduce((n, f) => n + (f.n_por_confirmar ?? 0), 0));
        return (
          <Card key={c._id}>
            <CardContent className="space-y-2 p-4">
              <h2 className="text-base font-semibold">{c.nome}</h2>
              {c.smoobu_id ? <p className="text-sm text-muted-foreground">Esta casa recebe as reservas pelo Smoobu.</p>
                : daCasa.length === 0 ? <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><CircleDashed className="h-4 w-4" aria-hidden /> Por ligar</p>
                : daCasa.map((f) => <EstadoDaFonte key={f.canal_texto} f={f} />)}
              {porConfirmar > 0 && <p className="text-sm">{porConfirmar} por confirmar. <Link href="/parceiro/reservas" className="text-brand-text underline">Responder na página de reservas</Link></p>}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
