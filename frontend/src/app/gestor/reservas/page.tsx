"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CalendarCheck, Loader2 } from "lucide-react";
import { TabelaReservas } from "@/components/parceiro/tabela-reservas";
import { adminGet } from "@/lib/api";

interface ProprietarioDTO {
  _id: string;
  nome: string;
  email: string;
  ativo: boolean;
}

/**
 * Reservas dos proprietários, marcadas pelo gestor EM NOME deles. É a mesma tabela do portal do proprietário
 * (várias linhas, Gravar, rascunho, validações): o gestor escolhe o proprietário (só ativos) e as casas dele
 * (só ativas). A reserva fica a ser uma reserva normal do proprietário, que recebe um aviso.
 */
function ReservasDoGestor() {
  const router = useRouter();
  const params = useSearchParams();
  const escolhido = params.get("parceiro") ?? "";
  const [lista, setLista] = useState<ProprietarioDTO[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    adminGet<{ utilizadores: ProprietarioDTO[] }>("/api/gestor/parceiros")
      .then((r) => setLista((r.utilizadores ?? []).filter((u) => u.ativo)))
      .catch(() => setErro("Não foi possível carregar os proprietários."));
  }, []);

  const atual = useMemo(() => lista?.find((p) => p._id === escolhido) ?? null, [lista, escolhido]);

  const escolher = (id: string) => {
    router.replace(id ? `/gestor/reservas?parceiro=${id}` : "/gestor/reservas");
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CalendarCheck className="h-6 w-6 text-brand-text" /> Reservas dos proprietários
          </h1>
          <p className="text-sm text-muted-foreground">Marca reservas em nome de um proprietário. Só aparecem proprietários ativos.</p>
        </div>
        <label className="flex w-full flex-col gap-1 text-sm font-medium sm:w-80">
          Proprietário
          <select
            value={escolhido}
            onChange={(e) => escolher(e.target.value)}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-base font-normal"
            aria-label="Escolher o proprietário"
          >
            <option value="">— Escolhe um proprietário —</option>
            {(lista ?? []).map((p) => (
              <option key={p._id} value={p._id}>{p.nome}</option>
            ))}
          </select>
        </label>
      </div>

      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {!lista && !erro && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}
      {lista && lista.length === 0 && <p className="text-sm text-muted-foreground">Não há proprietários ativos.</p>}
      {lista && lista.length > 0 && !escolhido && <p className="text-sm text-muted-foreground">Escolhe um proprietário para ver e marcar as reservas dele.</p>}
      {lista && escolhido && !atual && <p role="alert" className="text-sm text-destructive">Este proprietário não existe ou está inativo.</p>}

      {atual && (
        <div className="-mx-4 sm:-mx-6 lg:-mx-8">
          <TabelaReservas
            key={atual._id}
            apiBase={`/api/gestor/parceiros/${atual._id}`}
            escopoRascunho={atual._id}
            titulo={`Reservas de ${atual.nome}`}
            mostrarExportar={false}
            porGestor
            externasListaUrl={`/api/gestor/reservas-externas?estado=por_confirmar&parceiro_id=${atual._id}`}
            externasDecisaoBase="/api/gestor/reservas-externas"
          />
        </div>
      )}
    </div>
  );
}

export default function GestorReservasPage() {
  return (
    <Suspense fallback={<p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}>
      <ReservasDoGestor />
    </Suspense>
  );
}
