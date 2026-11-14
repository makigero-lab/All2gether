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
const { hojeLisboaISO, somarDiasISO, ultimoDiaDoFiltro, passaFiltroChegada, ordenarPorChegada, dataComAno, periodoComAno, textoLongosDeFora, textoConfirmarBloqueio, textoDeCasas, emCurso, OPCOES_CHEGADA } = exp;

test("S4: hoje em Lisboa, mesmo perto da meia-noite UTC", () => {
  assert.equal(hojeLisboaISO(new Date("2026-07-14T23:30:00Z")), "2026-07-15"); // verão: já é dia 15 em Lisboa
  assert.equal(hojeLisboaISO(new Date("2026-11-14T23:30:00Z")), "2026-11-14");
});

test("S4: «Próximos 7 dias» soma 7; «Todas» não limita; não há «Esta semana»", () => {
  assert.equal(ultimoDiaDoFiltro("todas", "2026-11-14"), null);
  assert.equal(ultimoDiaDoFiltro("7dias", "2026-11-14"), "2026-11-21");
  assert.equal(somarDiasISO("2026-12-30", 3), "2027-01-02");
  assert.deepEqual(OPCOES_CHEGADA.map((o) => o.valor), ["todas", "7dias"]);
});

test("S4: o filtro compara a chegada; períodos já em curso entram e levam a etiqueta «Em curso»", () => {
  assert.equal(passaFiltroChegada({ check_in: "2026-11-20" }, "todas", "2026-11-14"), true);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-21" }, "7dias", "2026-11-14"), true);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-22" }, "7dias", "2026-11-14"), false);
  assert.equal(passaFiltroChegada({ check_in: "2026-11-10" }, "7dias", "2026-11-14"), true);
  assert.equal(emCurso({ check_in: "2026-11-10", check_out: "2026-11-16" }, "2026-11-14"), true);
  assert.equal(emCurso({ check_in: "2026-11-14", check_out: "2026-11-16" }, "2026-11-14"), false); // chega hoje
  assert.equal(emCurso({ check_in: "2026-11-20", check_out: "2026-11-22" }, "2026-11-14"), false);
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
  assert.equal(textoLongosDeFora(1), "«Escolher todos» não inclui 1 período com mais de 30 noites.");
  assert.equal(textoLongosDeFora(2), "«Escolher todos» não inclui 2 períodos com mais de 30 noites.");
});

test("S4: o diálogo de «Marcar como bloqueio» diz quantos, de que casas e que não se desfaz", () => {
  const t = textoConfirmarBloqueio(14, ["Casa A", "Casa B", "Casa A"]);
  assert.equal(t.titulo, "Marcar 14 períodos como bloqueio?");
  assert.equal(t.descricao, "Ficam ignorados: não criam limpezas e não voltamos a perguntar por eles. Não dá para desfazer.");
  assert.equal(t.casas, "De: Casa A, Casa B");
  assert.equal(t.confirmar, "Marcar 14 como bloqueio");
  assert.equal(textoConfirmarBloqueio(1, ["X"]).titulo, "Marcar 1 período como bloqueio?");
  assert.match(textoConfirmarBloqueio(1, ["X"]).descricao, /^Fica ignorado: não cria limpezas/);
  assert.equal(textoDeCasas(["A", "B", "C", "D"]), "De 4 casas");
  assert.equal(textoDeCasas([]), "");
});
