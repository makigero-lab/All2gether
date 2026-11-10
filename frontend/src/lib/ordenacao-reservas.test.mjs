/** Testes da ordenação da tabela de reservas do parceiro. Corre com: npm test */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./ordenacao-reservas.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exports_ = {};
new Function("require", "exports", outputText)(require, exports_);
const O = exports_;

const ids = (l) => l.map((x) => x.id).join(",");
const v = (x) => x.v;

test("datas ordenam-se como datas, vazios e inválidos no fim (asc e desc)", () => {
  const l = [{ id: "a", v: "2030-06-10" }, { id: "b", v: "" }, { id: "c", v: "2029-12-31" }, { id: "d", v: "lixo" }, { id: "e", v: "2030-01-05" }];
  assert.equal(ids(O.ordenarPor(l, v, "data", "asc")), "c,e,a,b,d");
  assert.equal(ids(O.ordenarPor(l, v, "data", "desc")), "a,e,c,b,d");
});

test("números ordenam-se como números (10 depois de 9), vazio e texto no fim", () => {
  const l = [{ id: "a", v: "10" }, { id: "b", v: "9" }, { id: "c", v: "" }, { id: "d", v: "2,5" }, { id: "e", v: null }, { id: "f", v: 100 }];
  assert.equal(ids(O.ordenarPor(l, v, "numero", "asc")), "d,b,a,f,c,e");
  assert.equal(ids(O.ordenarPor(l, v, "numero", "desc")), "f,a,b,d,c,e");
});

test("texto: pt-PT, sem distinguir maiúsculas/acentos, números naturais", () => {
  const l = [{ id: "a", v: "Évora 10" }, { id: "b", v: "evora 2" }, { id: "c", v: "Zé" }, { id: "d", v: "  " }, { id: "e", v: "Ana" }];
  assert.equal(ids(O.ordenarPor(l, v, "texto", "asc")), "e,b,a,c,d");
  assert.equal(ids(O.ordenarPor(l, v, "texto", "desc")), "c,a,b,e,d");
});

test("ordenação estável e sem alterar a lista original", () => {
  const l = [{ id: "a", v: "2030-01-01" }, { id: "b", v: "2030-01-01" }, { id: "c", v: "2030-01-01" }];
  const copia = [...l];
  assert.equal(ids(O.ordenarPor(l, v, "data", "asc")), "a,b,c");
  assert.equal(ids(O.ordenarPor(l, v, "data", "desc")), "a,b,c");
  assert.deepEqual(l, copia);
});

test("alternar: mesma coluna inverte, outra coluna começa em ascendente", () => {
  assert.deepEqual(O.alternarOrdem({ chave: "check_in", direcao: "asc" }, "check_in"), { chave: "check_in", direcao: "desc" });
  assert.deepEqual(O.alternarOrdem({ chave: "check_in", direcao: "desc" }, "check_in"), { chave: "check_in", direcao: "asc" });
  assert.deepEqual(O.alternarOrdem({ chave: "check_in", direcao: "desc" }, "hospedes"), { chave: "hospedes", direcao: "asc" });
});

test("ordem congelada: linhas editadas não saltam; novas vão para o fim; as que saíram caem", () => {
  const l = [{ id: "x" }, { id: "a" }, { id: "b" }, { id: "n" }];
  assert.equal(ids(O.aplicarOrdemCongelada(l, ["a", "b", "x", "morta"], (t) => t.id)), "a,b,x,n");
  assert.equal(ids(O.aplicarOrdemCongelada(l, null, (t) => t.id)), "x,a,b,n");
});

class Armazem {
  m = new Map();
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, x) { this.m.set(k, x); }
}

test("preferência: omissão = check-in ascendente; guarda e lê; lixo e chaves desconhecidas = omissão", () => {
  const chaves = ["check_in", "hospedes"];
  const a = new Armazem();
  assert.deepEqual(O.lerOrdem(a, chaves), { chave: "check_in", direcao: "asc" });
  O.guardarOrdem(a, { chave: "hospedes", direcao: "desc" });
  assert.deepEqual(O.lerOrdem(a, chaves), { chave: "hospedes", direcao: "desc" });
  a.setItem(O.CHAVE_ORDEM_ARMAZEM, "{nao json");
  assert.deepEqual(O.lerOrdem(a, chaves), { chave: "check_in", direcao: "asc" });
  a.setItem(O.CHAVE_ORDEM_ARMAZEM, JSON.stringify({ chave: "__proto__", direcao: "asc" }));
  assert.deepEqual(O.lerOrdem(a, chaves), { chave: "check_in", direcao: "asc" });
  a.setItem(O.CHAVE_ORDEM_ARMAZEM, JSON.stringify({ chave: "hospedes", direcao: "sideways" }));
  assert.deepEqual(O.lerOrdem(a, chaves), { chave: "check_in", direcao: "asc" });
});
