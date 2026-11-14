"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Lock, PauseCircle, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminDelete, adminGet, adminPatch, adminPost, adminPut } from "@/lib/api";
import { plural } from "@/lib/utils";
import { haQuanto, msgErro, REGRA_UMA_FONTE, resultadoAceitar, type CasaResumo, type CelulaCanal, type ProprietarioResumo } from "./tipos";
import type { CanalAssistente } from "./assistente-ligar";

/** true em ecrãs estreitos (< 640 px): a matriz passa a uma lista por casa, sem scroll horizontal. */
function useEcraEstreito(): boolean {
  const [estreito, setEstreito] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(max-width: 639px)");
    const ler = () => setEstreito(m.matches);
    ler();
    m.addEventListener("change", ler);
    return () => m.removeEventListener("change", ler);
  }, []);
  return estreito;
}

/** Cadeado só quando a célula está mesmo bloqueada, com o motivo concreto. */
function Bloqueada({ motivo }: { motivo: string }) {
  return <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {motivo}</p>;
}

function CelulaLigada({ c, disponivel, aoMudar }: { c: CelulaCanal; disponivel: boolean; aoMudar: () => void }) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [remover, setRemover] = useState<{ limpezas: number } | null>(null);
  const [corrigir, setCorrigir] = useState(false);
  const [novoLink, setNovoLink] = useState("");
  const [erroLink, setErroLink] = useState<string | null>(null);

  const correr = async (nome: string, fn: () => Promise<string | void>) => {
    setOcupado(nome); setErro(null); setInfo(null);
    try { const t = await fn(); if (t) setInfo(t); aoMudar(); } catch (e) { setErro(msgErro(e, "Não foi possível concluir.")); } finally { setOcupado(null); }
  };
  // «Atualizar» lê o calendário já (não mexe no link).
  const atualizar = () => correr("atualizar", async () => {
    const r = await adminPost<{ leitura: { resultado: string; mensagem?: string } | null }>(`/api/gestor/calendarios/${c.fonte_id}/atualizar`, {});
    if (r.leitura?.resultado === "erro") setErro(r.leitura.mensagem ?? "O calendário não respondeu."); else return "Atualizado.";
  });
  const reativar = () => correr("reativar", async () => {
    const r = await adminPost<{ ok: boolean; erro?: string }>(`/api/gestor/calendarios/${c.fonte_id}/reativar`, {});
    if (!r.ok) setErro(r.erro ?? "O teste falhou."); else return "Ligação testada e reativada.";
  });
  const estado = (acao: "pausar" | "retomar") => correr(acao, async () => { await adminPatch(`/api/gestor/calendarios/${c.fonte_id}/estado`, { acao }); });
  // «Aceitar» dá resposta imediata: o servidor lê já o calendário e cria as limpezas.
  const aceitar = () => correr("aceitar", async () => {
    const r = await adminPatch<{ leitura?: { alteracoes?: { criadas: number; por_confirmar: number } | null } | null }>(`/api/gestor/calendarios/${c.fonte_id}/estado`, { acao: "aceitar_calendario" });
    return resultadoAceitar(r.leitura);
  });
  const pedirRemover = () => correr("impacto", async () => {
    const r = await adminGet<{ limpezas_a_cancelar: number }>(`/api/gestor/calendarios/${c.fonte_id}/impacto-remocao`);
    setRemover({ limpezas: r.limpezas_a_cancelar });
  });
  const confirmarRemover = () => correr("remover", async () => { await adminDelete(`/api/gestor/calendarios/${c.fonte_id}`); setRemover(null); });
  const substituir = async () => {
    setOcupado("substituir"); setErroLink(null);
    try {
      const r = await adminPut<{ leitura: { resultado: string; mensagem?: string } | null }>(`/api/gestor/calendarios/${c.fonte_id}`, { url: novoLink.trim() });
      setCorrigir(false); setNovoLink("");
      setInfo(r.leitura?.resultado === "erro" ? `Link guardado, mas a leitura falhou: ${r.leitura.mensagem ?? "tenta mais tarde."}` : "Link corrigido e calendário lido.");
      aoMudar();
    } catch (e) { setErroLink(msgErro(e, "Não foi possível guardar o link novo.")); } finally { setOcupado(null); }
  };

  const temporario = c.estado === "erro" && !!c.erro?.temporario;
  const podeCorrigir = (c.estado === "erro" && !temporario) || c.estado === "suspensa" || c.motivo_estado === "erros_persistentes";
  // O erro do cartão já diz o mesmo que uma falha local igual: nunca duas vezes.
  const erroLocal = erro && erro !== c.erro?.mensagem ? erro : null;
  const b = "min-h-11 sm:min-h-8 px-2 text-xs";
  return (
    <div className="space-y-1.5">
      {c.estado === "ativa" && !c.em_validacao && <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> A funcionar · {haQuanto(c.ultimo_sucesso_em)}</p>}
      {c.em_validacao && <p role="status" className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.aviso_validacao}</p>}
      {c.estado === "erro" && <p role="status" className={`flex items-start gap-1.5 text-sm ${temporario ? "text-amber-700 dark:text-amber-400" : "text-destructive"}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.erro?.mensagem ?? "Não foi possível ler o calendário."}</p>}
      {(c.estado === "pausada" || c.estado === "suspensa") && <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.estado_texto ?? "Em pausa."}</p>}
      {c.url_mascara && <p className="break-all text-xs text-muted-foreground" title="Por segurança, o link nunca é mostrado por inteiro.">{c.url_mascara}</p>}
      {erroLocal && <p role="alert" className="text-xs text-destructive">{erroLocal}</p>}
      {ocupado === "aceitar" && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> A criar as limpezas…</p>}
      {info && <p role="status" className="text-xs text-muted-foreground">{info}</p>}
      <div className="flex flex-wrap gap-1.5">
        {c.em_validacao && <Button size="sm" className={b} disabled={!disponivel || !!ocupado} onClick={aceitar}>{ocupado === "aceitar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {ocupado === "aceitar" ? "A criar as limpezas…" : "Aceitar o calendário"}</Button>}
        {c.estado === "ativa" && <Button size="sm" variant="outline" className={b} title="Lê o calendário já" disabled={!disponivel || !!ocupado} onClick={atualizar}>{ocupado === "atualizar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {ocupado === "atualizar" ? "A ler…" : "Atualizar"}</Button>}
        {temporario && <Button size="sm" variant="outline" className={b} title="Tenta ler o calendário outra vez já" disabled={!disponivel || !!ocupado} onClick={atualizar}>{ocupado === "atualizar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {ocupado === "atualizar" ? "A tentar…" : "Tentar agora"}</Button>}
        {podeCorrigir && c.motivo_estado !== "casa_ligada_smoobu" && <Button size="sm" variant="outline" className={b} title="Cola o link novo do canal" disabled={!disponivel || !!ocupado} onClick={() => { setCorrigir(true); setErroLink(null); }}>Corrigir link</Button>}
        {podeCorrigir && c.motivo_estado !== "casa_ligada_smoobu" && <Button size="sm" variant="outline" className={b} title="Volta a testar o link que já está guardado" disabled={!disponivel || !!ocupado} onClick={reativar}>{ocupado === "reativar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {ocupado === "reativar" ? "A testar…" : "Testar e reativar"}</Button>}
        {c.estado === "ativa" && <Button size="sm" variant="outline" className={b} disabled={!!ocupado} onClick={() => estado("pausar")}>Pausar</Button>}
        {c.estado === "pausada" && c.motivo_estado === "pelo_gestor" && <Button size="sm" variant="outline" className={b} disabled={!disponivel || !!ocupado} onClick={() => estado("retomar")}>Retomar</Button>}
        <Button size="sm" variant="ghost" className={`${b} text-destructive`} disabled={!!ocupado} onClick={pedirRemover}>Remover</Button>
      </div>
      <Dialog open={corrigir} onOpenChange={(o) => { if (!o && ocupado !== "substituir") setCorrigir(false); }}>
        <DialogHeader>
          <DialogTitle>Corrigir o link do {c.canal_texto}</DialogTitle>
          <DialogDescription>Gera um link novo no canal e cola-o aqui. As reservas já lidas mantêm-se.</DialogDescription>
          <DialogClose onClick={() => setCorrigir(false)} />
        </DialogHeader>
        <DialogContent>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Link novo do calendário
            <input value={novoLink} onChange={(e) => { setNovoLink(e.target.value); setErroLink(null); }} autoComplete="off" spellCheck={false} placeholder="Cola aqui o link (https://…)" aria-label="Link novo do calendário" className="h-11 rounded-md border border-input bg-background px-3 text-base font-normal" />
          </label>
          {erroLink && <p role="alert" className="mt-2 flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {erroLink}</p>}
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" disabled={ocupado === "substituir"} onClick={() => setCorrigir(false)}>Cancelar</Button>
          <Button className="min-h-11" disabled={!novoLink.trim() || ocupado === "substituir"} onClick={substituir}>{ocupado === "substituir" && <Loader2 className="h-4 w-4 animate-spin" />} {ocupado === "substituir" ? "A testar…" : "Guardar e ler"}</Button>
        </DialogFooter>
      </Dialog>
      <Dialog open={remover !== null} onOpenChange={(o) => { if (!o) setRemover(null); }}>
        <DialogHeader>
          <DialogTitle>Remover o calendário {c.canal_texto}?</DialogTitle>
          <DialogDescription>
            {remover && remover.limpezas > 0
              ? `Vão ser canceladas ${plural(remover.limpezas, "limpeza futura", "limpezas futuras")} que vieram deste calendário (as que já começaram ficam). A equipa e o proprietário são avisados.`
              : "Não há limpezas futuras que dependam deste calendário."}
          </DialogDescription>
          <DialogClose onClick={() => setRemover(null)} />
        </DialogHeader>
        <DialogContent><p className="text-sm text-muted-foreground">O link é apagado de imediato. Podes voltar a ligar quando quiseres.</p></DialogContent>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => setRemover(null)}>Cancelar</Button>
          <Button variant="destructive" className="min-h-11" disabled={ocupado === "remover"} onClick={confirmarRemover}>{ocupado === "remover" && <Loader2 className="h-4 w-4 animate-spin" />} Remover</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function CelulaCanalMatriz({ casa, canal, disponivel, motivoSemLigar, aoLigar, aoMudar }: {
  casa: CasaResumo; canal: CanalAssistente; disponivel: boolean; motivoSemLigar: string | null;
  aoLigar: (casaId: string, canal: CanalAssistente) => void; aoMudar: () => void;
}) {
  const c = casa[canal];
  if (casa.smoobu && !c) return <Bloqueada motivo="Bloqueado: esta casa recebe as reservas pelo Smoobu." />;
  if (c) return <CelulaLigada c={c} disponivel={disponivel} aoMudar={aoMudar} />;
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-8" disabled={!disponivel || !!motivoSemLigar} onClick={() => aoLigar(casa._id, canal)} aria-label={`Ligar ${canal === "airbnb" ? "Airbnb" : "Booking.com"} a ${casa.nome}`}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> Ligar
      </Button>
      {motivoSemLigar && <p className="text-xs text-muted-foreground">{motivoSemLigar}</p>}
    </div>
  );
}

/** Coluna «Smoobu / outro sistema»: cadeado só quando o Smoobu está mesmo bloqueado (a casa já tem Airbnb/Booking). */
function CelulaSmoobu({ c }: { c: CasaResumo }) {
  if (c.smoobu) return <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" aria-hidden /> Smoobu da All2gether</p>;
  const ligados = [c.airbnb && "Airbnb", c.booking && "Booking.com", ...c.outros.map((o) => o.canal_texto)].filter(Boolean) as string[];
  if (ligados.length > 0) return <Bloqueada motivo={`Bloqueado: esta casa já tem ${ligados.join(" e ")} ligado; o Smoobu não pode coexistir com calendários.`} />;
  return <p className="text-xs text-muted-foreground"><span className="font-medium">Em preparação</span></p>;
}

const NomeCasa = ({ c }: { c: CasaResumo }) => (
  <>{c.nome}{!c.ativo && <span className="ml-1 text-xs font-normal text-muted-foreground">(inativa)</span>}
    {c.por_confirmar > 0 && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{plural(c.por_confirmar, "período por confirmar", "períodos por confirmar")}</span>}</>
);

/**
 * Matriz do detalhe de um proprietário: casas nas linhas; Airbnb, Booking.com e «Smoobu / outro» nas colunas.
 * No telemóvel (< 640 px) passa a uma lista por casa, com uma linha por canal (sem scroll horizontal).
 * A regra da origem única (REGRA_UMA_FONTE) diz-se uma vez no topo; o cadeado só aparece onde há bloqueio real.
 */
export function MatrizProprietario({ p, disponivel, aoLigar, aoMudar }: {
  p: ProprietarioResumo; disponivel: boolean; aoLigar: (casaId: string, canal: CanalAssistente) => void; aoMudar: () => void;
}) {
  const estreito = useEcraEstreito();
  const motivoSemLigar = p.acordo === "por_aceitar" ? "Acordo por aceitar: o proprietário ainda não aceitou o acordo de dados." : null;
  if (p.casas.length === 0) return <p className="text-sm text-muted-foreground">Este proprietário ainda não tem casas{(p.n_casas_inativas ?? 0) > 0 ? " ativas (as casas inativas só aparecem em «Incluir inativos»)" : ""}.</p>;
  const regra = <p className="text-sm text-muted-foreground" data-regra>{REGRA_UMA_FONTE}</p>;
  if (estreito) {
    return (
      <div className="space-y-3" data-matriz-lista>
        {regra}
        {p.casas.map((c) => (
          <section key={c._id} aria-label={c.nome} className="space-y-3 rounded-md border p-3">
            <h3 className="font-medium"><NomeCasa c={c} /></h3>
            {([["Airbnb", "airbnb"], ["Booking.com", "booking"]] as const).map(([nome, canal]) => (
              <div key={canal} className="space-y-1 border-t pt-2">
                <p className="text-xs font-medium text-muted-foreground">{nome}</p>
                <CelulaCanalMatriz casa={c} canal={canal} disponivel={disponivel} motivoSemLigar={motivoSemLigar} aoLigar={aoLigar} aoMudar={aoMudar} />
              </div>
            ))}
            <div className="space-y-1 border-t pt-2">
              <p className="text-xs font-medium text-muted-foreground">Smoobu / outro sistema</p>
              <CelulaSmoobu c={c} />
            </div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {regra}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm" data-matriz>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Casa</th>
              <th scope="col" className="px-3 py-2 font-medium">Airbnb</th>
              <th scope="col" className="px-3 py-2 font-medium">Booking.com</th>
              <th scope="col" className="px-3 py-2 font-medium">Smoobu / outro sistema</th>
            </tr>
          </thead>
          <tbody>
            {p.casas.map((c) => (
              <tr key={c._id} className="border-b align-top">
                <th scope="row" className="py-3 pr-3 font-medium"><NomeCasa c={c} /></th>
                <td className="px-3 py-3"><CelulaCanalMatriz casa={c} canal="airbnb" disponivel={disponivel} motivoSemLigar={motivoSemLigar} aoLigar={aoLigar} aoMudar={aoMudar} /></td>
                <td className="px-3 py-3"><CelulaCanalMatriz casa={c} canal="booking" disponivel={disponivel} motivoSemLigar={motivoSemLigar} aoLigar={aoLigar} aoMudar={aoMudar} /></td>
                <td className="px-3 py-3"><CelulaSmoobu c={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
