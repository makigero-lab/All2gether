import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./pesquisa.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
new Function("exports", outputText)(exp);
const { normalizarTexto, correspondePesquisa } = exp;

test("normalizarTexto tira acentos, maiúsculas e espaços a mais", () => {
  assert.equal(normalizarTexto("  AVENIDA  da Liberdade "), "avenida da liberdade");
  assert.equal(normalizarTexto("Calçada São João"), "calcada sao joao");
  assert.equal(normalizarTexto(null), "");
  assert.equal(normalizarTexto(undefined), "");
  assert.equal(normalizarTexto(912345678), "912345678");
});

test("pesquisa vazia ou só espaços aceita tudo", () => {
  assert.equal(correspondePesquisa("", ["x"]), true);
  assert.equal(correspondePesquisa("   ", []), true);
});

test("insensível a maiúsculas e acentos", () => {
  assert.equal(correspondePesquisa("sao joao", ["Casa", "Calçada de São João 5"]), true);
  assert.equal(correspondePesquisa("JOSE", ["José Silva"]), true);
  assert.equal(correspondePesquisa("josé", ["Jose Silva"]), true);
});

test("todas as palavras têm de existir, em qualquer ordem e em qualquer campo", () => {
  assert.equal(correspondePesquisa("silva amadora", ["Casa A", "Av. X, Amadora", "Maria Silva"]), true);
  assert.equal(correspondePesquisa("silva porto", ["Casa A", "Av. X, Amadora", "Maria Silva"]), false);
});

test("abreviaturas expandidas dos dois lados", () => {
  assert.equal(correspondePesquisa("avenida combatentes", ["Av. dos Combatentes da Grande Guerra 42, Amadora"]), true);
  assert.equal(correspondePesquisa("av. combatentes", ["Avenida dos Combatentes 42"]), true);
  assert.equal(correspondePesquisa("rua augusta", ["R. Augusta 3"]), true);
  assert.equal(correspondePesquisa("travessa", ["Tv. do Ouro 1"]), true);
  assert.equal(correspondePesquisa("av", ["Av. X 1"]), true);
  assert.equal(correspondePesquisa("praca", ["Pça. da República 2"]), true);
  assert.equal(correspondePesquisa("avenida", ["Rua das Flores 1"]), false);
});

test("expandirAbreviaturas", () => {
  assert.equal(exp.expandirAbreviaturas("Avª da Liberdade 5, R. B 2"), "Avenida da Liberdade 5, Rua B 2");
});

test("ignora campos vazios, nulos e não-texto", () => {
  assert.equal(correspondePesquisa("912", [null, undefined, "", 912345678]), true);
  assert.equal(correspondePesquisa("abc", [null, undefined]), false);
});
