"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CalendarDays, Loader2, PauseCircle, RefreshCw, Trash2, Link2, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminDelete, adminGet, adminPatch, adminPost, adminPut } from "@/lib/api";
import { plural } from "@/lib/utils";

export interface CasaParaCalendario {
  _id: string;
  nome: string;
  /** Casas ligadas ao Smoobu não aceitam calendários externos. */
  smoobu_id?: string | null;
}

interface FonteDTO {
  _id: string;
  propriedade_id: string;
  canal: "airbnb" | "booking" | "vrbo" | "outro";
  canal_texto: string;
  url_mascara: string;
  estado: "ativa" | "erro" | "pausada" | "suspensa";
  motivo_estado: string | null;
  estado_texto: string | null;
  ultima_leitura_em: string | null;
  ultimo_sucesso_em: string | null;
  ultimo_erro: { codigo: string; mensagem: string; em: string } | null;
  suspeitas_consecutivas: number;
  n_reservas?: number;
  n_por_confirmar?: number;
}

interface LeituraDTO {
  _id: string;
  iniciada_em: string;
  resultado: "ok" | "sem_alteracoes" | "suspeita" | "erro";
  repetidas?: number;
  n_eventos?: number;
  http_status?: number;
  motivo_suspeita?: string[];
  erro?: { codigo: string; mensagem: string };
}

interface TesteDTO {
  ok: boolean;
  canal?: string;
  canal_texto?: string;
  prodid_ok?: boolean;
  reservas?: number;
  bloqueios?: number;
  por_confirmar?: number;
  ja_existiam?: number;
  amostra?: { check_in: string; check_out: string; tipo: string }[];
  erro?: string;
}

const fmtDia = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

/** «há 20 min», «há 3 h», «há 2 dias» (sem depender do locale do Node). */
function haQuanto(iso: string | null): string {
  if (!iso) return "ainda não";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}

function msg(e: unknown, omissao: string): string {
  const m = (e as { message?: string })?.message;
  return m && m.length < 240 ? m : omissao;
}

const AJUDA = [
  {
    canal: "Airbnb",
    passos: "No Airbnb abre o calendário da casa > Disponibilidade > Sincronização de calendário (Ligar calendários) > Exportar calendário > copia o link que acaba em .ics.",
  },
  {
    canal: "Booking.com",
    passos: "Na Extranet da Booking.com vai a Tarifas e disponibilidade > Sincronizar calendários > Exportar o seu calendário > copia o link. Se houver essa opção, exporta só as reservas. Há um link por alojamento.",
  },
  {
    canal: "Vrbo",
    passos: "No painel da Vrbo abre o calendário da casa > Importar e exportar > Exportar calendário > copia o link.",
  },
];

function EstadoFonte({ f }: { f: FonteDTO }) {
  if (f.estado === "ativa") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> A funcionar · lido {haQuanto(f.ultimo_sucesso_em)}
      </p>
    );
  }
  if (f.estado === "erro") {
    return (
      <p role="status" className="flex items-start gap-1.5 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Com problemas desde {haQuanto(f.ultimo_erro?.em ?? null)}: {f.ultimo_erro?.mensagem ?? "não foi possível ler o calendário."} As limpezas já marcadas continuam.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{f.estado_texto ?? "Em pausa."}</span>
    </p>
  );
}

function Leituras({ apiBase, id }: { apiBase: string; id: string }) {
  const [lista, setLista] = useState<LeituraDTO[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    adminGet<{ leituras: LeituraDTO[] }>(`${apiBase}/calendarios/${id}/leituras?limite=10`)
      .then((r) => vivo && setLista(r.leituras))
      .catch((e) => vivo && setErro(msg(e, "Não foi possível carregar as leituras.")));
    return () => { vivo = false; };
  }, [apiBase, id]);
  if (erro) return <p className="text-sm text-destructive">{erro}</p>;
  if (!lista) return <p className="text-sm text-muted-foreground">A carregar…</p>;
  if (lista.length === 0) return <p className="text-sm text-muted-foreground">Ainda não há leituras.</p>;
  const rotulo: Record<string, string> = { ok: "Atualizado", sem_alteracoes: "Sem alterações", suspeita: "Calendário estranho (nada foi alterado)", erro: "Erro" };
  return (
    <ul className="space-y-1 text-sm">
      {lista.map((l) => (
        <li key={l._id} className="flex flex-wrap gap-x-2 text-muted-foreground">
          <span>{new Date(l.iniciada_em).toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
          <span className="text-foreground">{rotulo[l.resultado]}</span>
          {typeof l.n_eventos === "number" && <span>{plural(l.n_eventos, "período")}</span>}
          {l.erro && <span>{l.erro.mensagem}</span>}
          {!!l.repetidas && <span>(+{plural(l.repetidas, "leitura igual", "leituras iguais")})</span>}
        </li>
      ))}
    </ul>
  );
}

