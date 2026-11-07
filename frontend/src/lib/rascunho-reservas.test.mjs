/**
 * Testes da lógica pura do rascunho das reservas do parceiro.
 * Corre com: npm test  (node --test, usa o TypeScript já instalado para transpilar).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const fonte = readFileSync(new URL("./rascunho-reservas.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exports_ = {};
new Function("require", "exports", outputText)((m) => {
  if (m === "@/lib/rascunho-staff") return { PREFIXO_RASCUNHO: "a2g_rascunho_tarefa_" };
  return require(m);
}, exports_);
const L = exports_;

const servidor = {
  check_in: "2030-06-08", check_out: "2030-06-10", hora_checkin: "", hospedes: "2",
  nome_hospede: "Maria", plataforma: "Airbnb", horario_preferido: "", observacoes: "",
  tipo_limpeza: "normal",
};

class Armazem {
  m = new Map();
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, v); }
  removeItem(k) { this.m.delete(k); }
}

test("a chave é por empresa e utilizador e usa o prefixo limpo no logout", () => {
  const k = L.chaveRascunho("u1", "e1");
  assert.ok(k.startsWith("a2g_rascunho_tarefa_"));
  assert.notEqual(k, L.chaveRascunho("u2", "e1"));
  assert.notEqual(k, L.chaveRascunho("u1", "e2"));
});

test("editar uma célula só cria rascunho; voltar ao valor do servidor desfaz a alteração", () => {
  let ed = L.aplicarCampo({}, "r1", "check_out", "2030-06-12", servidor);
  assert.deepEqual(ed.r1.campos, { check_out: "2030-06-12" });
  assert.deepEqual(ed.r1.antes, { check_out: "2030-06-10" });
  ed = L.aplicarCampo(ed, "r1", "check_out", "2030-06-10", servidor);
  assert.deepEqual(ed, {});
});

test("duas edições seguidas da mesma célula mantêm o valor ORIGINAL do servidor em 'antes'", () => {
  let ed = L.aplicarCampo({}, "r1", "nome_hospede", "Ana", servidor);
  ed = L.aplicarCampo(ed, "r1", "nome_hospede", "Ana Maria", servidor);
  assert.equal(ed.r1.antes.nome_hospede, "Maria");
  assert.equal(ed.r1.campos.nome_hospede, "Ana Maria");
});

test("contagem de pendentes = reservas editadas + reservas novas", () => {
  const ed = L.aplicarCampo({}, "r1", "hospedes", "4", servidor);
  const r = { edicoes: ed, novas: [{ tmp: "n1" }, { tmp: "n2" }] };
  assert.equal(L.contarPendentes(r), 3);
  assert.equal(L.contarPendentes({ edicoes: {}, novas: [], eliminar: {} }), 0);
});

test("o rascunho sobrevive a recarregar (guardar/ler) e fica vazio quando já não há pendentes", () => {
  const a = new Armazem();
  const nova = { tmp: "n1", propriedade_id: "p1", ...servidor };
  const r = { edicoes: L.aplicarCampo({}, "r1", "hospedes", "5", servidor), novas: [nova] };
  L.guardarRascunhoReservas("k", r, a);
  const lido = L.lerRascunhoReservas("k", a);
  assert.equal(lido.edicoes.r1.campos.hospedes, "5");
  assert.equal(lido.novas[0].tmp, "n1");
  L.guardarRascunhoReservas("k", { edicoes: {}, novas: [] }, a);
  assert.equal(a.getItem("k"), null);
});

test("rascunho corrompido ou com lixo não rebenta a página", () => {
  const a = new Armazem();
  a.setItem("k", "{isto não é json");
  assert.deepEqual(L.lerRascunhoReservas("k", a), { edicoes: {}, novas: [], eliminar: {} });
  a.setItem("k", JSON.stringify({ edicoes: { x: { campos: { hospedes: 5 } } }, novas: [{ tmp: 1 }] }));
  assert.deepEqual(L.lerRascunhoReservas("k", a), { edicoes: {}, novas: [], eliminar: {} });
});

test("validação: datas, ordem, hóspedes e propriedade (reservas novas)", () => {
  assert.equal(L.validarReserva(servidor), null);
  assert.match(L.validarReserva({ ...servidor, check_in: "" }), /Check-in/);
  assert.match(L.validarReserva({ ...servidor, check_out: "2030-02-31" }), /Check-out/);
  assert.match(L.validarReserva({ ...servidor, check_out: "2030-06-01" }), /anterior/);
  assert.match(L.validarReserva({ ...servidor, hospedes: "abc" }), /hóspedes/);
  assert.match(L.validarReserva(servidor, ""), /propriedade/);
  assert.equal(L.validarReserva(servidor, "p1"), null);
});

test("payload: só os campos alterados; hóspedes vazio vira null e texto vira número", () => {
  assert.deepEqual(L.paraPayload({ hospedes: "" }), { hospedes: null });
  assert.deepEqual(L.paraPayload({ hospedes: "6", check_out: "2030-06-12" }), { hospedes: 6, check_out: "2030-06-12" });
});

test("conflito: o servidor mudou o campo desde que comecei a editar => não se sobrescreve às cegas", () => {
  const ed = L.aplicarCampo({}, "r1", "check_out", "2030-06-12", servidor);
  const novoServidor = { ...servidor, check_out: "2030-06-11" };
  const rec = L.reconciliar(ed, { r1: novoServidor });
  assert.deepEqual(rec.conflitos, { r1: ["check_out"] });
  assert.equal(rec.edicoes.r1.campos.check_out, "2030-06-12");
});

test("sem conflito quando o servidor ficou igual ao rascunho (a alteração deixa de ser pendente)", () => {
  const ed = L.aplicarCampo({}, "r1", "check_out", "2030-06-12", servidor);
  const rec = L.reconciliar(ed, { r1: { ...servidor, check_out: "2030-06-12" } });
  assert.deepEqual(rec.edicoes, {});
  assert.deepEqual(rec.conflitos, {});
});

test("sem conflito quando o servidor não mudou; reservas apagadas descartam o rascunho", () => {
  const ed = {
    ...L.aplicarCampo({}, "r1", "hospedes", "4", servidor),
    ...L.aplicarCampo({}, "r2", "hospedes", "4", servidor),
  };
  const rec = L.reconciliar(ed, { r1: servidor });
  assert.deepEqual(rec.conflitos, {});
  assert.deepEqual(Object.keys(rec.edicoes), ["r1"]);
  assert.deepEqual(rec.desaparecidas, ["r2"]);
});

// ---- Eliminar ao Gravar (A3), validade (C4), texto (C5) ----
const vazio = () => ({ edicoes: {}, novas: [], eliminar: {} });

test("marcar para eliminar conta como pendente e anular repõe", () => {
  let r = L.marcarEliminar(vazio(), "r1", servidor);
  assert.equal(L.contarPendentes(r), 1);
  r = L.anularEliminar(r, "r1");
  assert.equal(L.contarPendentes(r), 0);
});

test("edição numa linha a eliminar não conta nem é enviada; ao anular volta a contar", () => {
  const ed = L.aplicarCampo({}, "r1", "hospedes", "5", servidor);
  let r = { ...vazio(), edicoes: ed };
  assert.equal(L.contarPendentes(r), 1);
  r = L.marcarEliminar(r, "r1", servidor);
  assert.equal(L.contarPendentes(r), 1); // só a eliminação
  r = L.anularEliminar(r, "r1");
  assert.equal(L.contarPendentes(r), 1); // a edição voltou
  assert.equal(r.edicoes.r1.campos.hospedes, "5");
});

test("o rascunho com eliminações sobrevive a guardar e recarregar", () => {
  const a = new Armazem();
  const r = L.marcarEliminar(vazio(), "r1", servidor);
  L.guardarRascunhoReservas("k", r, a, 1000);
  const lido = L.lerRascunhoReservas("k", a, 2000);
  assert.deepEqual(Object.keys(lido.eliminar), ["r1"]);
  assert.equal(lido.eliminar.r1.nome_hospede, "Maria");
});

test("reconciliar eliminações: já eliminada no servidor, alterada e intacta", () => {
  const e = { a: servidor, b: servidor, c: servidor };
  const srv = { b: { ...servidor, hospedes: "9" }, c: servidor };
  const rec = L.reconciliarEliminacoes(e, srv);
  assert.deepEqual(rec.jaEliminadas, ["a"]);
  assert.deepEqual(rec.alteradas, ["b"]);
  assert.deepEqual(Object.keys(rec.eliminar).sort(), ["b", "c"]);
});

test("rascunho com mais de 7 dias é apagado ao ler; dentro do prazo mantém-se", () => {
  const a = new Armazem();
  const r = L.marcarEliminar(vazio(), "r1", servidor);
  const t0 = 1_000_000;
  L.guardarRascunhoReservas("k", r, a, t0);
  const dia = 24 * 3600 * 1000;
  assert.equal(L.contarPendentes(L.lerRascunhoReservas("k", a, t0 + 6 * dia)), 1);
  assert.equal(L.contarPendentes(L.lerRascunhoReservas("k", a, t0 + 8 * dia)), 0);
  assert.equal(a.getItem("k"), null);
});

test("texto singular/plural das alterações por gravar", () => {
  assert.equal(L.textoPendentes(1), "1 alteração por gravar");
  assert.equal(L.textoPendentes(3), "3 alterações por gravar");
});

test("tipo de limpeza: sem tipo ou vazio vale normal", () => {
  assert.equal(L.validarReserva({ ...servidor, tipo_limpeza: "" }), null);
  assert.equal(L.validarReserva({ ...servidor, tipo_limpeza: undefined }), null);
  assert.equal(L.validarReserva({ ...servidor, tipo_limpeza: "profunda" }), null);
  assert.equal(L.tipoOuNormal(""), "normal");
  assert.equal(L.tipoOuNormal("luxo"), "normal");
  assert.equal(L.tipoOuNormal("preparacao"), "preparacao");
});

test("tipo de limpeza inválido é recusado", () => {
  assert.match(L.validarReserva({ ...servidor, tipo_limpeza: "luxo" }), /Tipo de limpeza inválido/);
});

test("intermédia e preparação não pedem data: o sistema decide o dia", () => {
  assert.equal(L.validarReserva({ ...servidor, tipo_limpeza: "intermedia" }), null);
  assert.equal(L.validarReserva({ ...servidor, tipo_limpeza: "preparacao" }), null);
  assert.equal(L.tipoPedeData, undefined);
  assert.equal(L.limitesDataLimpeza, undefined);
  assert.ok(!L.CAMPOS.includes("data_limpeza"));
});

test("payload: tipo vazio vira normal e a data da limpeza nunca vai no corpo", () => {
  assert.deepEqual(L.paraPayload({ tipo_limpeza: "" }), { tipo_limpeza: "normal" });
  assert.deepEqual(L.paraPayload({ tipo_limpeza: "intermedia", data_limpeza: "2030-06-09" }), { tipo_limpeza: "intermedia" });
  assert.deepEqual(L.paraPayload({ tipo_limpeza: "luxo" }), { tipo_limpeza: "normal" });
});

test("rascunho: o tipo guarda-se, a data da limpeza de rascunhos antigos é descartada e rascunhos sem esses campos continuam válidos", () => {
  const a = new Armazem();
  const k = L.chaveRascunho("u1", "e1");
  const nova = { ...servidor, tmp: "n1", propriedade_id: "p1", tipo_limpeza: "intermedia", data_limpeza: "2030-06-09" };
  L.guardarRascunhoReservas(k, { edicoes: {}, novas: [nova], eliminar: {} }, a);
  assert.equal(L.lerRascunhoReservas(k, a).novas[0].tipo_limpeza, "intermedia");
  assert.equal(L.lerRascunhoReservas(k, a).novas[0].data_limpeza, undefined);
  // rascunho antigo (sem os campos novos)
  const antigo = { ...servidor }; delete antigo.tipo_limpeza; delete antigo.data_limpeza;
  a.setItem(k, JSON.stringify({ guardado_em: Date.now(), edicoes: {}, eliminar: {}, novas: [{ ...antigo, tmp: "n2", propriedade_id: "p1" }] }));
  const lido = L.lerRascunhoReservas(k, a).novas[0];
  assert.equal(lido.tipo_limpeza, "");
  assert.equal(L.validarReserva(lido, "p1"), null);
});
