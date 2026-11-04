"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarPlus,
  Loader2,
  AlertCircle,
  Building2,
  Upload,
  Download,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export default function ParceiroReservasPage() {
  const [reservas, setReservas] = useState<ReservaDTO[]>([]);
  const [propriedades, setPropriedades] = useState<PropriedadeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [mostrarForm, setMostrarForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErro, setFormErro] = useState<string | null>(null);
  const FORM_VAZIO = {
    propriedade_id: "",
    check_in: "",
    check_out: "",
    hospedes: "",
    observacoes: "",
    nome_hospede: "",
    plataforma: "",
    hora_checkin: "",
    horario_preferido: "",
  };
  const [form, setForm] = useState(FORM_VAZIO);
  // Id da reserva em edição (null = nova reserva) e da reserva a eliminar.
  const [editId, setEditId] = useState<string | null>(null);
  const [eliminar, setEliminar] = useState<ReservaDTO | null>(null);
  const [eliminando, setEliminando] = useState(false);

  // FIX (excel parceiro) — Estado para o modal de importação de Excel.
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const [resReservas, resProps] = await Promise.all([
        adminGet<{ reservas: ReservaDTO[] }>("/api/parceiro/reservas"),
        adminGet<{ propriedades: PropriedadeDTO[] }>("/api/parceiro/propriedades"),
      ]);
      setReservas(resReservas.reservas ?? []);
      setPropriedades(resProps.propriedades ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function abrirNova() {
    setEditId(null);
    setForm(FORM_VAZIO);
    setFormErro(null);
    setMostrarForm(true);
  }

  function abrirEditar(r: ReservaDTO) {
    setEditId(r._id);
    setForm({
      propriedade_id: "",
      check_in: r.check_in.slice(0, 10),
      check_out: r.check_out.slice(0, 10),
      hospedes: r.hospedes != null ? String(r.hospedes) : "",
      observacoes: r.observacoes ?? "",
      nome_hospede: r.nome_hospede ?? "",
      plataforma: r.plataforma ?? "",
      hora_checkin: r.hora_checkin ?? "",
      horario_preferido: r.horario_preferido ?? "",
    });
    setFormErro(null);
    setMostrarForm(true);
  }

  async function handleGuardar() {
    if (!form.check_in || !form.check_out || (!editId && !form.propriedade_id)) {
      setFormErro("Propriedade, Check-in e Check-out são obrigatórios.");
      return;
    }
    if (form.check_out < form.check_in) {
      setFormErro("O check-out não pode ser anterior ao check-in.");
      return;
    }
    setSubmitting(true);
    setFormErro(null);
    try {
      const corpo = {
        check_in: form.check_in,
        check_out: form.check_out,
        hospedes: form.hospedes ? Number(form.hospedes) : undefined,
        observacoes: form.observacoes,
        nome_hospede: form.nome_hospede,
        plataforma: form.plataforma,
        hora_checkin: form.hora_checkin,
        horario_preferido: form.horario_preferido,
      };
      if (editId) {
        await adminPut(`/api/parceiro/reservas/${editId}`, corpo);
      } else {
        await adminPost("/api/parceiro/reservas", {
          ...corpo,
          propriedade_id: form.propriedade_id,
        });
      }
      setMostrarForm(false);
      setEditId(null);
      setForm(FORM_VAZIO);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof Error ? e.message : "Erro ao guardar reserva.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEliminar() {
    if (!eliminar) return;
    setEliminando(true);
    try {
      await adminDelete(`/api/parceiro/reservas/${eliminar._id}`);
      setEliminar(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao eliminar reserva.");
      setEliminar(null);
    } finally {
      setEliminando(false);
    }
  }

  function noites(r: ReservaDTO): number {
    const ms = new Date(r.check_out).getTime() - new Date(r.check_in).getTime();
    return Math.max(0, Math.round(ms / 86400000));
  }

  const ESTADO_LIMPEZA: Record<string, string> = {
    por_atribuir: "Por atribuir",
    nao_atribuida: "Por atribuir",
    atribuida: "Atribuída",
    em_curso: "Em curso",
    concluida: "Concluída",
    cancelada: "Cancelada",
  };

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
      setImportResult(data.message || `${data.criadas} criadas, ${data.ignoradas} ignoradas, ${data.erros} erros.`);
      await carregar();
    } catch (e) {
      setImportResult(e instanceof Error ? e.message : "Erro ao importar Excel.");
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarPlus className="h-6 w-6 text-primary" />
            Minhas Reservas
          </h1>
          <p className="text-sm text-muted-foreground">
            Gere as tuas reservas. Cada reserva gera automaticamente uma tarefa de limpeza.
          </p>
        </div>
        <Button
          onClick={abrirNova}
          disabled={propriedades.length === 0}
        >
          <CalendarPlus className="h-4 w-4" />
          Nova Reserva
        </Button>
        {/* FIX (excel parceiro) — Botões de importar/exportar Excel. */}
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

      {erro && (
        <Card className="border-destructive/50">
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
      ) : reservas.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <CalendarPlus className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {propriedades.length === 0
              ? "Ainda não tens propriedades. Contacta o gestor para te atribuir propriedades."
              : "Sem reservas. Cria a tua primeira reserva."}
          </p>
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Propriedade</th>
                  <th className="px-3 py-2 font-medium">Check-in</th>
                  <th className="px-3 py-2 font-medium">Hora c/in</th>
                  <th className="px-3 py-2 font-medium">Check-out</th>
                  <th className="px-3 py-2 text-right font-medium">Noites</th>
                  <th className="px-3 py-2 text-right font-medium">Hósp.</th>
                  <th className="px-3 py-2 font-medium">Hóspede</th>
                  <th className="px-3 py-2 font-medium">Plataforma</th>
                  <th className="px-3 py-2 font-medium">Horário pref. limpeza</th>
                  <th className="px-3 py-2 font-medium">Notas</th>
                  <th className="px-3 py-2 font-medium">Limpeza</th>
                  <th className="px-3 py-2 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {reservas.map((r) => {
                  const estado = r.tarefa_gerada_id?.estado ?? null;
                  const bloqueada = estado === "em_curso" || estado === "concluida";
                  return (
                    <tr key={r._id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 text-primary" />
                          {r.propriedade_id?.nome ?? "—"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{formatarData(r.check_in)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.hora_checkin || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatarData(r.check_out)}</td>
                      <td className="px-3 py-2 text-right">{noites(r)}</td>
                      <td className="px-3 py-2 text-right">{r.hospedes ?? "—"}</td>
                      <td className="px-3 py-2">{r.nome_hospede || "—"}</td>
                      <td className="px-3 py-2">{r.plataforma || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.horario_preferido || "—"}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground" title={r.observacoes}>
                        {r.observacoes || "—"}
                      </td>
                      <td className="px-3 py-2">
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
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => abrirEditar(r)}
                          disabled={bloqueada}
                          title={bloqueada ? "A limpeza já começou ou foi concluída." : "Editar reserva"}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
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
        </Card>
      )}

      {/* Modal de Nova Reserva */}
      <Dialog open={mostrarForm} onOpenChange={(o) => !o && !submitting && setMostrarForm(false)}>
        <DialogHeader>
          <div>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="h-5 w-5 text-primary" />
              {editId ? "Editar Reserva" : "Nova Reserva"}
            </DialogTitle>
            <DialogDescription>
              A reserva gera automaticamente uma tarefa de limpeza para o dia de check-out.
              A hora da limpeza é definida pela equipa; o horário preferido é só uma indicação.
            </DialogDescription>
          </div>
          <DialogClose onClick={() => !submitting && setMostrarForm(false)} />
        </DialogHeader>
        <DialogContent className="space-y-4">
          {!editId && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Propriedade</label>
            <select
              value={form.propriedade_id}
              onChange={(e) => setForm((f) => ({ ...f, propriedade_id: e.target.value }))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Selecionar…</option>
              {propriedades.map((p) => (
                <option key={p._id} value={p._id}>{p.nome}</option>
              ))}
            </select>
          </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Check-in</label>
              <Input type="date" value={form.check_in} onChange={(e) => setForm((f) => ({ ...f, check_in: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Check-out</label>
              <Input type="date" value={form.check_out} onChange={(e) => setForm((f) => ({ ...f, check_out: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Nome do hóspede</label>
              <Input value={form.nome_hospede} onChange={(e) => setForm((f) => ({ ...f, nome_hospede: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Plataforma</label>
              <select
                value={form.plataforma}
                onChange={(e) => setForm((f) => ({ ...f, plataforma: e.target.value }))}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">—</option>
                <option value="Booking">Booking</option>
                <option value="Airbnb">Airbnb</option>
                <option value="Direto">Direto</option>
                <option value="Vrbo">Vrbo</option>
                <option value="Outra">Outra</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Hora de check-in</label>
              <Input value={form.hora_checkin} onChange={(e) => setForm((f) => ({ ...f, hora_checkin: e.target.value }))} placeholder="ex.: 18:00" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Horário preferido p/ limpeza</label>
              <Input value={form.horario_preferido} onChange={(e) => setForm((f) => ({ ...f, horario_preferido: e.target.value }))} placeholder="ex.: 11h - 14h" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Hóspedes (opcional)</label>
            <Input
              type="number"
              min={1}
              value={form.hospedes}
              onChange={(e) => setForm((f) => ({ ...f, hospedes: e.target.value }))}
              placeholder="Usa a capacidade da propriedade se vazio"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Observações (opcional)</label>
            <Input
              type="text"
              value={form.observacoes}
              onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))}
              placeholder="Notas para a equipa de limpeza"
            />
          </div>
          {formErro && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formErro}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={() => setMostrarForm(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleGuardar} disabled={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarPlus className="mr-2 h-4 w-4" />}
            {editId ? "Guardar Alterações" : "Criar Reserva"}
          </Button>
        </DialogFooter>
      </Dialog>

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
            <label className="text-sm font-medium">Ficheiro Excel (.xlsx)</label>
            <input
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
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <span className="font-medium">Resultado: </span>
              {importResult}
            </div>
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
