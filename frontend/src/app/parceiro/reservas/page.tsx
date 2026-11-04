"use client";

import { ResultadoImportacao, lerDetalheErros } from "@/components/resultado-importacao";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Table2,
  Upload,
  Download,
  Trash2,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  adminGet,
  adminPost,
  adminPut,
  adminDelete,
  type PropriedadeDTO,
} from "@/lib/api";

interface ReservaDTO {
  _id: string;
  propriedade_id: { nome: string; morada?: string } | null;
  check_in: string;
  check_out: string;
  hospedes: number | null;
  observacoes?: string;
  nome_hospede?: string | null;
  plataforma?: string | null;
  hora_checkin?: string | null;
  horario_preferido?: string | null;
  tarefa_gerada_id: { estado: string; data: string } | null;
  createdAt: string;
}

const ESTADO_LIMPEZA: Record<string, string> = {
  por_atribuir: "Por atribuir",
  nao_atribuida: "Por atribuir",
  atribuida: "Atribuída",
  em_curso: "Em curso",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

const PLATAFORMAS = ["Booking", "Airbnb", "Direto", "Vrbo", "Outra"];

const CELULA =
  "h-9 w-full bg-transparent px-2 text-sm outline-none focus:bg-primary/5 focus:ring-2 focus:ring-inset focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

const dia = (iso: string) => iso.slice(0, 10);

function somarDias(isoDia: string, n: number): string {
  const d = new Date(`${isoDia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function noites(ci: string, co: string): number {
  if (!ci || !co) return 0;
  const ms = new Date(`${co}T00:00:00Z`).getTime() - new Date(`${ci}T00:00:00Z`).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Célula editável estilo Excel: mostra sempre um input discreto; guarda ao
 * sair da célula (blur) ou com Enter; Esc repõe o valor anterior.
 */
function Celula({
  value,
  type = "text",
  options,
  disabled,
  placeholder,
  align,
  rotulo,
  onCommit,
}: {
  value: string;
  type?: "text" | "date" | "number" | "select";
  options?: string[];
  disabled?: boolean;
  placeholder?: string;
  align?: "right";
  /** Nome acessível da célula (aria-label), ex.: "Check-in, Casa Azul". */
  rotulo: string;
  onCommit: (novo: string) => Promise<void> | void;
}) {
  const [v, setV] = useState(value);
  const [erro, setErro] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);

  useEffect(() => setV(value), [value]);

  async function guardar(novo: string) {
    if (novo === value) return;
    // Datas não podem ficar vazias: repõe o valor anterior.
    if (novo === "" && type === "date") {
      setV(value);
      return;
    }
    try {
      setErro(false);
      await onCommit(novo);
    } catch {
      setErro(true);
      setV(value);
    }
  }

  const comum = {
    ref,
    disabled,
    "aria-label": rotulo,
    "aria-invalid": erro || undefined,
    title: erro ? "Não foi possível guardar" : undefined,
    className: `${CELULA} ${align === "right" ? "text-right" : ""} ${erro ? "ring-2 ring-inset ring-destructive" : ""}`,
  };

  if (type === "select") {
    return (
      <div className="relative">
      <select
        {...comum}
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          guardar(e.target.value);
        }}
      >
        <option value="">—</option>
        {(options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      {erro && <AvisoCelula />}
      </div>
    );
  }
  return (
    <div className="relative">
    <input
      {...comum}
      type={type}
      min={type === "number" ? 0 : undefined}
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => guardar(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") ref.current?.blur();
        if (e.key === "Escape") {
          setV(value);
          ref.current?.blur();
        }
      }}
    />
    {erro && <AvisoCelula />}
    </div>
  );
}

/** Aviso visível (texto, não só tooltip) quando a gravação de uma célula falha. */
function AvisoCelula() {
  return (
    <span
      role="alert"
      className="pointer-events-none absolute left-1 top-full z-10 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[11px] text-white shadow"
    >
      Não foi possível guardar
    </span>
  );
}

const NOVA_VAZIA = {
  propriedade_id: "",
  check_in: "",
  check_out: "",
  hospedes: "",
  nome_hospede: "",
  plataforma: "",
  hora_checkin: "",
  horario_preferido: "",
  observacoes: "",
};

export default function ParceiroReservasPage() {
  const [reservas, setReservas] = useState<ReservaDTO[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [nova, setNova] = useState(NOVA_VAZIA);
  const [criando, setCriando] = useState(false);
  const [novaErro, setNovaErro] = useState<string | null>(null);

  const [eliminar, setEliminar] = useState<ReservaDTO | null>(null);
  const [eliminando, setEliminando] = useState(false);

  // FIX (excel parceiro) — Estado para o modal de importação de Excel.
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importErros, setImportErros] = useState<string[]>([]);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const [resReservas, resProps] = await Promise.all([
        adminGet<{ reservas: ReservaDTO[] }>("/api/parceiro/reservas"),
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/parceiro/propriedades"),
      ]);
      setReservas(resReservas.reservas ?? []);
      const props = resProps.propriedades ?? [];
      setPropriedades(props);
      // Com uma só propriedade, a linha nova já vem preenchida.
      setNova((n) => (n.propriedade_id || props.length !== 1 ? n : { ...n, propriedade_id: props[0]._id }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /** Guarda uma alteração parcial e substitui a linha pela resposta do servidor. */
  async function atualizar(id: string, parcial: Record<string, unknown>) {
    try {
      const res = await adminPut<{ reserva: ReservaDTO }>(`/api/parceiro/reservas/${id}`, parcial);
      setReservas((rs) => rs.map((r) => (r._id === id ? res.reserva : r)));
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao guardar.");
      throw e;
    }
  }

  async function criarNova() {
    if (criando) return;
    if (!nova.propriedade_id || !nova.check_in || !nova.check_out) {
      setNovaErro("Escolhe a propriedade e preenche check-in e check-out.");
      return;
    }
    if (nova.check_out < nova.check_in) {
      setNovaErro("O check-out não pode ser anterior ao check-in.");
      return;
    }
    setCriando(true);
    setNovaErro(null);
    try {
      await adminPost("/api/parceiro/reservas", {
        ...nova,
        hospedes: nova.hospedes ? Number(nova.hospedes) : undefined,
      });
      setNova({ ...NOVA_VAZIA, propriedade_id: nova.propriedade_id });
      await carregar();
    } catch (e) {
      setNovaErro(e instanceof Error ? e.message : "Erro ao criar reserva.");
    } finally {
      setCriando(false);
    }
  }

  async function handleEliminar() {
    if (!eliminar) return;
    setEliminando(true);
    try {
      await adminDelete(`/api/parceiro/reservas/${eliminar._id}`);
      setReservas((rs) => rs.filter((r) => r._id !== eliminar._id));
      setEliminar(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao eliminar reserva.");
      setEliminar(null);
    } finally {
      setEliminando(false);
    }
  }

  function formatarData(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString("pt-PT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  }

  // FIX (excel parceiro) — Exporta as reservas do parceiro para .xlsx.
  async function handleExportarExcel() {
    try {
      const res = await fetch("/api/parceiro/reservas/exportar-excel", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Erro ao exportar Excel.");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "minhas_reservas.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao exportar Excel.");
    }
  }

  // FIX (excel parceiro) — Importa reservas de um .xlsx.
  async function handleImportarExcel() {
    if (!importFile) return;
    setImportLoading(true);
    setImportResult(null);
    setImportErros([]);
    try {
      const arrayBuffer = await importFile.arrayBuffer();
      const res = await fetch("/api/parceiro/reservas/importar-excel", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        body: arrayBuffer,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.erro || `Erro ${res.status}`);
      setImportErros(lerDetalheErros(data.detalheErros));
      setImportResult(data.message || `${data.criadas} criadas, ${data.ignoradas} ignoradas, ${data.erros} erros.`);
      await carregar();
    } catch (e) {
      setImportResult(e instanceof Error ? e.message : "Erro ao importar Excel.");
    } finally {
      setImportLoading(false);
    }
  }

  const setN = (k: keyof typeof NOVA_VAZIA) => (v: string) => setNova((n) => ({ ...n, [k]: v }));
  const enterCria = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") criarNova();
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Table2 className="h-6 w-6 text-primary" />
            Minhas Reservas
          </h1>
          <p className="text-sm text-muted-foreground">
            Clica numa célula para editar (guarda ao sair). Para uma reserva nova, preenche a linha
            do topo e carrega em Enter. Cada reserva gera uma tarefa de limpeza.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleExportarExcel}
            className="gap-2"
            title="Exporta as tuas reservas para Excel (.xlsx)."
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Exportar</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setImportOpen(true);
              setImportFile(null);
              setImportResult(null);
            }}
            disabled={importLoading}
            className="gap-2"
            title="Importa reservas em massa de um ficheiro Excel (.xlsx)."
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">Importar</span>
          </Button>
        </div>
      </div>

      {erro && (
        <Card className="sticky top-2 z-20 border-destructive/50 bg-background" role="alert">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {erro}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : propriedades.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Table2 className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Ainda não tens propriedades. Contacta o gestor para te atribuir propriedades.
          </p>
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1250px] border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Propriedade</th>
                  <th className="px-2 py-2 font-medium">Check-in</th>
                  <th className="px-2 py-2 font-medium">Hora c/in</th>
                  <th className="px-2 py-2 font-medium">Check-out</th>
                  <th className="px-2 py-2 text-right font-medium">Noites</th>
                  <th className="px-2 py-2 text-right font-medium">Hósp.</th>
                  <th className="px-2 py-2 font-medium">Hóspede</th>
                  <th className="px-2 py-2 font-medium">Plataforma</th>
                  <th className="px-2 py-2 font-medium">Horário pref. limpeza</th>
                  <th className="px-2 py-2 font-medium">Notas</th>
                  <th className="px-2 py-2 font-medium">Limpeza</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {/* Linha nova (vazia) */}
                <tr className="border-b bg-primary/5" onKeyDown={enterCria}>
                  <td className="p-0">
                    <select
                      value={nova.propriedade_id}
                      onChange={(e) => setN("propriedade_id")(e.target.value)}
                      className={CELULA}
                    >
                      <option value="">Propriedade…</option>
                      {propriedades.map((p) => (
                        <option key={p._id} value={p._id}>{p.nome}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-0">
                    <input type="date" value={nova.check_in} className={CELULA}
                      onChange={(e) => setNova((n) => ({ ...n, check_in: e.target.value, check_out: n.check_out || e.target.value }))} />
                  </td>
                  <td className="p-0">
                    <input value={nova.hora_checkin} onChange={(e) => setN("hora_checkin")(e.target.value)} placeholder="18:00" className={CELULA} />
                  </td>
                  <td className="p-0">
                    <input type="date" value={nova.check_out} onChange={(e) => setN("check_out")(e.target.value)} className={CELULA} />
                  </td>
                  <td className="px-2 text-right text-muted-foreground">{noites(nova.check_in, nova.check_out) || ""}</td>
                  <td className="p-0">
                    <input type="number" min={0} value={nova.hospedes} onChange={(e) => setN("hospedes")(e.target.value)} className={`${CELULA} text-right`} />
                  </td>
                  <td className="p-0">
                    <input value={nova.nome_hospede} onChange={(e) => setN("nome_hospede")(e.target.value)} className={CELULA} />
                  </td>
                  <td className="p-0">
                    <select value={nova.plataforma} onChange={(e) => setN("plataforma")(e.target.value)} className={CELULA}>
                      <option value="">—</option>
                      {PLATAFORMAS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="p-0">
                    <input value={nova.horario_preferido} onChange={(e) => setN("horario_preferido")(e.target.value)} placeholder="11h - 14h" className={CELULA} />
                  </td>
                  <td className="p-0">
                    <input value={nova.observacoes} onChange={(e) => setN("observacoes")(e.target.value)} className={CELULA} />
                  </td>
                  <td className="px-2 text-xs text-muted-foreground">nova</td>
                  <td className="px-1 text-right">
                    <Button size="sm" onClick={criarNova} disabled={criando} title="Adicionar reserva (Enter)">
                      {criando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </Button>
                  </td>
                </tr>
                {novaErro && (
                  <tr>
                    <td colSpan={12} className="px-3 py-1 text-xs text-destructive">{novaErro}</td>
                  </tr>
                )}

                {reservas.map((r) => {
                  const estado = r.tarefa_gerada_id?.estado ?? null;
                  const bloqueada = estado === "em_curso" || estado === "concluida";
                  const ci = dia(r.check_in);
                  const co = dia(r.check_out);
                  return (
                    <tr key={r._id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="whitespace-nowrap px-2 py-1 font-medium">{r.propriedade_id?.nome ?? "—"}</td>
                      <td className="p-0">
                        <Celula type="date" value={ci} rotulo={`Check-in, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => v ? atualizar(r._id, { check_in: v }) : undefined} />
                      </td>
                      <td className="p-0">
                        <Celula value={r.hora_checkin ?? ""} rotulo={`Hora de check-in, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { hora_checkin: v })} />
                      </td>
                      <td className="p-0">
                        <Celula type="date" value={co} rotulo={`Check-out, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => v ? atualizar(r._id, { check_out: v }) : undefined} />
                      </td>
                      <td className="w-16 p-0">
                        <Celula
                          type="number"
                          align="right"
                          rotulo={`Noites, ${r.propriedade_id?.nome ?? "reserva"}`}
                          value={String(noites(ci, co))}
                          disabled={bloqueada}
                          onCommit={(v) => v !== "" ? atualizar(r._id, { check_out: somarDias(ci, Number(v)) }) : undefined}
                        />
                      </td>
                      <td className="w-16 p-0">
                        <Celula type="number" align="right" value={r.hospedes != null ? String(r.hospedes) : ""} rotulo={`Hóspedes, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { hospedes: v === "" ? null : Number(v) })} />
                      </td>
                      <td className="p-0">
                        <Celula value={r.nome_hospede ?? ""} rotulo={`Nome do hóspede, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { nome_hospede: v })} />
                      </td>
                      <td className="p-0">
                        <Celula type="select" options={PLATAFORMAS} rotulo={`Plataforma, ${r.propriedade_id?.nome ?? "reserva"}`} value={r.plataforma ?? ""} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { plataforma: v })} />
                      </td>
                      <td className="p-0">
                        <Celula value={r.horario_preferido ?? ""} rotulo={`Horário preferido, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { horario_preferido: v })} />
                      </td>
                      <td className="p-0">
                        <Celula value={r.observacoes ?? ""} rotulo={`Observações, ${r.propriedade_id?.nome ?? "reserva"}`} disabled={bloqueada} onCommit={(v) => atualizar(r._id, { observacoes: v })} />
                      </td>
                      <td className="whitespace-nowrap px-2">
                        {estado ? (
                          <Badge
                            variant={
                              estado === "concluida"
                                ? "success"
                                : estado === "atribuida"
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {ESTADO_LIMPEZA[estado] ?? estado}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-1 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEliminar(r)}
                          disabled={bloqueada}
                          title={bloqueada ? "A limpeza já começou ou foi concluída." : "Eliminar reserva"}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {reservas.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Sem reservas. Preenche a linha do topo para adicionar a primeira.
            </p>
          )}
        </Card>
      )}

      {/* Confirmação de eliminação */}
      <Dialog open={!!eliminar} onOpenChange={(o) => !o && !eliminando && setEliminar(null)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Eliminar reserva
            </DialogTitle>
            <DialogDescription>
              {eliminar
                ? `Eliminar a reserva de ${eliminar.propriedade_id?.nome ?? "propriedade"} (${formatarData(eliminar.check_in)} → ${formatarData(eliminar.check_out)})? A limpeza associada será cancelada.`
                : ""}
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !eliminando && setEliminar(null)} />
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEliminar(null)} disabled={eliminando}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={handleEliminar} disabled={eliminando}>
            {eliminando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Eliminar
          </Button>
        </DialogFooter>
      </Dialog>

      {/* FIX (excel parceiro) — Modal de importação de Excel. */}
      <Dialog open={importOpen} onOpenChange={(o) => !o && !importLoading && setImportOpen(o)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-primary" />
              Importar Reservas (Excel)
            </DialogTitle>
            <DialogDescription>
              Carrega um ficheiro .xlsx com as colunas: Propriedade, Check-in,
              Check-out, Hóspedes (opcional). O sistema só aceita propriedades
              que te estão atribuídas.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !importLoading && setImportOpen(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="importar-ficheiro-excel" className="text-sm font-medium">Ficheiro Excel (.xlsx)</label>
            <input
              id="importar-ficheiro-excel"
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setImportFile(f ?? null);
                setImportResult(null);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50"
            />
            {importFile && (
              <p className="text-xs text-muted-foreground">
                Ficheiro selecionado: {importFile.name} ({(importFile.size / 1024).toFixed(0)} KB)
              </p>
            )}
          </div>
          {importResult && (
            <ResultadoImportacao resumo={importResult} detalheErros={importErros} />
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setImportOpen(false)}
            disabled={importLoading}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleImportarExcel}
            disabled={!importFile || importLoading}
          >
            {importLoading ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A importar…</>
            ) : (
              <><Upload className="mr-2 h-4 w-4" />Importar</>
            )}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
