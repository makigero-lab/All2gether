import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function carregar(rel) {
  const fonte = readFileSync(new URL(rel, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const exp = {};
  new Function("exports", outputText)(exp);
  return exp;
}

const { nomeDoFicheiro } = carregar("./descarregar.ts");

test("nomeDoFicheiro: usa o nome do Content-Disposition e só aceita nomes simples", () => {
  assert.equal(nomeDoFicheiro('attachment; filename="os-meus-dados-2026-11-08.json"', "x.json"), "os-meus-dados-2026-11-08.json");
  assert.equal(nomeDoFicheiro(null, "x.json"), "x.json");
  assert.equal(nomeDoFicheiro('attachment; filename="../../etc/passwd"', "x.json"), "x.json");
});

// Os componentes não têm ambiente de teste: verifica-se o código das regras de confirmação e dos pontos de entrada.
const dialogo = readFileSync(new URL("../components/rgpd/apagar-dados-dialog.tsx", import.meta.url), "utf8");
const empresas = readFileSync(new URL("../components/admin/empresas-rgpd.tsx", import.meta.url), "utf8");
const equipa = readFileSync(new URL("../app/gestor/equipa/page.tsx", import.meta.url), "utf8");

test("apagar pessoa: o botão só fica ativo com a palavra APAGAR exata e envia a confirmação", () => {
  assert.match(dialogo, /PALAVRA_CONFIRMACAO = "APAGAR"/);
  assert.match(dialogo, /return texto === PALAVRA_CONFIRMACAO/);
  assert.match(dialogo, /disabled=\{a \|\| !confirmacaoValida\(texto\)\}/);
  assert.match(dialogo, /apagar-dados-pessoais/);
  assert.match(dialogo, /variant="destructive"/);
});

test("agendar eliminação: exige o nome exato e um prazo de 7 a 365 dias", () => {
  assert.match(empresas, /escrito === nome/);
  assert.match(empresas, /diasNum >= 7 && diasNum <= 365/);
  assert.match(empresas, /Eliminação prevista a/);
  assert.match(empresas, /Cancelar eliminação/);
  assert.match(empresas, /Exportar empresa/);
});

test("Equipa: ações RGPD separadas, sem apagar a própria conta nem gestores (só o admin)", () => {
  assert.match(equipa, /Exportar dados/);
  assert.match(equipa, /Apagar dados pessoais/);
  assert.match(equipa, /eu\.id !== u\._id && \(u\.role !== "gestor" \|\| eu\.role === "admin"\)/);
});
