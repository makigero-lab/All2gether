"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { adminGet, adminPost } from "@/lib/api";

export interface AcordoDTO {
  obrigatorio: boolean;
  versao: string;
  hash: string;
  texto: string;
  aceite: boolean;
  aceite_em: string | null;
}

/** Negrito `**…**` como nós React (nunca innerHTML). */
function comNegrito(t: string) {
  return t.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/** Mostra o texto do acordo (markdown simples: títulos # e negrito) sem sinais soltos. */
function TextoAcordo({ texto }: { texto: string }) {
  return (
    <>
      {texto.split("\n").map((l, i) => {
        if (!l.trim()) return null;
        const m = l.match(/^(#{1,3})\s+(.*)$/);
        if (m) return m[1].length === 1 ? <h2 key={i} className="mb-2 text-base font-semibold">{m[2]}</h2> : <h3 key={i} className="mb-1 mt-4 font-semibold">{m[2]}</h3>;
        if (/^\|?\s*-{3,}/.test(l)) return null;
        return <p key={i} className="mb-2">{comNegrito(l)}</p>;
      })}
    </>
  );
}

const fmtData = (iso: string) => new Date(iso).toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Aviso curto no portal do proprietário: só aparece quando o acordo é exigido (ACORDO_RGPD_OBRIGATORIO no servidor)
 * e ainda não foi aceite. Com o interruptor desligado (fase de testes) não mostra nada.
 */
export function AvisoAcordo() {
  const [a, setA] = useState<AcordoDTO | null>(null);
  useEffect(() => { adminGet<AcordoDTO>("/api/parceiro/acordo-dados").then(setA).catch(() => undefined); }, []);
  if (!a || !a.obrigatorio || a.aceite) return null;
  return (
    <div role="status" className="border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/30">
      <span className="mr-2">Tens um acordo de tratamento de dados por aceitar. Sem ele a All2gether não pode ligar os teus calendários.</span>
      <Link href="/parceiro/acordo" className="inline-flex min-h-11 items-center font-medium underline sm:min-h-9">Ler e aceitar</Link>
    </div>
  );
}

/** Ecrã do acordo: texto integral numa caixa com scroll, caixa de seleção não pré-assinalada e botão «Aceitar e continuar». */
export function EcraAcordo() {
  const [a, setA] = useState<AcordoDTO | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [marcado, setMarcado] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const carregar = () => adminGet<AcordoDTO>("/api/parceiro/acordo-dados").then(setA).catch(() => setErro("Não foi possível carregar o acordo."));
  useEffect(() => { void carregar(); }, []);

  const aceitar = async () => {
    if (!a) return;
    setOcupado(true); setErro(null);
    try { await adminPost("/api/parceiro/acordo-dados/aceitar", { versao: a.versao, hash: a.hash, confirmo: true }); await carregar(); }
    catch (e) { setErro((e as Error).message || "Não foi possível registar a aceitação."); }
    finally { setOcupado(false); }
  };

  if (!a) return erro ? <p role="alert" className="text-sm text-destructive">{erro}</p> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A carregar…</p>;
  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><FileText className="h-6 w-6 text-brand-text" /> Acordo de tratamento de dados dos seus hóspedes</h1>
      <p className="rounded-md bg-muted/40 p-3 text-sm">
        Para limpar as suas casas recebemos as datas das reservas. Guardamos só o mínimo (datas, casa, n.º de hóspedes e um identificador da reserva) e apagamos o resto logo que chega.
        Os dados ficam até 90 dias depois da saída. Você continua responsável pelos dados dos seus hóspedes; nós tratamo-los só por sua conta.
      </p>
      {!a.obrigatorio && <p className="text-sm text-muted-foreground">Neste momento o acordo não é obrigatório. Pode lê-lo e aceitá-lo já, se quiser.</p>}
      <div tabIndex={0} aria-label="Texto do acordo" className="max-h-[50vh] overflow-y-auto rounded-md border p-4 text-sm leading-relaxed"><TextoAcordo texto={a.texto} /></div>
      <p className="text-xs text-muted-foreground">Versão {a.versao}</p>
      {a.aceite ? (
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Aceitou o acordo a {a.aceite_em ? fmtData(a.aceite_em) : ""}.</p>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <Checkbox checked={marcado} onCheckedChange={setMarcado} className="mt-0.5" />
            <span>Li e aceito o Acordo de Tratamento de Dados (versão {a.versao}), em meu nome ou em nome da entidade que represento, e declaro que tenho autorização para ligar estas casas.</span>
          </label>
          <Button className="min-h-11" disabled={!marcado || ocupado} onClick={aceitar}>{ocupado && <Loader2 className="h-4 w-4 animate-spin" />} Aceitar e continuar</Button>
        </div>
      )}
      {erro && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {erro}</p>}
    </div>
  );
}
