import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compilar = (nome) => {
  const src = readFileSync(new URL(nome, import.meta.url), "utf8");
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
};
const tipos = {};
new Function("exports", compilar("../components/gestor/integracoes/tipos.ts"))(tipos);
const m = {};
new Function("exports", "require", compilar("./casas-rotulo.ts"))(m, () => tipos);
const { rotulosDeCasas, rotuloDaCasa, tarefaDaCasa } = m;

const props = [
  { _id: "a", nome: "Casa Azul", morada_estruturada: { rua: "Rua Augusta 10", cidade: "Lisboa" } },
  { _id: "b", nome: "Casa Azul", morada_estruturada: { rua: "Rua do Ouro 5", cidade: "Lisboa" } },
  { _id: "c", nome: "Casa Sol", morada: "Rua das Flores 1, Porto" },
  { _id: "d", nome: "Casa Azul", morada: "Rua Nova 3, Faro" },
];

test("casas homónimas distinguem-se na lista de propriedades (morada estruturada ou livre)", () => {
  const r = rotulosDeCasas(props);
  assert.equal(r.get("c"), "Casa Sol");
  assert.equal(r.get("d"), "Casa Azul (Faro)");
  assert.equal(r.get("a"), "Casa Azul (Rua Augusta)");
  assert.equal(r.get("b"), "Casa Azul (Rua do Ouro)");
});

test("a casa de uma tarefa (morada curta da API) dá o mesmo rótulo que a lista de propriedades", () => {
  const dasTarefas = [
    { _id: "a", nome: "Casa Azul", morada_curta: "Rua Augusta 10, Lisboa", morada_rua: "Rua Augusta 10", morada_localidade: "Lisboa" },
    { _id: "b", nome: "Casa Azul", morada_curta: "Rua do Ouro 5, Lisboa", morada_rua: "Rua do Ouro 5", morada_localidade: "Lisboa" },
  ];
  const r = rotulosDeCasas(dasTarefas);
  const p = rotulosDeCasas(props.slice(0, 2));
  assert.equal(r.get("a"), p.get("a"));
  assert.equal(r.get("b"), p.get("b"));
});

test("rotuloDaCasa: do mapa, ou o nome; casa em falta dá traço", () => {
  const r = rotulosDeCasas(props);
  assert.equal(rotuloDaCasa(r, { _id: "a", nome: "Casa Azul" }), "Casa Azul (Rua Augusta)");
  assert.equal(rotuloDaCasa(r, { _id: "zzz", nome: "Outra" }), "Outra");
  assert.equal(rotuloDaCasa(r, { nome: "Sem id" }), "Sem id");
  assert.equal(rotuloDaCasa(r, null), "—");
});

test("filtro por _id: duas casas com o mesmo nome não se misturam", () => {
  const ta = { propriedade_id: { _id: "a", nome: "Casa Azul" } };
  const tb = { propriedade_id: { _id: "b", nome: "Casa Azul" } };
  assert.equal(tarefaDaCasa(ta, "a"), true);
  assert.equal(tarefaDaCasa(tb, "a"), false);
  assert.equal(tarefaDaCasa(tb, ""), true);
  assert.equal(tarefaDaCasa({ propriedade_id: null }, "a"), false);
  assert.equal(tarefaDaCasa({}, ""), true);
});
