// Limpeza provisória (reserva do Smoobu sem data de saída): o gestor vê «Data de saída por confirmar» e o motivo
// em todas as vistas do calendário. As peças partilhadas (pessoa-estado, semana-lista, vista-dia-equipa) são
// renderizadas a sério (react-dom/server) e contam-se o rótulo e o motivo; o Mês e o modal (que vivem na página,
// grande demais para renderizar aqui) verificam-se no código e no ambiente real (capturas do @Dev).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Carregador mínimo de .ts/.tsx com o alias «@/» (sem bundler).
for (const ext of [".ts", ".tsx"]) {
  require.extensions[ext] = (mod, ficheiro) => {
    const { outputText } = ts.transpileModule(readFileSync(ficheiro, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: ficheiro,
    });
    mod._compile(outputText, ficheiro);
  };
}
const resolverOriginal = Module._resolveFilename;
const stubNavegacao = path.join(path.dirname(fileURLToPath(import.meta.url)), "saida-desconhecida.stub-navegacao.cjs");
Module._resolveFilename = function (pedido, ...resto) {
  if (pedido === "next/navigation") return stubNavegacao; // sem router montado fora do Next
  if (typeof pedido === "string" && pedido.startsWith("@/")) {
    const base = path.join(SRC, pedido.slice(2));
    for (const sufixo of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
      try {
        return resolverOriginal.call(this, base + sufixo, ...resto);
      } catch {
        /* tenta o seguinte */
      }
    }
  }
  return resolverOriginal.call(this, pedido, ...resto);
};

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lib = require("./saida-desconhecida.ts");
const pessoa = require("../components/gestor/pessoa-estado.tsx");
const semana = require("../components/gestor/semana-lista.tsx");
const diaEquipa = require("../components/gestor/vista-dia-equipa.tsx");

const ROTULO = "Data de saída por confirmar";
const MOTIVO = "Data de saída desconhecida: o Smoobu não respondeu. Confirma a data.";
const conta = (html, texto) => html.split(texto).length - 1;
const h = React.createElement;

const base = {
  propriedade_id: { _id: "p1", nome: "Casa Sol" },
  utilizador_id: null,
  equipa_atribuida: [],
  data: "2031-09-10T10:00:00.000Z",
  tempo_limpeza_minutos: 90,
  tipo: "limpeza",
  tipo_limpeza: "normal",
  estado: "por_atribuir",
};
const provisoria = { ...base, _id: "t1", data_saida_desconhecida: true, motivo_nao_atribuicao: MOTIVO };
const normal = { ...base, _id: "t2", data: "2031-09-10T15:00:00.000Z", propriedade_id: { _id: "p2", nome: "Casa Lua" }, motivo_nao_atribuicao: "Ninguém disponível." };
const cores = new Map();

test("regras: o rótulo só aparece com a data provisória e a limpeza ainda a contar", () => {
  assert.equal(lib.ROTULO_SAIDA_POR_CONFIRMAR, ROTULO);
  assert.equal(lib.saidaPorConfirmar(provisoria), true);
  assert.equal(lib.saidaPorConfirmar(normal), false);
  assert.equal(lib.saidaPorConfirmar({ ...provisoria, estado: "cancelada" }), false);
  assert.equal(lib.saidaPorConfirmar({ ...provisoria, estado: "concluida" }), false);
  assert.equal(lib.rotuloSubstituiEstado(provisoria), true);
  assert.equal(lib.rotuloSubstituiEstado({ ...provisoria, estado: "atribuida" }), false); // com pessoa à mão: aviso à parte
  assert.equal(lib.motivoSaida(provisoria), MOTIVO);
  assert.equal(lib.motivoSaida(normal), null);
  assert.equal(lib.textoSaidaPorConfirmar(normal), null);
  assert.match(lib.textoSaidaPorConfirmar(provisoria), new RegExp(`^${ROTULO}\\. Data de saída desconhecida`));
  assert.equal(lib.textoSaidaPorConfirmar({ ...provisoria, motivo_nao_atribuicao: null }), ROTULO);
});

test("etiqueta de estado: «Por atribuir» dá lugar ao rótulo e o motivo vai no title", () => {
  const html = renderToStaticMarkup(h(pessoa.EtiquetaEstado, { estado: "por_atribuir", saida: provisoria }));
  assert.equal(conta(html, ROTULO), 2); // texto + title
  assert.doesNotMatch(html, />[^<]*Por atribuir/);
  assert.ok(html.includes(MOTIVO));
  const normalHtml = renderToStaticMarkup(h(pessoa.EtiquetaEstado, { estado: "por_atribuir", saida: normal }));
  assert.equal(conta(normalHtml, ROTULO), 0);
  assert.match(normalHtml, /Por atribuir/);
});

