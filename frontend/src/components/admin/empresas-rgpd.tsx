"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { AlertCircle, Building2, Download, Loader2, RotateCcw, ShieldX, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminGet, adminPost } from "@/lib/api";
import { descarregarFicheiro } from "@/lib/descarregar";

interface EmpresaDTO {
  _id: string;
  nome: string;
  nif?: string;
  ativa?: boolean;
  apagada?: boolean;
  eliminacao_agendada_para?: string | null;
  num_propriedades?: number;
  num_tarefas?: number;
}

/** O nome tem de ser escrito exatamente como está (o backend volta a validar). */
export function nomeConfere(escrito: string, nome: string): boolean {
  return nome.length > 0 && escrito === nome;
}

export function dataPrevista(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : format(d, "dd/MM/yyyy");
}

/**
 * Super Admin: por empresa, «Exportar empresa», «Agendar eliminação» (escrever o nome) e «Cancelar eliminação».
 * O apagamento definitivo só acontece depois do período de segurança (job diário no servidor).
 */
export function EmpresasRgpd({ empresaPropriaId }: { empresaPropriaId?: string }) {
  const [empresas, setEmpresas] = useState<EmpresaDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null);

  const [alvo, setAlvo] = useState<EmpresaDTO | null>(null);
  const [escrito, setEscrito] = useState("");
  const [dias, setDias] = useState("30");
  const [a, setA] = useState(false);
  const [erroDialogo, setErroDialogo] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await adminGet<{ empresas: EmpresaDTO[] }>("/api/admin/empresas");
      setEmpresas((r.empresas ?? []).filter((e) => !e.apagada || e.eliminacao_agendada_para));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível carregar as empresas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function exportar(e: EmpresaDTO) {
    setOcupada(e._id);
    setMsg(null);
    try {
      await descarregarFicheiro(`/api/admin/empresas/${e._id}/exportar`, `empresa-${e._id}.json`);
      setMsg({ tipo: "ok", texto: `Exportação de «${e.nome}» descarregada.` });
    } catch (err) {
      setMsg({ tipo: "erro", texto: err instanceof Error ? err.message : "Não foi possível exportar a empresa." });
    } finally {
      setOcupada(null);
    }
  }

  async function cancelar(e: EmpresaDTO) {
    setOcupada(e._id);
    setMsg(null);
    try {
      await adminPost(`/api/admin/empresas/${e._id}/cancelar-eliminacao`, {});
      setMsg({ tipo: "ok", texto: `Eliminação de «${e.nome}» cancelada.` });
      await carregar();
    } catch (err) {
      setMsg({ tipo: "erro", texto: err instanceof Error ? err.message : "Não foi possível cancelar." });
    } finally {
      setOcupada(null);
    }
  }

  function abrirAgendar(e: EmpresaDTO) {
    setAlvo(e);
    setEscrito("");
    setDias("30");
    setErroDialogo(null);
  }

  const diasNum = Number(dias);
  const diasOk = Number.isInteger(diasNum) && diasNum >= 7 && diasNum <= 365;

  async function agendar() {
    if (!alvo || !nomeConfere(escrito, alvo.nome) || !diasOk) return;
    setA(true);
    setErroDialogo(null);
    try {
      const r = await adminPost<{ mensagem?: string }>(`/api/admin/empresas/${alvo._id}/agendar-eliminacao`, {
        confirmar: escrito,
        dias: diasNum,
      });
      setMsg({ tipo: "ok", texto: r.mensagem || "Eliminação agendada." });
      setAlvo(null);
      await carregar();
    } catch (err) {
      setErroDialogo(err instanceof Error ? err.message : "Não foi possível agendar.");
    } finally {
      setA(false);
    }
  }

  return (
    <Card className="border-destructive/30 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base text-destructive">
          <ShieldX className="h-5 w-5" />
          Empresas: fim de contrato (RGPD)
          <Badge variant="outline" className="text-xs">Admin</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Primeiro exporta os dados para os devolver à empresa. Depois agenda a eliminação: a empresa fica desativada e os
          dados são apagados de forma definitiva no fim do período de segurança. Até lá podes cancelar.
        </p>
        {msg && (
          <p role="status" className={`text-sm ${msg.tipo === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {msg.texto}
          </p>
        )}
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            A carregar empresas…
          </div>
        ) : erro ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{erro}</span>
          </p>
        ) : empresas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem empresas.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {empresas.map((e) => {
              const agendada = Boolean(e.eliminacao_agendada_para);
              const propria = empresaPropriaId !== undefined && e._id === empresaPropriaId;
              const parado = ocupada === e._id;
              return (
                <li key={e._id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 break-words">{e.nome}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={e.ativa === false ? "secondary" : "success"}>{e.ativa === false ? "Desativada" : "Ativa"}</Badge>
                      {typeof e.num_propriedades === "number" && <span>{e.num_propriedades} propriedades</span>}
                      {typeof e.num_tarefas === "number" && <span>{e.num_tarefas} limpezas</span>}
                    </div>
                    {agendada && (
                      <p className="text-sm font-medium text-destructive">
                        Eliminação prevista a {dataPrevista(e.eliminacao_agendada_para)}
                      </p>
                    )}
                    {propria && (
                      <p className="text-xs text-muted-foreground">Empresa da tua própria conta: não pode ser eliminada.</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                    <Button variant="outline" className="h-11 gap-2 sm:h-9" onClick={() => exportar(e)} disabled={parado}>
                      {parado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Exportar empresa
                    </Button>
                    {agendada ? (
                      <Button variant="outline" className="h-11 gap-2 sm:h-9" onClick={() => cancelar(e)} disabled={parado}>
                        <RotateCcw className="h-4 w-4" />
                        Cancelar eliminação
                      </Button>
                    ) : (
                      !propria && (
                        <Button
                          variant="outline"
                          className="h-11 gap-2 border-destructive/50 text-destructive hover:bg-destructive/5 sm:h-9"
                          onClick={() => abrirAgendar(e)}
                          disabled={parado}
                        >
                          <Trash2 className="h-4 w-4" />
                          Agendar eliminação
                        </Button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={alvo !== null} onOpenChange={(o) => !o && !a && setAlvo(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Agendar eliminação
            </DialogTitle>
            <DialogDescription>Apaga todos os dados da empresa, de forma definitiva.</DialogDescription>
          </div>
          <DialogClose onClick={() => !a && setAlvo(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <p className="text-sm">
            Empresa: <span className="break-words font-semibold">{alvo?.nome}</span>
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>A empresa fica desativada já: ninguém entra.</li>
            <li>No fim do período de segurança, o servidor apaga tudo: utilizadores, propriedades, limpezas, arquivo, reservas, contactos de hóspedes, avisos e auditoria.</li>
            <li>Os backups cifrados expiram em 14 dias, por isso o apagamento chega aos backups nesse prazo.</li>
            <li>Podes cancelar até à data prevista. Exporta os dados antes.</li>
          </ul>
          <div className="space-y-1.5">
            <label htmlFor="dias-seguranca" className="text-sm font-medium">
              Período de segurança (dias, mínimo 7)
            </label>
            <Input id="dias-seguranca" type="number" inputMode="numeric" min={7} max={365} value={dias} onChange={(ev) => setDias(ev.target.value)} disabled={a} />
            {!diasOk && <p className="text-xs text-destructive">Indica um número inteiro entre 7 e 365.</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="nome-empresa" className="text-sm font-medium">
              Escreve o nome exato da empresa para confirmar
            </label>
            <Input id="nome-empresa" value={escrito} onChange={(ev) => setEscrito(ev.target.value)} autoComplete="off" disabled={a} placeholder={alvo?.nome} />
          </div>
          {erroDialogo && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{erroDialogo}</span>
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setAlvo(null)} disabled={a}>
            Cancelar
          </Button>
          <Button type="button" variant="destructive" onClick={agendar} disabled={a || !alvo || !nomeConfere(escrito, alvo.nome) || !diasOk}>
            {a ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />A agendar…
              </>
            ) : (
              "Agendar eliminação"
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
