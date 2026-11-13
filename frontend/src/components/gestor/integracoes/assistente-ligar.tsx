"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { canalDoLink, diaMes, msgErro, type ProprietarioResumo } from "./tipos";

export type CanalAssistente = "airbnb" | "booking";

interface Passo { texto: string; /** Menu não confirmado no ecrã atual do canal: marcado para revisão. */ confirmar?: boolean }

/** Passos de cada canal (pesquisa de 2026-11-13). Os rótulos em português não vêm de documentação oficial. */
export const PASSOS: Record<CanalAssistente, { nome: string; abrir: string; passos: Passo[]; nota?: string }> = {
  airbnb: {
    nome: "Airbnb",
    abrir: "https://www.airbnb.pt/hosting/calendar",
    passos: [
      { texto: "No Airbnb, no modo anfitrião, abre o Calendário e escolhe a casa." },
      { texto: "Abre o separador Disponibilidade." },
      { texto: "Em «Ligar calendários», escolhe «Ligar a outro site».", confirmar: true },
      { texto: "Copia a ligação do calendário (acaba em .ics) e cola-a abaixo." },
    ],
    nota: "Faz isto no computador (ou no site, não na app): a app pode não mostrar a exportação.",
  },
  booking: {
    nome: "Booking.com",
    abrir: "https://admin.booking.com",
    passos: [
      { texto: "Entra na Extranet da Booking.com e escolhe o alojamento." },
      { texto: "Abre «Tarifas e disponibilidade» > «Sincronizar calendários».", confirmar: true },
      { texto: "Escolhe «Conectar um calendário» e depois «Saltar para exportar».", confirmar: true },
      { texto: "Dá um nome à ligação e carrega em «Copiar ligação». Se perguntar o que exportar, escolhe «Datas reservadas»." },
    ],
    nota: "Se a opção não aparecer, o proprietário provavelmente usa um channel manager: nesse caso não há calendário do Booking para ligar aqui.",
  },
};

interface Teste {
  ok: boolean;
  canal?: string;
  canal_texto?: string;
  prodid_ok?: boolean;
  reservas?: number;
  bloqueios?: number;
  por_confirmar?: number;
  periodo?: { de: string; ate: string } | null;
  ja_existiam?: number;
  ja_ligada?: boolean;
  erro?: string;
}

type Erro = { texto: string; codigo?: string };

/**
 * Assistente «Ligar»: escolhe a casa e o canal, mostra os passos do canal, recebe o link, testa logo
 * (com o resultado concreto) e só liga depois de o gestor confirmar. «Smoobu / outro sistema» está
 * desativado («Em preparação»). O link nunca é mostrado depois de gravado.
 */
