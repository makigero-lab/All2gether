"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminPatch, adminPost } from "@/lib/api";
import { plural } from "@/lib/utils";
import { canalDoLink, fraseDoTeste, msgErro, resultadoAceitar, resultadoLigar, semCasasParaLigar, type ProprietarioResumo, type RespostaLigar } from "./tipos";

export type CanalAssistente = "airbnb" | "booking";

interface Passo { texto: string; /** Menu não confirmado no ecrã atual do canal: pode ter mudado. */ confirmar?: boolean }

const DICA_MENU = "Os menus do Airbnb/Booking mudam às vezes; se não encontrares, diz-nos.";

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
  temporario?: boolean;
}

/** Estado final do assistente: ligado (ok), à espera de validação (com «Aceitar») ou primeira leitura falhada. */
interface Feito { tipo: "ok" | "validacao" | "erro"; texto: string; fonteId?: string }

type Erro = { texto: string; codigo?: string };

/**
 * Assistente «Ligar»: escolhe a casa e o canal, mostra os passos do canal, recebe o link, testa logo
 * quando o gestor carrega em «Testar ligação» (colar o link ou trocar de canal NÃO testa: cada teste conta no
 * limite por hora) e só liga depois de um teste bom. «Smoobu / outro sistema» está desativado («Em preparação»).
 * O link nunca é mostrado depois de gravado.
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
  const [ocupado, setOcupado] = useState<"testar" | "ligar" | "aceitar" | null>(null);
  const [feito, setFeito] = useState<Feito | null>(null);
  const semCasas = useMemo(() => semCasasParaLigar(proprietario), [proprietario]);

  const casa = casasLivres.find((c) => c._id === casaId) ?? null;
  const bloqueioCasa = casa?.smoobu ? "Esta casa já recebe as reservas pelo Smoobu. Só pode haver uma ligação automática por casa." : null;
  const canalLigado = casa && canal ? !!casa[canal] : false;
  // O canal que o servidor reconheceu no teste manda; antes do teste, o domínio do link dá uma primeira sugestão.
  const sugerido = canal ? (teste?.canal === "airbnb" || teste?.canal === "booking" ? (teste.canal as CanalAssistente) : canalDoLink(url)) : null;
  const canalErrado = sugerido && sugerido !== "outro" && canal && sugerido !== canal ? sugerido : null;

  const testar = async () => {
    if (!casa || !url.trim()) return;
    setOcupado("testar"); setErro(null); setTeste(null);
    try {
      const r = await adminPost<Teste>("/api/gestor/calendarios/testar", { propriedade_id: casa._id, url: url.trim() });
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
      const r = await adminPost<RespostaLigar & { fonte?: { _id?: string } }>("/api/gestor/calendarios", { propriedade_id: casa._id, url: url.trim() });
      const res = resultadoLigar(r);
      setFeito({ tipo: res.tipo, texto: res.texto, fonteId: (r.fonte as { _id?: string } | null | undefined)?._id });
      setUrl(""); setTeste(null);
      aoLigar();
    } catch (e) { setErro({ texto: msgErro(e, "Não foi possível ligar o calendário."), codigo: (e as { codigo?: string })?.codigo }); }
    finally { setOcupado(null); }
  };

  // «Aceitar» dá resposta imediata: o servidor lê já o calendário e cria as limpezas.
  const aceitar = async () => {
    if (!feito?.fonteId) return;
    setOcupado("aceitar"); setErro(null);
    try {
      const r = await adminPatch<{ leitura?: { alteracoes?: { criadas: number; por_confirmar: number } | null } | null }>(`/api/gestor/calendarios/${feito.fonteId}/estado`, { acao: "aceitar_calendario" });
      setFeito({ tipo: "ok", texto: resultadoAceitar(r.leitura) });
      aoLigar();
    } catch (e) { setErro({ texto: msgErro(e, "Não foi possível aceitar o calendário."), codigo: (e as { codigo?: string })?.codigo }); }
    finally { setOcupado(null); }
  };

  // Trocar de canal só muda o canal escolhido: o teste volta a ser um clique do gestor.
  const trocarCanal = (novo: CanalAssistente) => { setCanal(novo); setTeste(null); setErro(null); };

  const bloqueado = !!bloqueioCasa || canalLigado;

  // Quando aparece um resultado, um aviso ou um erro, leva-o à vista (em ecrãs baixos ficava abaixo da dobra).
  const fimRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (teste || erro || canalErrado || feito) fimRef.current?.scrollIntoView?.({ block: "nearest" }); }, [teste, erro, canalErrado, feito]);

  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o) aoFechar(); }} ecraInteiroNoTelemovel>
      <DialogHeader>
        <DialogTitle>Ligar um calendário a {proprietario.nome}</DialogTitle>
        <DialogDescription>Escolhe a casa e o canal, copia o link no canal e cola-o aqui. Testamos já a ligação.</DialogDescription>
        <DialogClose onClick={aoFechar} />
      </DialogHeader>
      <DialogContent>
        <div className="space-y-4 text-sm">
          {semCasas ? (
            <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/60 p-3"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden /> {semCasas}</p>
          ) : feito ? (
            <div className="space-y-3">
              <p role="status" className={`flex items-start gap-2 ${feito.tipo === "validacao" ? "text-amber-700 dark:text-amber-400" : feito.tipo === "erro" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}>
                {feito.tipo === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />} {feito.texto}
              </p>
              {feito.tipo === "validacao" && feito.fonteId && (
                <div className="space-y-1.5">
                  <Button className="min-h-11" disabled={!!ocupado} onClick={aceitar}>{ocupado === "aceitar" && <Loader2 className="h-4 w-4 animate-spin" />} {ocupado === "aceitar" ? "A criar as limpezas…" : "Aceitar"}</Button>
                  <p className="text-xs text-muted-foreground">«Aceitar» confirma que o calendário está certo e cria já as limpezas. Se não tiveres a certeza, fecha: fica à espera na área Integrações.</p>
                </div>
              )}
              {erro && <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {erro.texto}</p>}
            </div>
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
                      <li key={p.texto}>{p.texto}{p.confirmar && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={DICA_MENU} tabIndex={0}>pode ter mudado</span>}</li>
                    ))}
                  </ol>
                  {PASSOS[canal].nota && <p className="text-xs text-muted-foreground">{PASSOS[canal].nota}</p>}
                  <a href={PASSOS[canal].abrir} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent sm:min-h-9">
                    <ExternalLink className="h-4 w-4" aria-hidden /> Abrir o {PASSOS[canal].nome}
                  </a>
                  <label className="flex flex-col gap-1 font-medium">
                    Link do calendário
                    <input value={url} onChange={(e) => { setUrl(e.target.value); setTeste(null); setErro(null); }} autoComplete="off" spellCheck={false}
                      placeholder="Cola aqui o link (https://…)" aria-label="Link do calendário" className="h-11 rounded-md border border-input bg-background px-3 text-base font-normal" />
                    <span className="text-xs font-normal text-muted-foreground">O link é privado: guardamo-lo cifrado e nunca o mostramos por inteiro.</span>
                  </label>
                  <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={!url.trim() || !!ocupado || !!canalErrado} onClick={() => testar()}>
                    {ocupado === "testar" && <Loader2 className="h-4 w-4 animate-spin" />} {ocupado === "testar" ? "A testar…" : "Testar ligação"}
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
                      {erro.texto}
                    </p>
                  )}
                  {teste && !teste.ok && <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {teste.erro}</p>}
                  {teste?.ok && !canalErrado && (
                    <div role="status" className="space-y-1.5 rounded-md bg-muted/40 p-3">
                      <p className="flex items-start gap-2 font-medium"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden /> {fraseDoTeste(teste)}</p>
                      {!!teste.por_confirmar && <p>Depois de ligar, confirmas um a um ou em lote no separador «Reservas por confirmar».</p>}
                      {teste.prodid_ok === false && <p className="text-amber-700 dark:text-amber-400">Atenção: este calendário não parece ser do {teste.canal_texto}.</p>}
                      {!!teste.ja_existiam && <p className="text-muted-foreground">{plural(teste.ja_existiam, "reserva já existia", "reservas já existiam")} e fica ligada, sem limpeza repetida.</p>}
                    </div>
                  )}
                </div>
              )}
              {casa && canalLigado && <p className="text-muted-foreground">Esta casa já tem o {canal ? PASSOS[canal].nome : "canal"} ligado. Para mudar o link, remove a ligação na matriz e volta a ligar.</p>}
            </>
          )}
          <div ref={fimRef} aria-hidden />
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" className="min-h-11" onClick={aoFechar}>{feito || semCasas ? "Fechar" : "Cancelar"}</Button>
        {!feito && !semCasas && <Button className="min-h-11" disabled={!teste?.ok || !!ocupado || bloqueado || !!canalErrado} onClick={ligar}>{ocupado === "ligar" && <Loader2 className="h-4 w-4 animate-spin" />} Ligar</Button>}
      </DialogFooter>
    </Dialog>
  );
}
