import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./reservas-externas.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
new Function("exports", outputText)(exp);
const { hojeLisboaISO, somarDiasISO, ultimoDiaDoFiltro, passaFiltroChegada, ordenarPorChegada, dataComAno, periodoComAno, textoLongosDeFora, textoConfirmarBloqueio, OPCOES_CHEGADA } = exp;

test("S4: hoje em Lisboa, mesmo perto da meia-noite UTC", () => {
  assert.equal(hojeLisboaISO(new Date("2026-07-14T23:30:00Z")), "2026-07-15"); // verão: já é dia 15 em Lisboa
  assert.equal(hojeLisboaISO(new Date("2026-11-14T23:30:00Z")), "2026-11-14");
});

test("S4: «Esta semana» acaba no domingo; «Próximos 7 dias» soma 7; «Todas» não limita", () => {
  assert.equal(ultimoDiaDoFiltro("todas", "2026-11-14"), null);
  assert.equal(ultimoDiaDoFiltro("7dias", "2026-11-14"), "2026-11-21");
  assert.equal(ultimoDiaDoFiltro("semana", "2026-11-14"), "2026-11-15"); // sábado → domingo
  assert.equal(ultimoDiaDoFiltro("semana", "2026-11-16"), "2026-11-22"); // segunda → domingo seguinte
  assert.equal(ultimoDiaDoFiltro("semana", "2026-11-15"), "2026-11-15"); // domingo → hoje
  assert.equal(somarDiasISO("2026-12-30", 3), "2027-01-02");
});

test("S4: o filtro compara a chegada; «Todas» deixa tudo passar", () => {
  assert.equal(passaFiltroChegada({ check_in: "2026-11-20" }, "todas", "2026-11-14"), true);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-21" }, "7dias", "2026-11-14"), true);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-22" }, "7dias", "2026-11-14"), false);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-12" }, "semana", "2026-11-14"), true); // já em curso
  assert.equal(passaFiltroChegada({ check_in: "2026-11-16" }, "semana", "2026-11-14"), false);
  assert.deepEqual(OPCOES_CHEGADA.map((o) => o.valor), ["todas", "semana", "7dias"]);
});

test("S4: ordena por chegada e depois por saída, sem mexer na lista original", () => {
  const l = [
    { check_in: "2026-12-01", check_out: "2026-12-05" },
    { check_in: "2026-11-20", check_out: "2026-11-25" },
    { check_in: "2026-11-20", check_out: "2026-11-22" },
  ];
  assert.deepEqual(ordenarPorChegada(l).map((x) => x.check_out), ["2026-11-22", "2026-11-25", "2026-12-05"]);
  assert.equal(l[0].check_in, "2026-12-01");
});

test("S4: datas com ano", () => {
  assert.equal(dataComAno("2026-11-14"), "14/11/2026");
  assert.equal(periodoComAno({ check_in: "2026-12-30", check_out: "2027-01-02" }), "30/12/2026 a 02/01/2027");
});

test("S4: frase dos de mais de 30 noites que ficam de fora", () => {
  assert.equal(textoLongosDeFora(0), null);
  assert.equal(textoLongosDeFora(1), "1 de mais de 30 noites fica de fora:");
  assert.equal(textoLongosDeFora(2), "2 de mais de 30 noites ficam de fora:");
});

test("S4: o diálogo de «Marcar como bloqueio» diz quantos e que não se desfaz", () => {
  const t = textoConfirmarBloqueio(5);
  assert.equal(t.titulo, "Marcar 5 períodos como bloqueio?");
  assert.match(t.descricao, /não se desfaz/);
  assert.equal(t.confirmar, "Marcar 5 como bloqueio");
  assert.equal(textoConfirmarBloqueio(1).titulo, "Marcar 1 período como bloqueio?");
});
