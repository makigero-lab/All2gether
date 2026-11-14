import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./filtro-dias-rapido.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const compilar = (nome) => {
  const src = readFileSync(new URL(nome, import.meta.url), "utf8");
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
};
const reservas = {};
new Function("exports", compilar("./reservas-externas.ts"))(reservas);
const f = {};
new Function("exports", "require", outputText)(f, () => reservas);
f.hojeLisboaISO = reservas.hojeLisboaISO;

test("hoje em Lisboa: 23:30 UTC de verao ja e o dia seguinte", () => {
  assert.equal(f.hojeLisboaISO(new Date("2026-07-14T23:30:00Z")), "2026-07-15");
  assert.equal(f.hojeLisboaISO(new Date("2026-11-14T23:30:00Z")), "2026-11-14");
});

test("dias do filtro: nenhum, so hoje, so amanha, os dois, virada de mes", () => {
  const agora = new Date("2026-11-30T12:00:00Z");
  assert.deepEqual(f.diasDoFiltro([], agora), []);
  assert.deepEqual(f.diasDoFiltro(["hoje"], agora), ["2026-11-30"]);
  assert.deepEqual(f.diasDoFiltro(["amanha"], agora), ["2026-12-01"]);
  assert.deepEqual(f.diasDoFiltro(new Set(["hoje", "amanha"]), agora), ["2026-11-30", "2026-12-01"]);
});

test("passaFiltroRapido: sem filtro passa tudo; com filtro so os dias; lixo nao passa", () => {
  assert.equal(f.passaFiltroRapido("2026-11-14T10:00:00.000Z", []), true);
  assert.equal(f.passaFiltroRapido(undefined, []), true);
  assert.equal(f.passaFiltroRapido("2026-11-14T10:00:00.000Z", ["2026-11-14"]), true);
  assert.equal(f.passaFiltroRapido("2026-11-15T10:00:00.000Z", ["2026-11-14"]), false);
  assert.equal(f.passaFiltroRapido(null, ["2026-11-14"]), false);
  assert.equal(f.passaFiltroRapido("lixo", ["2026-11-14"]), false);
});

test("escolha guardada: sem localStorage nunca lanca", () => {
  globalThis.window = { localStorage: { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } } };
  assert.deepEqual(f.lerEscolhaGuardada("u1"), []);
  f.guardarEscolha("u1", ["hoje"]);
  const mem = {};
  globalThis.window = { localStorage: { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } } };
  f.guardarEscolha("u1", ["hoje", "amanha"]);
  assert.deepEqual(f.lerEscolhaGuardada("u1"), ["hoje", "amanha"]);
  mem["all2gether_tarefas_filtro_dias:u2"] = '["x",1,"hoje"]';
  assert.deepEqual(f.lerEscolhaGuardada("u2"), ["hoje"]);
  delete globalThis.window;
});
