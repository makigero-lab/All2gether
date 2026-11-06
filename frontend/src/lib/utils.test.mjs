import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./utils.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
// clsx / tailwind-merge não interessam a estas funções: stub.
new Function("exports", "require", outputText)(exp, () => ({ clsx: () => "", twMerge: () => "" }));

const semSubstituto = {
  total: 0, desatribuidas: 0, parciais: 1,
  reatribuicao: { total: 1, reatribuidas: 0, orfas: 0, parciais: 1, faltam: [{ propriedade: "Casa", faltam: 1 }] },
};

test("falta em equipa de 2 sem substituto: diz as vagas e conta como por atribuir", () => {
  const t = exp.textoRedistribuicao("Falta registada.", semSubstituto, "Não havia tarefas para hoje.");
  assert.equal(t, "Falta registada. 1 limpeza ficou a faltar 1 pessoa.");
  assert.equal(exp.tarefasPorAtribuir(semSubstituto), 1);
});

test("várias limpezas com vagas: plural e total de vagas", () => {
  const r = { desatribuidas: 0, reatribuicao: { reatribuidas: 0, orfas: 0, parciais: 2, faltam: [{ faltam: 1 }, { faltam: 2 }] } };
  assert.equal(exp.textoRedistribuicao("Baixa registada.", r, "x"), "Baixa registada. 2 limpezas ficaram a faltar pessoas (3 vagas).");
});

test("sem tarefas nem vagas continua a dizer que não havia tarefas", () => {
  const r = { desatribuidas: 0, reatribuicao: { reatribuidas: 0, orfas: 0, parciais: 0, faltam: [] } };
  assert.equal(exp.textoRedistribuicao("Falta registada.", r, "Não havia tarefas para hoje."), "Falta registada. Não havia tarefas para hoje.");
  assert.equal(exp.tarefasPorAtribuir(r), 0);
});

test("por atribuir + vagas somam", () => {
  const r = { desatribuidas: 1, reatribuicao: { reatribuidas: 0, orfas: 1, parciais: 1, faltam: [{ faltam: 1 }] } };
  assert.equal(exp.tarefasPorAtribuir(r), 2);
});
