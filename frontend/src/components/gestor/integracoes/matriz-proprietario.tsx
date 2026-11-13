"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Lock, PauseCircle, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminDelete, adminGet, adminPatch, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { haQuanto, msgErro, type CasaResumo, type CelulaCanal, type ProprietarioResumo } from "./tipos";
import type { CanalAssistente } from "./assistente-ligar";

/** Cadeado com o motivo da regra «uma só fonte por casa». */
function Bloqueada({ motivo }: { motivo: string }) {
  return <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {motivo}</p>;
}

function CelulaLigada({ c, disponivel, aoMudar }: { c: CelulaCanal; disponivel: boolean; aoMudar: () => void }) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [remover, setRemover] = useState<{ limpezas: number } | null>(null);

  const correr = async (nome: string, fn: () => Promise<void>) => {
    setOcupado(nome); setErro(null); setInfo(null);
    try { await fn(); aoMudar(); } catch (e) { setErro(msgErro(e, "Não foi possível concluir.")); } finally { setOcupado(null); }
  };
  const atualizar = () => correr("atualizar", async () => {
    const r = await adminPost<{ leitura: { resultado: string; mensagem?: string } | null }>(`/api/gestor/calendarios/${c.fonte_id}/atualizar`, {});
    if (r.leitura?.resultado === "erro") setErro(r.leitura.mensagem ?? "O calendário não respondeu."); else setInfo("Atualizado.");
  });
  const reativar = () => correr("reativar", async () => {
    const r = await adminPost<{ ok: boolean; erro?: string }>(`/api/gestor/calendarios/${c.fonte_id}/reativar`, {});
    if (!r.ok) setErro(r.erro ?? "O teste falhou."); else setInfo("Ligação testada e reativada.");
  });
  const estado = (acao: "pausar" | "retomar" | "aceitar_calendario") => correr(acao, async () => { await adminPatch(`/api/gestor/calendarios/${c.fonte_id}/estado`, { acao }); });
  const pedirRemover = () => correr("impacto", async () => {
    const r = await adminGet<{ limpezas_a_cancelar: number }>(`/api/gestor/calendarios/${c.fonte_id}/impacto-remocao`);
    setRemover({ limpezas: r.limpezas_a_cancelar });
  });
  const confirmarRemover = () => correr("remover", async () => { await adminDelete(`/api/gestor/calendarios/${c.fonte_id}`); setRemover(null); });

  const b = "min-h-11 sm:min-h-8 px-2 text-xs";
  return (
    <div className="space-y-1.5">
      {c.estado === "ativa" && !c.em_validacao && <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> A funcionar · {haQuanto(c.ultimo_sucesso_em)}</p>}
      {c.em_validacao && <p role="status" className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.aviso_validacao}</p>}
      {c.estado === "erro" && <p role="status" className="flex items-start gap-1.5 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.erro?.mensagem ?? "Não foi possível ler o calendário."}</p>}
      {(c.estado === "pausada" || c.estado === "suspensa") && <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.estado_texto ?? "Em pausa."}</p>}
      {c.url_mascara && <p className="break-all text-xs text-muted-foreground" title="Por segurança, o link nunca é mostrado por inteiro.">{c.url_mascara}</p>}
      {erro && <p role="alert" className="text-xs text-destructive">{erro}</p>}
      {info && <p role="status" className="text-xs text-muted-foreground">{info}</p>}
      <div className="flex flex-wrap gap-1.5">
        {c.em_validacao && <Button size="sm" className={b} disabled={!disponivel || !!ocupado} onClick={() => estado("aceitar_calendario")}>Aceitar o calendário</Button>}
        {(c.estado === "ativa" || c.estado === "erro") && <Button size="sm" variant="outline" className={b} disabled={!disponivel || !!ocupado} onClick={atualizar}>{ocupado === "atualizar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Atualizar</Button>}
        {(c.estado === "erro" || c.estado === "suspensa" || c.motivo_estado === "erros_persistentes") && c.motivo_estado !== "casa_ligada_smoobu" && <Button size="sm" variant="outline" className={b} disabled={!disponivel || !!ocupado} onClick={reativar}>Testar e corrigir</Button>}
        {c.estado === "ativa" && <Button size="sm" variant="outline" className={b} disabled={!!ocupado} onClick={() => estado("pausar")}>Pausar</Button>}
        {c.estado === "pausada" && c.motivo_estado === "pelo_gestor" && <Button size="sm" variant="outline" className={b} disabled={!disponivel || !!ocupado} onClick={() => estado("retomar")}>Retomar</Button>}
        <Button size="sm" variant="ghost" className={`${b} text-destructive`} disabled={!!ocupado} onClick={pedirRemover}>Remover</Button>
      </div>
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
  if (casa.smoobu && !c) return <Bloqueada motivo="Bloqueado: esta casa recebe as reservas pelo Smoobu (uma só fonte por casa)." />;
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

/**
 * Matriz do detalhe de um proprietário: casas nas linhas; Airbnb, Booking.com e «Smoobu / outro» nas colunas.
 * As células bloqueadas mostram o cadeado e o motivo (regra «uma só fonte por casa»).
 */
export function MatrizProprietario({ p, disponivel, aoLigar, aoMudar }: {
  p: ProprietarioResumo; disponivel: boolean; aoLigar: (casaId: string, canal: CanalAssistente) => void; aoMudar: () => void;
}) {
  const motivoSemLigar = p.acordo === "por_aceitar" ? "Acordo por aceitar: o proprietário ainda não aceitou o acordo de dados." : null;
  if (p.casas.length === 0) return <p className="text-sm text-muted-foreground">Este proprietário ainda não tem casas.</p>;
  return (
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
          {p.casas.map((c) => {
            const temFontes = !!c.airbnb || !!c.booking || c.outros.length > 0;
            return (
              <tr key={c._id} className="border-b align-top">
                <th scope="row" className="py-3 pr-3 font-medium">{c.nome}{!c.ativo && <span className="ml-1 text-xs font-normal text-muted-foreground">(inativa)</span>}
                  {c.por_confirmar > 0 && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{plural(c.por_confirmar, "período por confirmar", "períodos por confirmar")}</span>}</th>
                <td className="px-3 py-3"><CelulaCanalMatriz casa={c} canal="airbnb" disponivel={disponivel} motivoSemLigar={motivoSemLigar} aoLigar={aoLigar} aoMudar={aoMudar} /></td>
                <td className="px-3 py-3"><CelulaCanalMatriz casa={c} canal="booking" disponivel={disponivel} motivoSemLigar={motivoSemLigar} aoLigar={aoLigar} aoMudar={aoMudar} /></td>
                <td className="px-3 py-3">
                  {c.smoobu ? <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" aria-hidden /> Smoobu da All2gether</p>
                    : temFontes ? <Bloqueada motivo="Bloqueado: já há calendários ligados (uma só fonte por casa)." />
                    : <p className="text-xs text-muted-foreground"><span className="font-medium">Em preparação</span></p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
