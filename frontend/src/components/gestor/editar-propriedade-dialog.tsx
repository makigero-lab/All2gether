"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronRight, Loader2, Lock, MapPin, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** Valores do formulário «Editar propriedade» (tudo em texto, como nos inputs). */
export interface EditarPropriedadeForm {
  nome: string;
  smoobu_id: string;
  morada: string;
  tempo_limpeza_minutos: string;
  checklist: string;
  tipos: Record<string, { tempo: string; checklist: string }>;
  modelo_checklist_id: string;
  observacoes: string;
  morada_rua: string;
  morada_codigo_postal: string;
  morada_cidade: string;
  parceiro_id: string;
  fornecedor_id: string;
  equipa_preferencial: string[];
  staff_necessario: string;
  capacidade_hospedes: string;
  /** Dias fixos de limpeza (0 = domingo ... 6 = sábado). */
  dias_fixos_limpeza: number[];
}

interface Opcao { _id: string; nome: string }

const DIAS = [
  { dia: 1, label: "Seg" },
  { dia: 2, label: "Ter" },
  { dia: 3, label: "Qua" },
  { dia: 4, label: "Qui" },
  { dia: 5, label: "Sex" },
  { dia: 6, label: "Sáb" },
  { dia: 0, label: "Dom" },
];

const CAMPO = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const AREA = "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SEPARADOR =
  "relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-brand-text data-[state=active]:shadow-none";

const itens = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).length;

/**
 * «Editar propriedade» (opção A): separadores Essencial / Operação / Limpezas, ID Smoobu como chip só de
 * leitura, morada com estado «Localizada», morada estruturada e notas internas recolhidas, tempo base,
 * pessoas e capacidade na mesma linha, equipa preferencial em chips («exclusiva»), dias fixos de limpeza
 * (também ao editar) e tabela de tipos com tempo e checklist que herdam da casa. Ecrã inteiro no telemóvel.
 * Nada é guardado antes de «Guardar alterações».
 */