function CartaoFonte({ f, apiBase, gestor, aoMudar }: { f: FonteDTO; apiBase: string; gestor: boolean; aoMudar: () => void }) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [substituir, setSubstituir] = useState(false);
  const [novoLink, setNovoLink] = useState("");
  const [leituras, setLeituras] = useState(false);
  const [remover, setRemover] = useState<{ limpezas: number } | null>(null);

  const correr = async (nome: string, fn: () => Promise<void>) => {
    setOcupado(nome); setErro(null); setInfo(null);
    try { await fn(); aoMudar(); } catch (e) { setErro(msg(e, "Não foi possível concluir.")); } finally { setOcupado(null); }
  };

  const atualizar = () => correr("atualizar", async () => {
    const r = await adminPost<{ leitura: { resultado: string; mensagem?: string; alteracoes?: { criadas: number; por_confirmar: number } } | null }>(`${apiBase}/calendarios/${f._id}/atualizar`, {});
    const l = r.leitura;
    if (l?.resultado === "erro") setErro(l.mensagem ?? "O calendário não respondeu.");
    else setInfo(l?.alteracoes && (l.alteracoes.criadas || l.alteracoes.por_confirmar) ? "Atualizado: há novidades nas reservas." : "Atualizado: sem novidades.");
  });

  const guardarNovoLink = () => correr("substituir", async () => {
    await adminPut(`${apiBase}/calendarios/${f._id}`, { url: novoLink.trim() });
    setNovoLink(""); setSubstituir(false); setInfo("Link substituído.");
  });

  const reativar = () => correr("reativar", async () => {
    const r = await adminPost<{ ok: boolean; erro?: string }>(`${apiBase}/calendarios/${f._id}/reativar`, {});
    if (!r.ok) setErro(r.erro ?? "O teste falhou."); else setInfo("Calendário reativado.");
  });

  const pedirRemover = () => correr("impacto", async () => {
    const r = await adminGet<{ limpezas_a_cancelar: number }>(`${apiBase}/calendarios/${f._id}/impacto-remocao`);
    setRemover({ limpezas: r.limpezas_a_cancelar });
  });

  const confirmarRemover = () => correr("remover", async () => {
    await adminDelete(`${apiBase}/calendarios/${f._id}`);
    setRemover(null);
  });

  const estado = (acao: "pausar" | "retomar" | "aceitar_calendario") => correr(acao, async () => {
    await adminPatch(`${apiBase}/calendarios/${f._id}/estado`, { acao });
  });

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <Link2 className="h-4 w-4 text-brand-text" /> {f.canal_texto}
        </p>
        <p className="break-all text-xs text-muted-foreground" title="Por segurança, o link nunca é mostrado por inteiro.">{f.url_mascara}</p>
      </div>
      <EstadoFonte f={f} />
      <p className="text-xs text-muted-foreground">
        {plural(f.n_reservas ?? 0, "reserva ligada", "reservas ligadas")}
        {!!f.n_por_confirmar && ` · ${plural(f.n_por_confirmar, "período por confirmar", "períodos por confirmar")}`}
      </p>
      {gestor && f.suspeitas_consecutivas > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          O último calendário veio estranho ({plural(f.suspeitas_consecutivas, "leitura")}) e nada foi cancelado.{" "}
          <button type="button" className="min-h-9 underline" onClick={() => estado("aceitar_calendario")}>Aceitar o calendário como está</button>
        </p>
      )}
      {erro && <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {info && <p role="status" className="text-sm text-muted-foreground">{info}</p>}
      <div className="flex flex-wrap gap-2">
        {(f.estado === "ativa" || f.estado === "erro") && (
          <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-9" disabled={!!ocupado} onClick={atualizar}>
            {ocupado === "atualizar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Atualizar agora
          </Button>
        )}
        {(f.estado === "suspensa" || f.estado === "erro") && f.motivo_estado !== "casa_ligada_smoobu" && (
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={!!ocupado} onClick={reativar}>Testar e reativar</Button>
        )}
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setSubstituir((s) => !s)}>Substituir link</Button>
        {gestor && f.estado === "ativa" && <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={!!ocupado} onClick={() => estado("pausar")}>Pausar</Button>}
        {gestor && f.estado === "pausada" && f.motivo_estado === "pelo_gestor" && <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={!!ocupado} onClick={() => estado("retomar")}>Retomar</Button>}
        <Button size="sm" variant="outline" className="min-h-11 gap-1 sm:min-h-9" onClick={() => setLeituras((s) => !s)} aria-expanded={leituras}>
          <ListChecks className="h-4 w-4" /> Últimas leituras
        </Button>
        <Button size="sm" variant="ghost" className="min-h-11 gap-1 text-destructive sm:min-h-9" disabled={!!ocupado} onClick={pedirRemover}>
          {ocupado === "impacto" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remover
        </Button>
      </div>
      {substituir && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={novoLink} onChange={(e) => setNovoLink(e.target.value)} placeholder="Cola aqui o link novo (https://…)" aria-label={`Novo link do calendário ${f.canal_texto}`}
            className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base" autoComplete="off" spellCheck={false}
          />
          <Button className="min-h-11 sm:min-h-9" disabled={!novoLink.trim() || !!ocupado} onClick={guardarNovoLink}>Guardar link</Button>
        </div>
      )}
      {leituras && <Leituras apiBase={apiBase} id={f._id} />}

      <Dialog open={remover !== null} onOpenChange={(o) => { if (!o) setRemover(null); }}>
        <DialogHeader>
          <DialogTitle>Remover o calendário {f.canal_texto}?</DialogTitle>
          <DialogDescription>
            {remover && remover.limpezas > 0
              ? `Vão ser canceladas ${plural(remover.limpezas, "limpeza futura", "limpezas futuras")} que vieram deste calendário (as que já começaram ficam). A equipa e o proprietário são avisados.`
              : "Não há limpezas futuras que dependam deste calendário. As reservas e limpezas que já começaram ficam como estão."}
          </DialogDescription>
          <DialogClose onClick={() => setRemover(null)} />
        </DialogHeader>
        <DialogContent>
          <p className="text-sm text-muted-foreground">Depois podes voltar a ligar o mesmo calendário quando quiseres.</p>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => setRemover(null)}>Cancelar</Button>
          <Button variant="destructive" className="min-h-11" disabled={ocupado === "remover"} onClick={confirmarRemover}>
            {ocupado === "remover" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {remover && remover.limpezas > 0 ? `Remover e cancelar ${plural(remover.limpezas, "limpeza")}` : "Remover"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function NovaLigacao({ casa, apiBase, aoMudar }: { casa: CasaParaCalendario; apiBase: string; aoMudar: () => void }) {
  const [url, setUrl] = useState("");
  const [rotulo, setRotulo] = useState("");
  const [teste, setTeste] = useState<TesteDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<"testar" | "gravar" | null>(null);
  const [resultado, setResultado] = useState<string | null>(null);

  const testar = async () => {
    setOcupado("testar"); setErro(null); setTeste(null); setResultado(null);
    try { setTeste(await adminPost<TesteDTO>(`${apiBase}/calendarios/testar`, { propriedade_id: casa._id, url: url.trim() })); }
    catch (e) { setErro(msg(e, "Não foi possível testar o link.")); } finally { setOcupado(null); }
  };

  const gravar = async () => {
    setOcupado("gravar"); setErro(null); setResultado(null);
    try {
      const r = await adminPost<{ leitura: { alteracoes?: { criadas: number; por_confirmar: number; duplicadas: number }; resultado?: string; mensagem?: string } | null }>(`${apiBase}/calendarios`, { propriedade_id: casa._id, url: url.trim(), ...(rotulo.trim() ? { rotulo: rotulo.trim() } : {}) });
      const a = r.leitura?.alteracoes;
      setResultado(
        r.leitura?.resultado === "erro" ? `Ligado, mas a primeira leitura falhou: ${r.leitura.mensagem ?? "tenta mais tarde."}`
          : a ? `Ligado. ${plural(a.criadas, "limpeza nova", "limpezas novas")}; ${plural(a.por_confirmar, "período por confirmar", "períodos por confirmar")}.` : "Ligado."
      );
      setUrl(""); setTeste(null);
      aoMudar();
    } catch (e) { setErro(msg(e, "Não foi possível gravar o link.")); } finally { setOcupado(null); }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-sm font-medium">Ligar um calendário</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={url} onChange={(e) => { setUrl(e.target.value); setTeste(null); }} placeholder="Cola aqui o link do calendário (Airbnb, Booking.com…)" aria-label={`Link do calendário de ${casa.nome}`}
          className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base" autoComplete="off" spellCheck={false}
        />
        <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={!url.trim() || !!ocupado} onClick={testar}>
          {ocupado === "testar" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Testar ligação
        </Button>
      </div>
      {erro && <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {teste && !teste.ok && <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {teste.erro}</p>}
      {teste?.ok && (
        <div role="status" className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {teste.canal_texto}: encontrámos {plural(teste.reservas ?? 0, "reserva")}, {plural(teste.bloqueios ?? 0, "bloqueio")}
            {!!teste.por_confirmar && ` e ${plural(teste.por_confirmar, "período por confirmar", "períodos por confirmar")}`}.
          </p>
          {!teste.prodid_ok && <p className="text-amber-700 dark:text-amber-400">Atenção: este calendário não parece ser do {teste.canal_texto}.</p>}
          {!!teste.ja_existiam && <p className="text-muted-foreground">{plural(teste.ja_existiam, "já existia nas tuas reservas", "já existiam nas tuas reservas")} e fica ligada, sem limpeza repetida.</p>}
          {teste.amostra && teste.amostra.length > 0 && (
            <p className="text-muted-foreground">Primeiras datas: {teste.amostra.map((a) => `${fmtDia(a.check_in)} a ${fmtDia(a.check_out)}`).join(" · ")}</p>
          )}
          {teste.canal === "outro" && (
            <input value={rotulo} maxLength={40} onChange={(e) => setRotulo(e.target.value)} placeholder="Nome do canal (opcional)" aria-label="Nome do canal" className="h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:max-w-xs" />
          )}
          <Button className="min-h-11 sm:min-h-9" disabled={!!ocupado} onClick={gravar}>
            {ocupado === "gravar" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Gravar
          </Button>
        </div>
      )}
      {resultado && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{resultado}</p>}
      <details className="text-sm text-muted-foreground">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-brand-text sm:min-h-9">Onde copio o link?</summary>
        <ul className="space-y-2 pb-1">
          {AJUDA.map((a) => (
            <li key={a.canal}><strong className="text-foreground">{a.canal}:</strong> {a.passos}</li>
          ))}
          <li>Os menus podem mudar. O link é secreto: quem o tiver lê o calendário. Guardamo-lo cifrado e nunca o mostramos por inteiro.</li>
        </ul>
      </details>
    </div>
  );
}

/**
 * Calendários externos (Airbnb, Booking.com…) das casas: colar o link, testar a ligação, ver o estado da
 * última leitura (em linguagem simples), atualizar, substituir e remover. Usado no portal do proprietário
 * (`apiBase = /api/parceiro`) e pelo gestor na página da propriedade (`/api/gestor`).
 */
export function CalendariosCasas({ apiBase, casas, gestor = false }: { apiBase: string; casas: CasaParaCalendario[]; gestor?: boolean }) {
  const [fontes, setFontes] = useState<FonteDTO[]>([]);
  const [ligado, setLigado] = useState(true);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await adminGet<{ fontes: FonteDTO[]; ligado: boolean }>(`${apiBase}/calendarios`);
      setFontes(r.fontes ?? []);
      setLigado(r.ligado !== false);
      setErro(null);
    } catch (e) {
      setErro(msg(e, "Não foi possível carregar os calendários."));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { carregar(); }, [carregar]);

  if (loading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>;

  return (
    <div className="space-y-4">
      {!ligado && (
        <Card className="border-amber-500/60" role="status">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            A ligação a calendários externos ainda não está ativada neste sistema. Fala com o administrador.
          </CardContent>
        </Card>
      )}
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
      {casas.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há casas.</p>}
      {casas.map((c) => {
        const daCasa = fontes.filter((f) => f.propriedade_id === c._id);
        return (
          <Card key={c._id}>
            <CardContent className="space-y-3 p-4">
              <h2 className="flex items-center gap-2 text-base font-semibold"><CalendarDays className="h-5 w-5 text-brand-text" /> {c.nome}</h2>
              {c.smoobu_id ? (
                <p className="text-sm text-muted-foreground">Esta casa recebe as reservas pelo Smoobu: não precisa de calendários externos (só pode haver uma ligação automática por casa).</p>
              ) : (
                <>
                  {daCasa.map((f) => <CartaoFonte key={f._id} f={f} apiBase={apiBase} gestor={gestor} aoMudar={carregar} />)}
                  {ligado && <NovaLigacao casa={c} apiBase={apiBase} aoMudar={carregar} />}
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
