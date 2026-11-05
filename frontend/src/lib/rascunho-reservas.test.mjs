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
  assert.equal(L.contarPendentes({ edicoes: {}, novas: [] }), 0);
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
  assert.deepEqual(L.lerRascunhoReservas("k", a), { edicoes: {}, novas: [] });
  a.setItem("k", JSON.stringify({ edicoes: { x: { campos: { hospedes: 5 } } }, novas: [{ tmp: 1 }] }));
  assert.deepEqual(L.lerRascunhoReservas("k", a), { edicoes: {}, novas: [] });
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
