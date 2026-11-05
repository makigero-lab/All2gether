import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./equipa.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
new Function("exports", outputText)(exp);

test("equipa de 2: responsável primeiro e eu como Tu", () => {
  assert.equal(exp.textoEquipa([{ _id: "1", nome: "Carla Dias", responsavel: true }, { _id: "2", nome: "Rui", responsavel: false, eu: true }]), "Carla (resp.) + Tu");
  assert.equal(exp.textoEquipa([{ _id: "1", nome: "Carla", responsavel: true, eu: true }, { _id: "2", nome: "Rui", responsavel: false }]), "Tu (resp.) + Rui");
});
test("sozinho ou sem dados: não mostra equipa", () => {
  assert.equal(exp.textoEquipa([{ _id: "1", nome: "Carla", responsavel: true }]), null);
  assert.equal(exp.textoEquipa(undefined), null);
});

test("calendário do gestor: Ana (resp.) + Bruno e falta de pessoas", () => {
  assert.equal(exp.textoEquipaGestor({ _id: "1", nome: "Ana Silva" }, [{ _id: "1", nome: "Ana Silva" }, { _id: "2", nome: "Bruno Costa" }]), "Ana (resp.) + Bruno");
  assert.equal(exp.textoEquipaGestor({ _id: "1", nome: "Ana" }, []), "Ana");
  assert.equal(exp.textoEquipaGestor(null, null), null);
  assert.equal(exp.textoFalta(1), "Falta 1 pessoa");
  assert.equal(exp.textoFalta(2), "Faltam 2 pessoas");
  assert.equal(exp.textoFalta(0), null);
});
