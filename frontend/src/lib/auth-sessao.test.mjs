/**
 * N6: lerSessao distingue "sem sessão" (401/404) de "erro temporário" (5xx, 429, rede),
 * e só o primeiro justifica ir para o login. Erros nunca ficam em cache.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const A = {};
new Function("require", "exports", outputText)((m) => {
  if (m === "@/lib/rascunho-staff") return { contarRascunhos: () => 0, limparTodosRascunhos: () => {} };
  return require(m);
}, A);

const utilizador = { id: "u1", nome: "Ana", email: "a@x.pt", role: "staff", empresa_id: "e1" };
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

async function com(fetchFalso, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFalso;
  A.limparCacheAuth();
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    A.limparCacheAuth();
  }
}

test("200 com utilizador: ok (e fica em cache)", async () => {
  let chamadas = 0;
  await com(async () => { chamadas++; return resposta(200, { utilizador }); }, async () => {
    const r = await A.lerSessao();
    assert.equal(r.estado, "ok");
    assert.equal(r.user.id, "u1");
    await A.lerSessao();
    assert.equal(chamadas, 1);
  });
});

for (const status of [401, 403, 404]) {
  test(`${status}: sem sessão (cache negativo curto)`, async () => {
    await com(async () => resposta(status, { erro: "x" }), async () => {
      const r = await A.lerSessao();
      assert.equal(r.estado, "sem_sessao");
      assert.equal(r.user, null);
    });
  });
}

for (const status of [500, 502, 503, 504, 429]) {
  test(`${status}: erro temporário, NÃO é sem sessão, e não fica em cache`, async () => {
    let chamadas = 0;
    await com(async () => { chamadas++; return resposta(status, { erro: "x" }); }, async () => {
      assert.equal((await A.lerSessao()).estado, "erro");
      assert.equal((await A.lerSessao()).estado, "erro");
      assert.equal(chamadas, 2, "cada tentativa volta a perguntar ao servidor");
    });
  });
}

test("falha de rede (fetch lança) e corpo ilegível: erro temporário", async () => {
  await com(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    assert.equal((await A.lerSessao()).estado, "erro");
  });
  await com(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), async () => {
    assert.equal((await A.lerSessao()).estado, "erro");
  });
});

test("200 sem utilizador: erro (não manda para o login)", async () => {
  await com(async () => resposta(200, {}), async () => {
    assert.equal((await A.lerSessao()).estado, "erro");
  });
});

test("recupera: depois de um 503 (servidor a acordar) a tentativa seguinte devolve ok", async () => {
  const sequencia = [resposta(503, {}), resposta(502, {}), resposta(200, { utilizador })];
  await com(async () => sequencia.shift(), async () => {
    assert.equal((await A.lerSessao()).estado, "erro");
    assert.equal((await A.lerSessao()).estado, "erro");
    const r = await A.lerSessao();
    assert.equal(r.estado, "ok");
    assert.equal(r.user.nome, "Ana");
  });
});

test("lerUtilizador continua a devolver o utilizador ou null", async () => {
  await com(async () => resposta(200, { utilizador }), async () => {
    assert.equal((await A.lerUtilizador()).id, "u1");
  });
  await com(async () => resposta(503, {}), async () => {
    assert.equal(await A.lerUtilizador(), null);
  });
});
