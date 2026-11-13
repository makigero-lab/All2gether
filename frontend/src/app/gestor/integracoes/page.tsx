"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowLeft, FileWarning, Loader2, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/api";
import { lerUtilizador } from "@/lib/auth";
import { AssistenteLigar, type CanalAssistente } from "@/components/gestor/integracoes/assistente-ligar";
import { MatrizProprietario } from "@/components/gestor/integracoes/matriz-proprietario";
import { ReservasPorConfirmarGestor } from "@/components/gestor/integracoes/por-confirmar";
import { FILTROS, VistaGeral } from "@/components/gestor/integracoes/vista-geral";
import { msgErro, type Filtro, type ProprietarioResumo, type ResumoIntegracoes } from "@/components/gestor/integracoes/tipos";

/**
 * Integrações do gestor: vista geral por proprietário (uma linha cada), detalhe em matriz (Casa × canal) e o separador
 * «Reservas por confirmar» (lista única da empresa). Só o gestor liga, testa, corrige e remove.
 */
function IntegracoesGestor() {
  const router = useRouter();
  const params = useSearchParams();
  const separador = params.get("sep") === "confirmar" ? "confirmar" : "proprietarios";
  const abertoId = params.get("p");

  const [resumo, setResumo] = useState<ResumoIntegracoes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [inativos, setInativos] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [assistente, setAssistente] = useState<{ p: ProprietarioResumo; casa?: string; canal?: CanalAssistente } | null>(null);

  useEffect(() => { void lerUtilizador().then((u) => setAdmin(u?.role === "admin")); }, []);

  const carregar = useCallback(async () => {
    try {
      setResumo(await adminGet<ResumoIntegracoes>(`/api/gestor/integracoes/resumo${inativos ? "?inativos=1" : ""}`));
      setErro(null);
    } catch (e) { setErro(msgErro(e, "Não foi possível carregar as integrações.")); }
  }, [inativos]);
  useEffect(() => { void carregar(); }, [carregar]);
  // O selo da barra lateral acompanha as mudanças.
  const recarregar = useCallback(() => { void carregar(); window.dispatchEvent(new Event("integracoes-mudou")); }, [carregar]);

  const aberto = useMemo(() => resumo?.proprietarios.find((p) => p._id === abertoId) ?? null, [resumo, abertoId]);
  const comErro = useMemo(() => new Set((resumo?.proprietarios ?? []).filter((p) => p.n_erros > 0).map((p) => p._id)), [resumo]);
  const disponivel = resumo?.ligado !== false;

  const ir = (q: Record<string, string>) => router.replace(`/gestor/integracoes${Object.keys(q).length ? "?" + new URLSearchParams(q).toString() : ""}`);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Plug className="h-6 w-6 text-brand-text" /> Integrações</h1>
        <p className="text-sm text-muted-foreground">Os calendários do Airbnb e da Booking.com dos proprietários. Só tu ligas, testas, corriges e removes; o proprietário só vê o estado.</p>
      </div>

      {resumo && !resumo.ligado && (
        <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/60 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          {admin
            ? "A ligação a calendários externos está desligada: faltam as chaves ICAL_CHAVES, ICAL_CHAVE_ATUAL e ICAL_HMAC_CHAVE nas variáveis de ambiente do servidor. Sem elas nada é guardado nem lido; os botões de ligar ficam desativados."
            : "Indisponível, fala com o administrador. Os botões de ligar estão desativados até estar configurado."}
        </p>
      )}
      {resumo?.acordo_obrigatorio && resumo.totais.por_aceitar > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-md border p-3 text-sm"><FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {resumo.totais.por_aceitar} proprietário(s) com o acordo por aceitar: as ligações deles estão em pausa e não podes ligar novas até aceitarem.</p>
      )}
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}

      <div role="tablist" aria-label="Separadores" className="flex gap-1 border-b">
        {[{ id: "proprietarios", texto: "Por proprietário", n: resumo?.totais.erros ?? 0, leitor: (n: number) => `${n} ${n === 1 ? "ligação com erro" : "ligações com erro"}` }, { id: "confirmar", texto: "Reservas por confirmar", n: resumo?.totais.por_confirmar ?? 0, leitor: (n: number) => `${n} por confirmar` }].map((s) => (
          <button key={s.id} role="tab" type="button" aria-selected={separador === s.id} onClick={() => ir(s.id === "confirmar" ? { sep: "confirmar" } : {})}
            className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-medium ${separador === s.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {s.texto}{s.n > 0 && <span aria-label={s.leitor(s.n)} className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${s.id === "proprietarios" ? "bg-destructive text-destructive-foreground" : "bg-muted"}`}>{s.n}</span>}
          </button>
        ))}
      </div>

      {!resumo && !erro && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}

      {resumo && separador === "confirmar" && <ReservasPorConfirmarGestor proprietariosComErro={comErro} disponivel={disponivel} aoMudar={recarregar} />}

      {resumo && separador === "proprietarios" && !aberto && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {FILTROS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}
                className={`min-h-11 rounded-full border px-3 text-sm sm:min-h-9 ${filtro === f.id ? "border-primary bg-accent font-medium" : "border-input hover:bg-accent"}`}>{f.texto}</button>
            ))}
            <label className="ml-auto flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
              <input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} className="h-4 w-4" /> Incluir inativos
            </label>
          </div>
          <VistaGeral lista={resumo.proprietarios} filtro={filtro} disponivel={disponivel} aoAbrir={(id) => ir({ p: id })} aoLigar={(p) => setAssistente({ p })} aoMudar={recarregar} />
        </>
      )}

      {resumo && separador === "proprietarios" && abertoId && !aberto && <p role="alert" className="text-sm text-destructive">Este proprietário não existe ou está inativo (usa «Incluir inativos»).</p>}
      {resumo && separador === "proprietarios" && aberto && (
        <section className="space-y-3" aria-label={`Integrações de ${aberto.nome}`}>
          <Button variant="ghost" size="sm" className="min-h-11 gap-1 sm:min-h-9" onClick={() => ir({})}><ArrowLeft className="h-4 w-4" /> Todos os proprietários</Button>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-semibold">{aberto.nome}</h2>
              <p className="text-xs text-muted-foreground">{aberto.email}{aberto.acordo === "por_aceitar" && " · Acordo por aceitar"}{aberto.acordo === "aceite" && " · Acordo aceite"}</p>
            </div>
            <Button className="min-h-11 sm:min-h-9" disabled={!disponivel || aberto.acordo === "por_aceitar"} onClick={() => setAssistente({ p: aberto })}>Ligar um calendário</Button>
          </div>
          <MatrizProprietario p={aberto} disponivel={disponivel} aoLigar={(casa, canal) => setAssistente({ p: aberto, casa, canal })} aoMudar={recarregar} />
        </section>
      )}

      {assistente && (
        <AssistenteLigar proprietario={resumo?.proprietarios.find((x) => x._id === assistente.p._id) ?? assistente.p} casaInicial={assistente.casa} canalInicial={assistente.canal} aberto aoFechar={() => setAssistente(null)} aoLigar={recarregar} />
      )}
    </div>
  );
}

export default function IntegracoesPage() {
  return (
    <Suspense fallback={<p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>}>
      <IntegracoesGestor />
    </Suspense>
  );
}
