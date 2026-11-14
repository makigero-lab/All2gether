import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fonte = readFileSync(new URL("./tipos.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(fonte, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exp = {};
new Function("exports", outputText)(exp);
const { passaFiltro, ordenarLinhas, canalDoLink, diaMes, blocos, semCasasParaLigar, fraseDoTeste, resultadoLigar, resultadoAceitar, agruparFalhas, textoCorte, legendaCasas, enviarEmBlocos, REGRA_UMA_FONTE, TAMANHO_BLOCO } = exp;

const p = (o) => ({ n_erros: 0, n_por_confirmar: 0, estado: "ok", ...o });

test("filtros: Com erro, Por confirmar, Sem ligação e Em pausa", () => {
  assert.equal(passaFiltro(p({ n_erros: 1 }), "erro"), true);
  assert.equal(passaFiltro(p({}), "erro"), false);
  assert.equal(passaFiltro(p({ n_por_confirmar: 3 }), "por_confirmar"), true);
  assert.equal(passaFiltro(p({ estado: "sem_ligacao" }), "sem_ligacao"), true);
  assert.equal(passaFiltro(p({ estado: "por_aceitar" }), "pausada"), true);
  assert.equal(passaFiltro(p({}), "todos"), true);
});

test("as linhas com erro sobem ao topo e a ordem se mantém dentro de cada grupo", () => {
  const r = ordenarLinhas([p({ nome: "A" }), p({ nome: "B", n_erros: 2 }), p({ nome: "C" }), p({ nome: "D", n_erros: 1 })]);
  assert.deepEqual(r.map((x) => x.nome), ["B", "D", "A", "C"]);
});

test("deteção do canal pelo link (sugere trocar em vez de recusar)", () => {
  assert.equal(canalDoLink("https://www.airbnb.pt/calendar/ical/1.ics?s=x"), "airbnb");
  assert.equal(canalDoLink("https://ical.booking.com/v1/export?t=abc"), "booking");
  assert.equal(canalDoLink("https://calendar.google.com/x.ics"), "outro");
  assert.equal(canalDoLink("  "), null);
  assert.equal(canalDoLink("airbnb.com/calendar"), null);
  assert.equal(canalDoLink("https://evil.com/airbnb.com/"), "outro");
});

test("datas curtas", () => {
  assert.equal(diaMes("2026-11-14"), "14 nov");
  assert.equal(diaMes("2027-03-30"), "30 mar");
});

test("a regra «uma só fonte» é dita numa frase única", () => {
  assert.equal(REGRA_UMA_FONTE, "Cada casa recebe reservas de uma só origem automática: Smoobu, ou os calendários Airbnb/Booking, que podem coexistir.");
});

test("blocos de 200: 239 períodos partem-se em 200 + 39", () => {
  assert.equal(TAMANHO_BLOCO, 200);
  const ids = Array.from({ length: 239 }, (_, i) => `id${i}`);
  const b = blocos(ids);
  assert.deepEqual(b.map((x) => x.length), [200, 39]);
  assert.deepEqual(blocos([], 200), []);
  assert.deepEqual(blocos(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});

test("lote em blocos: envia 200 + 39, soma o resultado e dá progresso", async () => {
  const ids = Array.from({ length: 239 }, (_, i) => `id${i}`);
  const pedidos = []; const progresso = [];
  const enviar = async ({ ids: bloco, acao }) => { pedidos.push({ n: bloco.length, acao }); return { ok: bloco.length - 1, falhas: 1, resultados: [{ id: bloco[0], ok: false, erro: "O proprietário desta casa está inativo." }, ...bloco.slice(1).map((id) => ({ id, ok: true }))] }; };
  const r = await enviarEmBlocos(ids, "confirmar", enviar, (f) => progresso.push(f));
  assert.deepEqual(pedidos.map((p) => p.n), [200, 39]);
  assert.equal(r.ok, 237);
  assert.equal(r.falhas.length, 2);
  assert.deepEqual(r.restantes, []);
  assert.equal(r.erro, null);
  assert.deepEqual(progresso, [0, 200, 239]);
  assert.deepEqual(agruparFalhas(r.falhas), [{ texto: "O proprietário desta casa está inativo.", n: 2 }]);
});

test("lote em blocos: se o servidor pára mais cedo (nao_tratados) o resto segue no pedido seguinte", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
  const vistos = [];
  const enviar = async ({ ids: bloco }) => {
    vistos.push(bloco.length);
    const tratados = bloco.slice(0, 4);
    return { ok: tratados.length, falhas: 0, resultados: tratados.map((id) => ({ id, ok: true })), nao_tratados: bloco.slice(4), incompleto: bloco.length > 4 };
  };
  const r = await enviarEmBlocos(ids, "bloqueio", enviar);
  assert.deepEqual(vistos, [10, 6, 2]);
  assert.equal(r.ok, 10);
  assert.deepEqual(r.restantes, []);
});

test("lote em blocos: um erro de rede a meio não perde o que já foi feito e diz o que ficou por tratar", async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `id${i}`);
  let n = 0;
  const enviar = async ({ ids: bloco }) => { n += 1; if (n === 2) throw new Error("Falhou a ligação."); return { ok: bloco.length, falhas: 0, resultados: bloco.map((id) => ({ id, ok: true })) }; };
  const r = await enviarEmBlocos(ids, "confirmar", enviar);
  assert.equal(r.ok, 200);
  assert.equal(r.restantes.length, 100);
  assert.equal(r.erro, "Falhou a ligação.");
});

test("lote em blocos: se o servidor não trata nada, pára em vez de repetir para sempre", async () => {
  const r = await enviarEmBlocos(["a", "b"], "confirmar", async ({ ids }) => ({ ok: 0, falhas: 0, resultados: [], nao_tratados: ids, incompleto: true }));
  assert.deepEqual(r.restantes, ["a", "b"]);
  assert.match(r.erro, /Tenta outra vez/);
});

test("assistente: porque não há casas para ligar (proprietário inativo, só casas inativas, sem casas)", () => {
  const casa = (ativo) => ({ ativo });
  assert.match(semCasasParaLigar({ ativo: false, casas: [casa(true)], n_casas_inativas: 0 }), /proprietário está inativo/);
  assert.match(semCasasParaLigar({ ativo: true, casas: [], n_casas_inativas: 1 }), /única casa deste proprietário está inativa/);
  assert.match(semCasasParaLigar({ ativo: true, casas: [], n_casas_inativas: 3 }), /As 3 casas deste proprietário estão inativas/);
  assert.match(semCasasParaLigar({ ativo: true, casas: [casa(false), casa(false)], n_casas_inativas: 0 }), /As 2 casas/);
  assert.match(semCasasParaLigar({ ativo: true, casas: [], n_casas_inativas: 0 }), /ainda não tem casas/);
  assert.equal(semCasasParaLigar({ ativo: true, casas: [casa(true)], n_casas_inativas: 1 }), null);
});

test("resultado do teste: Booking nunca diz «0 reservas e 0 bloqueios»", () => {
  const f = fraseDoTeste({ canal: "booking", reservas: 0, bloqueios: 0, por_confirmar: 80, periodo: { de: "2026-11-15", ate: "2027-02-09" } });
  assert.equal(f, "Encontrámos 80 períodos por confirmar entre 15 nov e 9 fev (o Booking não distingue reservas de bloqueios).");
  assert.doesNotMatch(f, /0 reservas/);
  assert.match(fraseDoTeste({ canal: "booking", por_confirmar: 1 }), /1 período por confirmar/);
  assert.match(fraseDoTeste({ canal: "booking", por_confirmar: 0 }), /vazio/);
  assert.equal(fraseDoTeste({ canal: "airbnb", reservas: 3, bloqueios: 1, por_confirmar: 0, periodo: { de: "2026-11-15", ate: "2026-12-20" } }), "Encontrámos 3 reservas e 1 bloqueio entre 15 nov e 20 dez.");
  assert.equal(fraseDoTeste({ canal: "airbnb", reservas: 1, bloqueios: 0, por_confirmar: 2 }), "Encontrámos 1 reserva e 0 bloqueios e 2 períodos por confirmar.");
});

test("depois de ligar: «muitos novos» diz que fica à espera de validação, nunca «0 limpezas novas»", () => {
  const v = resultadoLigar({ fonte: { em_validacao: true }, leitura: { resultado: "ok", n_eventos: 80, alteracoes: { criadas: 0, por_confirmar: 80 } } });
  assert.equal(v.tipo, "validacao");
  assert.equal(v.texto, "Ligado, mas à espera da tua validação: encontrámos 80 reservas novas de uma vez. Ainda não criámos nenhuma limpeza.");
  assert.doesNotMatch(v.texto, /0 limpezas novas/);
  assert.equal(resultadoLigar({ fonte: { em_validacao: true, aviso_validacao: "Encontrámos 73 reservas novas de uma vez. Por segurança…" }, leitura: null }).n, 73);
  assert.deepEqual(resultadoLigar({ fonte: { em_validacao: false }, leitura: { resultado: "ok", alteracoes: { criadas: 4, por_confirmar: 0 } } }), { tipo: "ok", texto: "Ligado. 4 limpezas novas; 0 períodos por confirmar." });
  assert.equal(resultadoLigar({ leitura: { resultado: "erro", mensagem: "O calendário demorou." } }).tipo, "erro");
  assert.equal(resultadoLigar({ leitura: null }).texto, "Ligado.");
});

test("Aceitar: diz quantas limpezas criou", () => {
  assert.equal(resultadoAceitar({ alteracoes: { criadas: 80, por_confirmar: 0 } }), "Aceite. 80 limpezas criadas; 0 períodos por confirmar.");
  assert.equal(resultadoAceitar({ alteracoes: { criadas: 1, por_confirmar: 2 } }), "Aceite. 1 limpeza criada; 2 períodos por confirmar.");
  assert.match(resultadoAceitar(null), /Aceite/);
});

test("lista cortada diz «a mostrar 500 de 612»", () => {
  assert.equal(textoCorte(500, 612), "A mostrar 500 de 612.");
  assert.equal(textoCorte(50, 50), null);
});

test("legenda da mini-barra", () => {
  assert.equal(legendaCasas(["ligada", "com erro", "ligada"]), "3 casas · 1 com erro");
  assert.equal(legendaCasas(["em pausa"]), "1 casa · 1 em pausa");
});
