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
const carregar = (nome) => {
  const exp = {};
  new Function("exports", "process", compilar(nome))(exp, process);
  return exp;
};

const { limparPais, tiposDoLugar, lerCoordenadas, formatarCoordenadas, LISBOA } = carregar("./sugestoes-morada.ts");

test("limparPais tira «, Portugal» no fim e só aí", () => {
  assert.equal(limparPais("Av. dos Combatentes 42, 2700-418 Amadora, Portugal"), "Av. dos Combatentes 42, 2700-418 Amadora");
  assert.equal(limparPais("Rua X 1, Lisboa,  portugal "), "Rua X 1, Lisboa");
  assert.equal(limparPais("Rua de Portugal 3, Porto"), "Rua de Portugal 3, Porto");
  assert.equal(limparPais(undefined), "");
});

test("tiposDoLugar usa os da sugestão; sem eles deduz street_address de rua + número", () => {
  assert.deepEqual(tiposDoLugar(["route"], []), ["route"]);
  assert.deepEqual(tiposDoLugar([], [{ types: ["route"] }, { types: ["street_number"] }]), ["street_address"]);
  assert.deepEqual(tiposDoLugar(undefined, [{ types: ["route"] }]), []);
  assert.deepEqual(tiposDoLugar(null, null), []);
});

test("lerCoordenadas / formatarCoordenadas", () => {
  assert.deepEqual(lerCoordenadas("38.7536, -9.2302"), { lat: 38.7536, lng: -9.2302 });
  assert.equal(formatarCoordenadas(38.7536, -9.2302), "38.753600, -9.230200");
  assert.deepEqual(lerCoordenadas(formatarCoordenadas(38.7536, -9.2302)), { lat: 38.7536, lng: -9.2302 });
  for (const m of ["", null, "abc", "https://www.google.com/maps", "38,7536, -9,2302"]) assert.equal(lerCoordenadas(m), null);
  assert.ok(LISBOA.lat > 38 && LISBOA.lng < -9);
});

test("sem NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY tudo fica escondido e o Google nunca é carregado", async () => {
  const anterior = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
  try {
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    const sem = carregar("./google-maps.ts");
    assert.equal(sem.googleMapsDisponivel(), false);
    await assert.rejects(sem.carregarGoogleMaps(), /não está configurado/);

    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = "   ";
    assert.equal(carregar("./google-maps.ts").googleMapsDisponivel(), false);

    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = "chave-de-teste";
    assert.equal(carregar("./google-maps.ts").googleMapsDisponivel(), true);
  } finally {
    if (anterior === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = anterior;
  }
});

test("CSP: só abre os domínios do Google com a chave definida", async () => {
  const anterior = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
  const csp = async (chave) => {
    if (chave === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = chave;
    const mod = await import(`../../next.config.mjs?k=${chave}`);
    const cfg = typeof mod.default === "function" ? mod.default : null;
    // withPWA devolve a configuração com headers(): lê a CSP de lá.
    const h = await (cfg ? cfg : mod.default).headers();
    return h[0].headers.find((x) => x.key === "Content-Security-Policy").value;
  };
  try {
    const sem = await csp(undefined);
    assert.ok(!sem.includes("googleapis"));
    const com = await csp("chave");
    const diretiva = (nome) => com.split("; ").find((d) => d.startsWith(nome + " ")) ?? "";
    // script-src: só os dois hosts de scripts, sem wildcards
    const scripts = diretiva("script-src");
    assert.ok(scripts.includes("https://maps.googleapis.com") && scripts.includes("https://maps.gstatic.com"));
    assert.ok(!scripts.includes("*"), scripts);
    assert.ok(/connect-src[^;]*maps.googleapis.com/.test(com) && /connect-src[^;]*places.googleapis.com/.test(com));
    assert.ok(diretiva("img-src").includes("googleusercontent.com"));
    assert.ok(!com.includes("https://*.googleapis.com"));
    // O SW faz fetch() aos tipos de letra do Google: connect-src precisa deles (só com chave).
    assert.ok(/connect-src[^;]*https:\/\/fonts\.googleapis\.com/.test(com) && /connect-src[^;]*https:\/\/fonts\.gstatic\.com/.test(com));
    assert.ok(!/connect-src[^;]*fonts\./.test(sem));
  } finally {
    if (anterior === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY = anterior;
  }
});
