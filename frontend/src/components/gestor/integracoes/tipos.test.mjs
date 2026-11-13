import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./tipos.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
new Function("exports", outputText)(exp);
const { passaFiltro, ordenarLinhas, canalDoLink, diaMes } = exp;

const p = (o) => ({ n_erros: 0, n_por_confirmar: 0, estado: "ok", ...o });

test("filtros: Com erro, Por confirmar, Sem ligação e Em pausa", () => {
  assert.equal(passaFiltro(p({ n_erros: 1 }), "erro"), true);
  assert.equal(passaFiltro(p({}), "erro"), false);
  assert.equal(passaFiltro(p({ n_por_confirmar: 3 }), "por_confirmar"), true);
  assert.equal(passaFiltro(p({ estado: "sem_ligacao" }), "sem_ligacao"), true);
  assert.equal(passaFiltro(p({ estado: "por_aceitar" }), "pausada"), true);
  assert.equal(passaFiltro(p({}), "todos"), true);
});

test("as linhas com erro sobem ao topo e a ordem se mantém dentro de cada grupo", () => {
  const r = ordenarLinhas([p({ nome: "A" }), p({ nome: "B", n_erros: 2 }), p({ nome: "C" }), p({ nome: "D", n_erros: 1 })]);
  assert.deepEqual(r.map((x) => x.nome), ["B", "D", "A", "C"]);
});

test("deteção do canal pelo link (sugere trocar em vez de recusar)", () => {
  assert.equal(canalDoLink("https://www.airbnb.pt/calendar/ical/1.ics?s=x"), "airbnb");
  assert.equal(canalDoLink("https://ical.booking.com/v1/export?t=abc"), "booking");
  assert.equal(canalDoLink("https://calendar.google.com/x.ics"), "outro");
  assert.equal(canalDoLink("  "), null);
  assert.equal(canalDoLink("airbnb.com/calendar"), null);
  assert.equal(canalDoLink("https://evil.com/airbnb.com/"), "outro");
});

test("datas curtas", () => {
  assert.equal(diaMes("2026-11-14"), "14 nov");
  assert.equal(diaMes("2027-03-30"), "30 mar");
});
