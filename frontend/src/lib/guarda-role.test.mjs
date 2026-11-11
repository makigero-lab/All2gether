/** N10: decisão do RouteGuard quando o role do /me difere do do JWT. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./guarda-role.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const G = {};
new Function("require", "exports", outputText)(require, G);

test("primeira vez: redireciona; segunda vez para o mesmo destino na janela: logout (sem ciclo)", () => {
  assert.equal(G.decidirRoleErrado("/gestor", null, 1000), "redirecionar");
  const marca = { para: "/gestor", ts: 1000 };
  assert.equal(G.decidirRoleErrado("/gestor", marca, 1000 + 5000), "logout");
});

test("destino diferente ou marca antiga: redireciona (não é ciclo)", () => {
  assert.equal(G.decidirRoleErrado("/staff", { para: "/gestor", ts: 1000 }, 2000), "redirecionar");
  assert.equal(G.decidirRoleErrado("/gestor", { para: "/gestor", ts: 1000 }, 1000 + G.JANELA_CICLO_MS + 1), "redirecionar");
});

test("lerMarca: aceita só JSON válido com para e ts", () => {
  const arm = (v) => ({ getItem: () => v });
  assert.deepEqual(G.lerMarca(arm(JSON.stringify({ para: "/x", ts: 5 }))), { para: "/x", ts: 5 });
  assert.equal(G.lerMarca(arm("lixo")), null);
  assert.equal(G.lerMarca(arm(JSON.stringify({ para: 1 }))), null);
  assert.equal(G.lerMarca(arm(null)), null);
  assert.equal(G.lerMarca(null), null);
});