test("avisos: pessoa atribuída à mão numa data ainda provisória mantém o rótulo como aviso", () => {
  const atribuida = { ...provisoria, estado: "atribuida" };
  assert.equal(conta(renderToStaticMarkup(h(pessoa.AvisosLimpeza, { t: atribuida })), ROTULO), 2);
  // por atribuir: o rótulo já está na etiqueta de estado, não se repete
  assert.equal(renderToStaticMarkup(h(pessoa.AvisosLimpeza, { t: provisoria })), "");
  assert.equal(renderToStaticMarkup(h(pessoa.AvisosLimpeza, { t: normal })), "");
  assert.match(pessoa.textoAvisos(provisoria), new RegExp(ROTULO));
  assert.equal(pessoa.textoAvisos(normal), null);
});

test("Semana (lista, computador e telemóvel): uma limpeza provisória mostra o rótulo e o motivo; a normal não", () => {
  const dia = "2031-09-10";
  const porDia = new Map([[dia, [provisoria, normal]]]);
  const html = renderToStaticMarkup(
    h(semana.SemanaLista, {
      dias: [dia], porDia, ausentesPorDia: new Map(), cores, titulo: "Semana", loading: false,
      onAnterior() {}, onSeguinte() {}, onHoje() {}, onAbrir() {},
    })
  );
  // texto visível do rótulo: 1 (a linha normal não o tem); o title e o aria-label repetem-no
  const visivel = html.replace(/<[^>]+>/g, "|").split("|").filter((x) => x.trim());
  assert.equal(visivel.filter((x) => x.trim() === ROTULO).length, 1);
  assert.equal(visivel.filter((x) => x.trim() === MOTIVO).length, 1); // motivo visível (telemóvel não tem hover)
  assert.match(html, /aria-label="[^"]*Casa Sol[^"]*Data de saída por confirmar/);
  assert.doesNotMatch(html, /aria-label="[^"]*Casa Lua[^"]*Data de saída por confirmar/);
  assert.equal(visivel.filter((x) => x.trim() === "Por atribuir").length >= 1, true); // a normal continua a dizer «Por atribuir»
});

test("Dia no computador (colunas) e no telemóvel (lista): rótulo e motivo visíveis", () => {
  const dia = "2031-09-10";
  const comuns = { dia, tarefas: [provisoria, normal], equipa: [], cores, loading: false, onMudarDia() {}, onHoje() {}, onAbrir() {} };
  for (const estreito of [false, true]) {
    const html = renderToStaticMarkup(h(diaEquipa.VistaDiaEquipa, { ...comuns, estreito }));
    const visivel = html.replace(/<[^>]+>/g, "|").split("|").filter((x) => x.trim());
    const qual = estreito ? "telemóvel" : "computador";
    assert.equal(visivel.filter((x) => x.trim() === ROTULO).length, 1, `rótulo visível no ${qual}`);
    assert.equal(visivel.filter((x) => x.trim() === MOTIVO).length, 1, `motivo visível no ${qual}`);
    assert.ok(html.includes(MOTIVO));
  }
});

test("Dia sem limpezas provisórias: o rótulo não aparece em lado nenhum", () => {
  const html = renderToStaticMarkup(
    h(diaEquipa.VistaDiaEquipa, { dia: "2031-09-10", tarefas: [normal], equipa: [], cores, loading: false, onMudarDia() {}, onHoje() {}, onAbrir() {} })
  );
  assert.equal(conta(html, ROTULO), 0);
});

test("modal de detalhe: quadro com rótulo, motivo e a nota; nada se a data não é provisória", () => {
  const html = renderToStaticMarkup(h(pessoa.AvisoSaidaPorConfirmar, { t: provisoria }));
  assert.equal(conta(html, ROTULO), 1);
  assert.ok(html.includes(MOTIVO));
  assert.match(html, /role="status"/);
  assert.equal(renderToStaticMarkup(h(pessoa.AvisoSaidaPorConfirmar, { t: normal })), "");
});

test("página do calendário: Mês (title, lista do dia no telemóvel) e modal usam as peças partilhadas", () => {
  const pagina = readFileSync(path.join(SRC, "app/gestor/calendario/page.tsx"), "utf8");
  // Mês no computador: o title leva o rótulo e o motivo (textoSaidaPorConfirmar)
  const mes = pagina.slice(pagina.indexOf("// --- Vista mensal"), pagina.indexOf("// --- Vistas semanal/diária"));
  assert.match(mes, /textoSaidaPorConfirmar\(t\)/);
  // Lista do dia (telemóvel): rótulo no lugar de «Por atribuir» e motivo visível
  const linha = pagina.slice(pagina.indexOf("const renderLinhaDia"), pagina.indexOf("const tituloSemana"));
  assert.match(linha, /rotuloSubstituiEstado\(x\) \? ROTULO_SAIDA_POR_CONFIRMAR/);
  assert.match(linha, /<MotivoSaida t=\{x\}/);
  // Modal «Detalhe da Limpeza»: quadro de aviso por cima de «Data + tempo», com a limpeza selecionada
  const modal = pagina.slice(pagina.indexOf("<DialogTitle>Detalhe da Limpeza"));
  assert.match(modal, /<AvisoSaidaPorConfirmar t=\{tarefaSelecionada\} \/>/);
  assert.ok(modal.indexOf("Mudar dia") < modal.indexOf("<AvisoSaidaPorConfirmar"));
});
