/**
 * Testes dos rascunhos do staff (por empresa + utilizador, com prazo de 7 dias).
 * Corre com: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./rascunho-staff.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const S = {};
new Function("require", "exports", outputText)(require, S);

class Armazem {
  m = new Map();
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, v); }
  removeItem(k) { this.m.delete(k); }
}
const dia = 24 * 3600 * 1000;

test("N9: o rascunho é por utilizador: B não vê o de A na mesma tarefa", () => {
  const a = new Armazem();
  const A = S.donoRascunho({ id: "uA", empresa_id: "e1" });
  const B = S.donoRascunho({ id: "uB", empresa_id: "e1" });
  assert.notEqual(A, B);
  assert.equal(S.guardarRascunho(A, "t1", { observacoes: "nota da A", itens: [true, false] }, a), true);
  assert.equal(S.lerRascunho(B, "t1", 2, a), null);
  assert.deepEqual(S.lerRascunho(A, "t1", 2, a), { observacoes: "nota da A", itens: [true, false] });
  S.guardarRascunhoAvaria(A, "t1", "torneira", a);
  assert.equal(S.lerRascunhoAvaria(B, "t1", a), "");
  assert.equal(S.lerRascunhoAvaria(A, "t1", a), "torneira");
});

test("N9: a empresa também faz parte da chave", () => {
  const a = new Armazem();
  const A1 = S.donoRascunho({ id: "u", empresa_id: "e1" });
  const A2 = S.donoRascunho({ id: "u", empresa_id: "e2" });
  S.guardarRascunho(A1, "t1", { observacoes: "x", itens: [] }, a);
  assert.equal(S.lerRascunho(A2, "t1", 0, a), null);
});

test("N9: sem dono (utilizador desconhecido) não lê nem guarda", () => {
  const a = new Armazem();
  assert.equal(S.donoRascunho(null), "");
  assert.equal(S.guardarRascunho("", "t1", { observacoes: "x", itens: [] }, a), false);
  assert.equal(a.length, 0);
  assert.equal(S.lerRascunho("", "t1", 0, a), null);
});

test("N9: expira aos 7 dias (notas e avaria); dentro do prazo mantém-se", () => {
  const a = new Armazem();
  const A = "e1_uA";
  const t0 = 1_000_000;
  S.guardarRascunho(A, "t1", { observacoes: "x", itens: [] }, a, t0);
  S.guardarRascunhoAvaria(A, "t1", "avaria", a, t0);
  assert.equal(S.lerRascunho(A, "t1", 0, a, t0 + 6 * dia)?.observacoes, "x");
  assert.equal(S.lerRascunhoAvaria(A, "t1", a, t0 + 6 * dia), "avaria");
  assert.equal(S.lerRascunho(A, "t1", 0, a, t0 + 8 * dia), null);
  assert.equal(S.lerRascunhoAvaria(A, "t1", a, t0 + 8 * dia), "");
  assert.equal(a.length, 0, "as chaves expiradas são apagadas");
});

test("N9: chaves antigas (sem utilizador) são ignoradas e apagadas; as do parceiro ficam", () => {
  const a = new Armazem();
  a.setItem("a2g_rascunho_tarefa_64b0c0ffee", JSON.stringify({ observacoes: "da A", itens: [] }));
  a.setItem("a2g_rascunho_tarefa_avaria_64b0c0ffee", "texto antigo");
  a.setItem("a2g_rascunho_tarefa_reservas_e1_u1", "{}");
  S.guardarRascunho("e1_uB", "64b0c0ffee", { observacoes: "da B", itens: [] }, a, 5000);
  assert.equal(S.lerRascunho("e1_uB", "64b0c0ffee", 0, a, 5000).observacoes, "da B");
  const n = S.limparRascunhosObsoletos(a, 5000);
  assert.equal(n, 2);
  assert.equal(a.getItem("a2g_rascunho_tarefa_64b0c0ffee"), null);
  assert.equal(a.getItem("a2g_rascunho_tarefa_reservas_e1_u1"), "{}");
  assert.equal(S.lerRascunho("e1_uB", "64b0c0ffee", 0, a, 5000).observacoes, "da B");
});

test("N9: limparRascunhosObsoletos apaga as do formato novo já expiradas", () => {
  const a = new Armazem();
  S.guardarRascunho("e1_uA", "t1", { observacoes: "x", itens: [] }, a, 1000);
  S.guardarRascunho("e1_uA", "t2", { observacoes: "y", itens: [] }, a, 1000 + 7 * dia);
  S.limparRascunhosObsoletos(a, 1000 + 8 * dia);
  assert.equal(S.lerRascunho("e1_uA", "t1", 0, a, 1000 + 8 * dia), null);
  assert.equal(S.lerRascunho("e1_uA", "t2", 0, a, 1000 + 8 * dia)?.observacoes, "y");
});

test("logout explícito apaga todos os rascunhos (staff e parceiro); contar conta-os", () => {
  const a = new Armazem();
  S.guardarRascunho("e1_uA", "t1", { observacoes: "x", itens: [] }, a);
  a.setItem("a2g_rascunho_tarefa_reservas_e1_uA", "{}");
  a.setItem("outra_coisa", "1");
  assert.equal(S.contarRascunhos(a), 2);
  S.limparTodosRascunhos(a);
  assert.equal(S.contarRascunhos(a), 0);
  assert.equal(a.getItem("outra_coisa"), "1");
});

test("quota cheia: guardar devolve false sem lançar", () => {
  const cheio = new Armazem();
  cheio.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(S.guardarRascunho("e1_uA", "t1", { observacoes: "x", itens: [] }, cheio), false);
  assert.equal(S.guardarRascunhoAvaria("e1_uA", "t1", "x", cheio), false);
});

test("o rascunho sem data (dados corrompidos/antigos) conta como expirado", () => {
  const a = new Armazem();
  a.setItem("a2g_rascunho_tarefa_v2_e1_uA_t1", JSON.stringify({ observacoes: "x", itens: [] }));
  assert.equal(S.lerRascunho("e1_uA", "t1", 0, a), null);
});