export function EditarPropriedadeDialog({
  aberto,
  nomeAtual,
  ativa,
  localizada,
  form,
  setForm,
  parceiros,
  fornecedores,
  staff,
  modelos,
  modelosA,
  onModeloChange,
  tiposConfig,
  moradaAviso,
  onMoradaMudou,
  erro,
  a,
  onSubmit,
  onClose,
}: {
  aberto: boolean;
  nomeAtual: string;
  ativa: boolean;
  /** Coordenadas guardadas (morada localizada) ou null. */
  localizada: { lat: number; lng: number } | null;
  form: EditarPropriedadeForm;
  setForm: (fn: (f: EditarPropriedadeForm) => EditarPropriedadeForm) => void;
  parceiros: Opcao[];
  fornecedores: Opcao[];
  staff: { _id: string; nome: string; exclusivo_preferenciais?: boolean }[];
  modelos: Opcao[];
  modelosA: boolean;
  onModeloChange: (id: string) => void;
  tiposConfig: readonly { id: string; rotulo: string }[];
  moradaAviso: string | null;
  onMoradaMudou: () => void;
  erro: string | null;
  a: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  const [separador, setSeparador] = useState("essencial");
  const [estruturadaAberta, setEstruturadaAberta] = useState(false);
  const [notasAbertas, setNotasAbertas] = useState(false);
  const [editarTipo, setEditarTipo] = useState<string | null>(null);

  const linhasTipo = [{ id: "normal", rotulo: "Normal" }, ...tiposConfig];
  const upd = (patch: Partial<EditarPropriedadeForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onClose()} ecraInteiroNoTelemovel>
      <form onSubmit={onSubmit} className="flex max-h-full flex-1 flex-col">
        <div className="flex items-center gap-2 px-5 pb-0 pt-4 pr-16">
          <DialogTitle className="truncate">{form.nome || nomeAtual}</DialogTitle>
          {form.smoobu_id && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground" title="O ID do Smoobu não é editável">
              <Lock className="h-3 w-3" aria-hidden="true" />
              Smoobu {form.smoobu_id}
            </span>
          )}
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", ativa ? "bg-status-conc-bg text-status-conc" : "bg-status-canc-bg text-status-canc")}>
            {ativa ? "Ativa" : "Inativa"}
          </span>
          <DialogClose onClick={onClose} />
        </div>

        <Tabs value={separador} onValueChange={setSeparador} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent px-4 pt-2">
            <TabsTrigger value="essencial" className={SEPARADOR}>Essencial</TabsTrigger>
            <TabsTrigger value="operacao" className={SEPARADOR}>Operação</TabsTrigger>
            <TabsTrigger value="limpezas" className={SEPARADOR}>Limpezas</TabsTrigger>
          </TabsList>

          <DialogContent className="min-h-0 flex-1 overflow-y-auto">
            {/* ── Essencial ── */}
            <TabsContent value="essencial" className="mt-0 space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="edit-nome" className="text-xs font-medium text-muted-foreground">Nome da propriedade</label>
                <Input id="edit-nome" value={form.nome} onChange={(e) => upd({ nome: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="edit-morada" className="text-xs font-medium text-muted-foreground">Morada</label>
                  {localizada && !moradaAviso && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-status-conc">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      Localizada ({localizada.lat.toFixed(4)}, {localizada.lng.toFixed(4)})
                    </span>
                  )}
                </div>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id="edit-morada"
                    className="pl-9"
                    value={form.morada}
                    onChange={(e) => {
                      upd({ morada: e.target.value });
                      onMoradaMudou();
                    }}
                    required
                  />
                </div>
                {moradaAviso && (
                  <p className="flex items-start gap-1.5 text-xs text-status-porat">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{moradaAviso}</span>
                  </p>
                )}
                <button type="button" className="flex min-h-9 items-center gap-1 text-sm font-medium text-brand-text" aria-expanded={estruturadaAberta} onClick={() => setEstruturadaAberta((v) => !v)}>
                  <ChevronRight className={cn("h-4 w-4 transition-transform", estruturadaAberta && "rotate-90")} aria-hidden="true" />
                  Morada estruturada
                  <span className="hidden font-normal text-muted-foreground sm:inline">· opcional, melhora a localização</span>
                </button>
                {estruturadaAberta && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input aria-label="Rua, número, andar" placeholder="Rua, número, andar" value={form.morada_rua} onChange={(e) => upd({ morada_rua: e.target.value })} />
                    <Input aria-label="Código postal" placeholder="Código postal (1200-001)" value={form.morada_codigo_postal} onChange={(e) => upd({ morada_codigo_postal: e.target.value })} />
                    <Input aria-label="Cidade" placeholder="Cidade" value={form.morada_cidade} onChange={(e) => upd({ morada_cidade: e.target.value })} />
                    <p className="text-xs text-muted-foreground sm:col-span-3">Se preencheres a rua, esta morada substitui a «Morada» acima para localizar a casa.</p>
                  </div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="edit-parceiro" className="text-xs font-medium text-muted-foreground">Proprietário</label>
                  <select id="edit-parceiro" value={form.parceiro_id} onChange={(e) => upd({ parceiro_id: e.target.value })} className={CAMPO}>
                    <option value="">Nenhum (propriedade All2gether)</option>
                    {parceiros.map((p) => <option key={p._id} value={p._id}>{p.nome}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-fornecedor" className="text-xs font-medium text-muted-foreground">Lavandaria</label>
                  <select id="edit-fornecedor" value={form.fornecedor_id} onChange={(e) => upd({ fornecedor_id: e.target.value })} className={CAMPO}>
                    <option value="">Nenhuma (sem lavandaria)</option>
                    {fornecedores.map((f) => <option key={f._id} value={f._id}>{f.nome}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <button type="button" className="flex min-h-9 items-center gap-1 text-sm font-medium text-brand-text" aria-expanded={notasAbertas || form.observacoes !== ""} onClick={() => setNotasAbertas((v) => !v)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Notas internas
                  <span className="hidden font-normal text-muted-foreground sm:inline">· só o gestor vê</span>
                </button>
                {(notasAbertas || form.observacoes !== "") && (
                  <textarea id="edit-observacoes" aria-label="Notas internas" value={form.observacoes} onChange={(e) => upd({ observacoes: e.target.value })} rows={3} placeholder="Notas internas (frequência, instruções especiais...)" className={cn(AREA, "mt-1")} />
                )}
              </div>
            </TabsContent>

            {/* ── Operação ── */}
            <TabsContent value="operacao" className="mt-0 space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label htmlFor="edit-tempo" className="text-xs font-medium text-muted-foreground">Tempo base (min)</label>
                  <Input id="edit-tempo" type="number" min={0} value={form.tempo_limpeza_minutos} onChange={(e) => upd({ tempo_limpeza_minutos: e.target.value })} required />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-staff-necessario" className="text-xs font-medium text-muted-foreground">Pessoas necessárias</label>
                  <Input id="edit-staff-necessario" type="number" min={1} max={10} value={form.staff_necessario} onChange={(e) => upd({ staff_necessario: e.target.value })} placeholder="1" />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-capacidade" className="text-xs font-medium text-muted-foreground">Capacidade (hóspedes)</label>
                  <Input id="edit-capacidade" type="number" min={0} value={form.capacidade_hospedes} onChange={(e) => upd({ capacidade_hospedes: e.target.value })} placeholder="Ex.: 4" />
                </div>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">Com mais de 1 pessoa, o sistema atribui uma equipa. A capacidade serve de recurso quando o Smoobu não envia o nº de hóspedes.</p>

              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-muted-foreground">Equipa preferencial</legend>
                {staff.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">Sem equipa ativa disponível.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {staff.map((s) => {
                      const marcado = form.equipa_preferencial.includes(s._id);
                      return (
                        <label key={s._id} className={cn("flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors", marcado ? "border-primary bg-brand-soft text-brand-text" : "border-input text-muted-foreground hover:bg-muted/50")}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={marcado}
                            onChange={(e) => upd({ equipa_preferencial: e.target.checked ? [...form.equipa_preferencial, s._id] : form.equipa_preferencial.filter((id) => id !== s._id) })}
                          />
                          {marcado && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                          {s.nome}
                          {s.exclusivo_preferenciais && <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium" title="Só recebe limpezas das casas onde consta como preferencial">exclusiva</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Quem é «exclusiva» só recebe limpezas das casas onde está nesta lista.</p>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-muted-foreground">Dias fixos de limpeza</legend>
                <div className="flex flex-wrap gap-2">
                  {DIAS.map(({ dia, label }) => {
                    const marcado = form.dias_fixos_limpeza.includes(dia);
                    return (
                      <label key={dia} className={cn("flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1 text-sm transition-colors", marcado ? "border-primary bg-brand-soft text-brand-text" : "border-input text-muted-foreground hover:bg-muted/50")}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={marcado}
                          onChange={(e) => upd({ dias_fixos_limpeza: e.target.checked ? [...form.dias_fixos_limpeza, dia].sort() : form.dias_fixos_limpeza.filter((d) => d !== dia) })}
                        />
                        {marcado && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                        {label}
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">Em cada um destes dias o sistema cria a limpeza de madrugada (rotina fixa), além das reservas.</p>
              </fieldset>
            </TabsContent>

            {/* ── Limpezas ── */}
            <TabsContent value="limpezas" className="mt-0 space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="edit-modelo-checklist" className="text-xs font-medium text-muted-foreground">Modelo de checklist</label>
                <select id="edit-modelo-checklist" value={form.modelo_checklist_id} onChange={(e) => onModeloChange(e.target.value)} disabled={modelosA} className={CAMPO}>
                  <option value="">Nenhum (usar a checklist simples da casa)</option>
                  {modelos.map((m) => <option key={m._id} value={m._id}>{m.nome}</option>)}
                </select>
                {modelosA && <p className="text-xs text-muted-foreground">A carregar modelos…</p>}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Tempo e checklist por tipo de limpeza</p>
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-semibold">Tipo</th>
                        <th className="px-3 py-2 font-semibold">Tempo</th>
                        <th className="px-3 py-2 font-semibold">Checklist</th>
                        <th className="w-14 px-3 py-2"><span className="sr-only">Editar</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {linhasTipo.map(({ id, rotulo }) => {
                        const normal = id === "normal";
                        const t = form.tipos[id];
                        const lista = normal ? form.checklist : t?.checklist ?? "";
                        const n = itens(lista);
                        const resumo = normal
                          ? n > 0 ? `Checklist da casa · ${n} itens` : form.modelo_checklist_id ? "Modelo da casa" : "Sem checklist"
                          : n > 0 ? `Personalizada · ${n} itens` : "Herda a da casa";
                        return (
                          <tr key={id} className="border-b last:border-b-0 align-top">
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center gap-2">
                                <span className="tipo-marca" data-tipo={id} aria-hidden="true" />
                                {rotulo}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              {normal ? (
                                <span className="text-muted-foreground">{form.tempo_limpeza_minutos || "—"} min</span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5">
                                  <input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={480}
                                    aria-label={`Tempo da limpeza ${rotulo.toLowerCase()} (minutos)`}
                                    value={t?.tempo ?? ""}
                                    placeholder={`= base ${form.tempo_limpeza_minutos}`}
                                    onChange={(e) => setForm((f) => ({ ...f, tipos: { ...f.tipos, [id]: { ...f.tipos[id], tempo: e.target.value } } }))}
                                    className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm placeholder:italic"
                                  />
                                  <span className="text-xs text-muted-foreground">min</span>
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{resumo}</td>
                            <td className="px-3 py-2 text-right">
                              <button type="button" className="min-h-9 text-sm font-medium text-brand-text" aria-expanded={editarTipo === id} aria-label={`Editar a checklist ${rotulo.toLowerCase()}`} onClick={() => setEditarTipo((v) => (v === id ? null : id))}>
                                Editar
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {editarTipo && (
                  <div className="space-y-1">
                    <label htmlFor="edit-checklist-tipo" className="text-xs font-medium text-muted-foreground">
                      Checklist {editarTipo === "normal" ? "da casa" : `da limpeza ${linhasTipo.find((l) => l.id === editarTipo)?.rotulo.toLowerCase()}`} (um item por linha)
                    </label>
                    <textarea
                      id="edit-checklist-tipo"
                      rows={6}
                      className={AREA}
                      value={editarTipo === "normal" ? form.checklist : form.tipos[editarTipo]?.checklist ?? ""}
                      placeholder={editarTipo === "normal" ? "Verificar toalhas\nEsvaziar lixo\nTrocar roupa de cama" : "Checklist própria (um item por linha); vazio = a da casa"}
                      onChange={(e) => (editarTipo === "normal"
                        ? upd({ checklist: e.target.value })
                        : setForm((f) => ({ ...f, tipos: { ...f.tipos, [editarTipo]: { ...f.tipos[editarTipo], checklist: e.target.value } } })))}
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Em branco, o tipo herda o tempo base e a checklist da casa. O tipo não muda preços.</p>
              </div>
            </TabsContent>
            {erro && <p role="alert" className="mt-3 text-sm text-destructive">{erro}</p>}
          </DialogContent>
        </Tabs>

        <DialogFooter>
          <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">Alterações guardadas só ao carregar em Guardar</span>
          <Button type="button" variant="outline" onClick={onClose} disabled={a}>Cancelar</Button>
          <Button
            type="submit"
            disabled={a}
            variant={moradaAviso ? "outline" : "default"}
            className={moradaAviso ? "border-status-porat/50 text-status-porat hover:bg-status-porat-bg" : ""}
          >
            {a ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />A guardar…</>) : moradaAviso ? "Confirmar morada inválida" : "Guardar alterações"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