export function AssistenteLigar({
  proprietario, casaInicial, canalInicial, aberto, aoFechar, aoLigar,
}: {
  proprietario: ProprietarioResumo;
  casaInicial?: string;
  canalInicial?: CanalAssistente;
  aberto: boolean;
  aoFechar: () => void;
  aoLigar: () => void;
}) {
  const casasLivres = useMemo(() => proprietario.casas.filter((c) => c.ativo), [proprietario]);
  const [casaId, setCasaId] = useState(casaInicial ?? (proprietario.casas.filter((c) => c.ativo && !c.smoobu).length === 1 ? proprietario.casas.find((c) => c.ativo && !c.smoobu)!._id : ""));
  const [canal, setCanal] = useState<CanalAssistente | null>(canalInicial ?? null);
  const [url, setUrl] = useState("");
  const [teste, setTeste] = useState<Teste | null>(null);
  const [erro, setErro] = useState<Erro | null>(null);
  const [ocupado, setOcupado] = useState<"testar" | "ligar" | null>(null);
  const [feito, setFeito] = useState<string | null>(null);

  const casa = casasLivres.find((c) => c._id === casaId) ?? null;
  const bloqueioCasa = casa?.smoobu ? "Esta casa já recebe as reservas pelo Smoobu. Só pode haver uma ligação automática por casa." : null;
  const canalLigado = casa && canal ? !!casa[canal] : false;
  const sugerido = canal ? canalDoLink(url) : null;
  const canalErrado = sugerido && sugerido !== "outro" && canal && sugerido !== canal ? sugerido : null;

  const testar = async (link = url) => {
    if (!casa || !link.trim()) return;
    setOcupado("testar"); setErro(null); setTeste(null);
    try {
      const r = await adminPost<Teste>("/api/gestor/calendarios/testar", { propriedade_id: casa._id, url: link.trim() });
      setTeste(r);
    } catch (e) {
      const codigo = (e as { codigo?: string })?.codigo;
      setErro({ texto: msgErro(e, "Não foi possível testar o link."), codigo });
    } finally { setOcupado(null); }
  };

  const ligar = async () => {
    if (!casa) return;
    setOcupado("ligar"); setErro(null);
    try {
      const r = await adminPost<{ leitura: { resultado?: string; mensagem?: string; alteracoes?: { criadas: number; por_confirmar: number } } | null }>("/api/gestor/calendarios", { propriedade_id: casa._id, url: url.trim() });
      const a = r.leitura?.alteracoes;
      setFeito(r.leitura?.resultado === "erro" ? `Ligado, mas a primeira leitura falhou: ${r.leitura.mensagem ?? "tenta mais tarde."}`
        : a ? `Ligado. ${plural(a.criadas, "limpeza nova", "limpezas novas")}; ${plural(a.por_confirmar, "período por confirmar", "períodos por confirmar")}.` : "Ligado.");
      setUrl(""); setTeste(null);
      aoLigar();
    } catch (e) { setErro({ texto: msgErro(e, "Não foi possível ligar o calendário."), codigo: (e as { codigo?: string })?.codigo }); }
    finally { setOcupado(null); }
  };

  const colar = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData("text");
    if (t && t.trim().startsWith("http")) { setUrl(t); void testar(t); e.preventDefault(); }
  };

  const trocarCanal = (novo: CanalAssistente) => { setCanal(novo); setTeste(null); setErro(null); void testar(); };

  const bloqueado = !!bloqueioCasa || canalLigado;

  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o) aoFechar(); }} ecraInteiroNoTelemovel>
      <DialogHeader>
        <DialogTitle>Ligar um calendário a {proprietario.nome}</DialogTitle>
        <DialogDescription>Escolhe a casa e o canal, copia o link no canal e cola-o aqui. Testamos já a ligação.</DialogDescription>
        <DialogClose onClick={aoFechar} />
      </DialogHeader>
      <DialogContent>
        <div className="space-y-4 text-sm">
          {feito ? (
            <p role="status" className="flex items-start gap-2 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {feito}</p>
          ) : (
            <>
              <label className="flex flex-col gap-1 font-medium">
                Casa
                <select value={casaId} onChange={(e) => { setCasaId(e.target.value); setTeste(null); setErro(null); }} className="h-11 rounded-md border border-input bg-background px-3 text-base font-normal" aria-label="Casa">
                  <option value="">— Escolhe a casa —</option>
                  {casasLivres.map((c) => <option key={c._id} value={c._id}>{c.nome}{c.smoobu ? " (Smoobu)" : ""}</option>)}
                </select>
              </label>
              {bloqueioCasa && <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {bloqueioCasa}</p>}

              <fieldset className="space-y-2">
                <legend className="font-medium">Canal</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(["airbnb", "booking"] as CanalAssistente[]).map((k) => {
                    const ligado = casa ? !!casa[k] : false;
                    return (
                      <button key={k} type="button" disabled={!casa || !!bloqueioCasa || ligado} aria-pressed={canal === k}
                        onClick={() => { setCanal(k); setTeste(null); setErro(null); }}
                        className={`flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium disabled:opacity-60 ${canal === k ? "border-primary bg-accent" : "border-input bg-background hover:bg-accent"}`}>
                        {ligado && <Lock className="h-3.5 w-3.5" aria-hidden />} {PASSOS[k].nome}{ligado ? " (já ligado)" : ""}
                      </button>
                    );
                  })}
                  <button type="button" disabled aria-disabled className="flex min-h-11 flex-col items-center justify-center rounded-md border border-dashed border-input px-3 text-sm text-muted-foreground opacity-70">
                    <span className="font-medium">Smoobu / outro sistema</span>
                    <span className="text-xs">Em preparação</span>
                  </button>
                </div>
              </fieldset>

              {casa && canal && !bloqueado && (
                <div className="space-y-3">
                  <ol className="list-decimal space-y-1.5 pl-5">
                    {PASSOS[canal].passos.map((p) => (
                      <li key={p.texto}>{p.texto}{p.confirmar && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Os nomes dos menus vêm de guias de terceiros e podem ter mudado.">menu por confirmar</span>}</li>
                    ))}
                  </ol>
                  {PASSOS[canal].nota && <p className="text-xs text-muted-foreground">{PASSOS[canal].nota}</p>}
                  <a href={PASSOS[canal].abrir} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent sm:min-h-9">
                    <ExternalLink className="h-4 w-4" aria-hidden /> Abrir o {PASSOS[canal].nome}
                  </a>
                  <label className="flex flex-col gap-1 font-medium">
                    Link do calendário
                    <input value={url} onChange={(e) => { setUrl(e.target.value); setTeste(null); setErro(null); }} onPaste={colar} autoComplete="off" spellCheck={false}
                      placeholder="Cola aqui o link (https://…)" aria-label="Link do calendário" className="h-11 rounded-md border border-input bg-background px-3 text-base font-normal" />
                    <span className="text-xs font-normal text-muted-foreground">O link é privado: guardamo-lo cifrado e nunca o mostramos por inteiro.</span>
                  </label>
                  <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={!url.trim() || !!ocupado} onClick={() => testar()}>
                    {ocupado === "testar" && <Loader2 className="h-4 w-4 animate-spin" />} Testar ligação
                  </Button>

                  {canalErrado && (
                    <div role="status" className="rounded-md border border-amber-500/60 p-3">
                      <p>Este link parece do {PASSOS[canalErrado].nome}. Queres ligá-lo à casa {casa.nome} como {PASSOS[canalErrado].nome}?</p>
                      <Button size="sm" className="mt-2 min-h-11 sm:min-h-9" disabled={!!casa[canalErrado]} onClick={() => trocarCanal(canalErrado)}>Trocar para {PASSOS[canalErrado].nome}</Button>
                      {casa[canalErrado] && <p className="mt-1 text-xs text-muted-foreground">Esta casa já tem o {PASSOS[canalErrado].nome} ligado.</p>}
                    </div>
                  )}
                  {erro && (
                    <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      {erro.codigo === "LINK_USADO" || erro.codigo === "LINK_REPETIDO" ? "Este link já está a ser usado noutra casa. Confirma que copiaste o da casa certa." : erro.texto}
                    </p>
                  )}
                  {teste && !teste.ok && <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {teste.erro}</p>}
                  {teste?.ok && (
                    <div role="status" className="space-y-1.5 rounded-md bg-muted/40 p-3">
                      <p className="flex items-start gap-2 font-medium"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        Encontrámos {plural(teste.reservas ?? 0, "reserva")} e {plural(teste.bloqueios ?? 0, "bloqueio")}
                        {teste.periodo ? ` entre ${diaMes(teste.periodo.de)} e ${diaMes(teste.periodo.ate)}` : ""}.
                      </p>
                      {!!teste.por_confirmar && (
                        <p>{teste.por_confirmar} por confirmar: o Booking.com não diz se um período fechado é uma reserva ou um bloqueio. Depois de ligar, confirmas um a um ou em lote no separador «Reservas por confirmar».</p>
                      )}
                      {teste.prodid_ok === false && <p className="text-amber-700 dark:text-amber-400">Atenção: este calendário não parece ser do {teste.canal_texto}.</p>}
                      {!!teste.ja_existiam && <p className="text-muted-foreground">{plural(teste.ja_existiam, "reserva já existia", "reservas já existiam")} e fica ligada, sem limpeza repetida.</p>}
                    </div>
                  )}
                </div>
              )}
              {casa && canalLigado && <p className="text-muted-foreground">Esta casa já tem o {canal ? PASSOS[canal].nome : "canal"} ligado. Para mudar o link, remove a ligação na matriz e volta a ligar.</p>}
            </>
          )}
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" className="min-h-11" onClick={aoFechar}>{feito ? "Fechar" : "Cancelar"}</Button>
        {!feito && <Button className="min-h-11" disabled={!teste?.ok || !!ocupado || bloqueado || !!canalErrado} onClick={ligar}>{ocupado === "ligar" && <Loader2 className="h-4 w-4 animate-spin" />} Ligar</Button>}
      </DialogFooter>
    </Dialog>
  );
}
