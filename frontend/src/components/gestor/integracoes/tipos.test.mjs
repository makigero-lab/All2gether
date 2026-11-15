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
const { passaFiltro, ordenarLinhas, canalDoLink, diaMes, blocos, semCasasParaLigar, fraseDoTeste, resultadoLigar, resultadoAceitar, agruparFalhas, textoCorte, legendaCasas, enviarEmBlocos, REGRA_UMA_FONTE, TAMANHO_BLOCO, haQuanto, textoFalha, falhaLonga, nomesDistintos, rotulosDasCasas } = exp;

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

test("blocos de 25: 239 períodos partem-se em 9 blocos de 25 + 14", () => {
  assert.equal(TAMANHO_BLOCO, 25);
  const ids = Array.from({ length: 239 }, (_, i) => `id${i}`);
  const b = blocos(ids);
  assert.deepEqual(b.map((x) => x.length), [...Array(9).fill(25), 14]);
  assert.deepEqual(blocos([], 25), []);
  assert.deepEqual(blocos(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});

test("lote em blocos: envia 9 x 25 + 14, soma o resultado e dá progresso", async () => {
  const ids = Array.from({ length: 239 }, (_, i) => `id${i}`);
  const pedidos = []; const progresso = [];
  const enviar = async ({ ids: bloco, acao }) => { pedidos.push({ n: bloco.length, acao }); return { ok: bloco.length - 1, falhas: 1, resultados: [{ id: bloco[0], ok: false, erro: "O proprietário desta casa está inativo." }, ...bloco.slice(1).map((id) => ({ id, ok: true }))] }; };
  const r = await enviarEmBlocos(ids, "confirmar", enviar, (f) => progresso.push(f));
  assert.deepEqual(pedidos.map((p) => p.n), [...Array(9).fill(25), 14]);
  assert.equal(r.ok, 229);
  assert.equal(r.falhas.length, 10);
  assert.deepEqual(r.restantes, []);
  assert.equal(r.erro, null);
  assert.deepEqual(progresso, [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 239]);
  assert.deepEqual(agruparFalhas(r.falhas), [{ texto: "O proprietário desta casa está inativo.", n: 10 }]);
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
  assert.equal(r.ok, 25);
  assert.equal(r.restantes.length, 275);
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

const AGORA = new Date("2026-11-14T12:10:00Z");
const em = (min) => new Date(AGORA.getTime() + min * 60000).toISOString();

test("S1: «Falha há 2 h · nova tentativa às 14:10» (hora de Lisboa)", () => {
  assert.equal(textoFalha({ falha_desde: em(-120), proxima_leitura_em: em(120) }, AGORA), "Falha há 2 h · nova tentativa às 14:10");
  // verão: 13:10 UTC são 14:10 em Lisboa
  assert.equal(textoFalha({ proxima_leitura_em: "2026-07-14T13:10:00Z" }, new Date("2026-07-14T10:00:00Z")), "nova tentativa às 14:10");
});

test("S1: só diz o que o servidor sabe; sem dados não mostra nada", () => {
  assert.equal(textoFalha(null, AGORA), null);
  assert.equal(textoFalha({}, AGORA), null);
  assert.equal(textoFalha({ falha_desde: null, proxima_leitura_em: null }, AGORA), null);
  assert.equal(textoFalha({ falha_desde: "lixo", proxima_leitura_em: "lixo" }, AGORA), null);
  assert.equal(textoFalha({ falha_desde: em(-45) }, AGORA), "Falha há 45 min");
  assert.equal(textoFalha({ proxima_leitura_em: em(30) }, AGORA), "nova tentativa às 12:40");
  assert.equal(textoFalha({ falha_desde: em(-0.2) }, AGORA), "Falhou agora mesmo");
});

test("S1: tentativa em atraso diz «em breve»; amanhã e dias seguintes dizem o dia", () => {
  assert.equal(textoFalha({ falha_desde: em(-300), proxima_leitura_em: em(-3) }, AGORA), "Falha há 5 h · nova tentativa em breve");
  assert.equal(textoFalha({ proxima_leitura_em: em(60 * 6) }, new Date("2026-11-14T12:10:00Z")), "nova tentativa às 18:10");
  assert.equal(textoFalha({ proxima_leitura_em: em(60 * 14) }, AGORA), "nova tentativa amanhã às 02:10");
  assert.equal(textoFalha({ proxima_leitura_em: em(60 * 60) }, AGORA), "nova tentativa a 17 nov às 00:10");
});

test("haQuanto: 1 dia no singular", () => {
  assert.equal(haQuanto(em(-1440), AGORA.getTime()), "há 1 dia");
  assert.equal(haQuanto(em(-2 * 1440), AGORA.getTime()), "há 2 dias");
  assert.equal(haQuanto(null), "ainda não");
});

test("S1: falha de 24 h ou mais usa a mesma frase («nova tentativa») e conta como longa", () => {
  assert.equal(falhaLonga({ falha_desde: em(-60 * 25) }, AGORA), true);
  assert.equal(falhaLonga({ falha_desde: em(-60 * 23) }, AGORA), false);
  assert.equal(falhaLonga({}, AGORA), false);
  assert.equal(textoFalha({ falha_desde: em(-60 * 72), proxima_leitura_em: em(120) }, AGORA), "Falha há 3 dias · nova tentativa às 14:10");
  assert.equal(textoFalha({ falha_desde: em(-60 * 72), proxima_leitura_em: em(-2) }, AGORA), "Falha há 3 dias · nova tentativa em breve");
});

const casa = (_id, nome, m = {}) => ({ _id, nome, ...m });

test("casas homónimas: nome único fica como está", () => {
  const n = nomesDistintos([casa("1", "Casa Azul"), casa("2", "Estoril Villa", { morada_localidade: "Estoril" })]);
  assert.equal(n.get("1"), "Casa Azul");
  assert.equal(n.get("2"), "Estoril Villa");
});

test("casas homónimas em cidades diferentes: (Localidade)", () => {
  const n = nomesDistintos([
    casa("a", "Casa Azul", { morada_rua: "Rua do Ouro 10", morada_localidade: "Lisboa" }),
    casa("b", "casa  azul ", { morada_rua: "Rua das Flores 5", morada_localidade: "Porto" }),
  ]);
  assert.equal(n.get("a"), "Casa Azul (Lisboa)");
  assert.equal(n.get("b"), "casa  azul (Porto)");
});

test("casas homónimas na mesma cidade: rua curta (sem o número da porta)", () => {
  const n = nomesDistintos([
    casa("a", "Apartamento T1 Baixa", { morada_rua: "Rua Augusta 100", morada_localidade: "Lisboa" }),
    casa("b", "Apartamento T1 Baixa", { morada_rua: "Rua do Ouro 10", morada_localidade: "Lisboa" }),
    casa("c", "Apartamento T1 Baixa", { morada_rua: "Rua da Prata 3", morada_localidade: "Porto" }),
  ]);
  assert.equal(n.get("a"), "Apartamento T1 Baixa (Rua Augusta)");
  assert.equal(n.get("b"), "Apartamento T1 Baixa (Rua do Ouro)");
  assert.equal(n.get("c"), "Apartamento T1 Baixa (Porto)");
});

test("casas homónimas na mesma rua: rua com número; se nem assim, (1), (2) por _id", () => {
  const n = nomesDistintos([
    casa("a", "Loft", { morada_rua: "Rua Augusta 100", morada_localidade: "Lisboa" }),
    casa("b", "Loft", { morada_rua: "Rua Augusta 120", morada_localidade: "Lisboa" }),
  ]);
  assert.equal(n.get("a"), "Loft (Rua Augusta 100)");
  assert.equal(n.get("b"), "Loft (Rua Augusta 120)");
  const m = nomesDistintos([
    casa("z", "Loft", { morada_rua: "Rua Augusta 100", morada_localidade: "Lisboa" }),
    casa("y", "Loft", { morada_rua: "Rua Augusta 100", morada_localidade: "Lisboa" }),
  ]);
  assert.equal(m.get("y"), "Loft (1)");
  assert.equal(m.get("z"), "Loft (2)");
});

test("casas homónimas sem morada: (1), (2) por ordem estável; misturadas com casas com morada", () => {
  const n = nomesDistintos([casa("b", "Sem Morada"), casa("a", "Sem Morada"), casa("c", "Sem Morada", { morada_localidade: "Faro" })]);
  assert.equal(n.get("c"), "Sem Morada (Faro)");
  assert.equal(n.get("a"), "Sem Morada (1)");
  assert.equal(n.get("b"), "Sem Morada (2)");
  // a ordem não depende da ordem da lista
  assert.equal(nomesDistintos([casa("a", "Sem Morada"), casa("b", "Sem Morada")]).get("a"), "Sem Morada (1)");
  // compatível com a morada_curta antiga «Rua, Localidade»
  assert.equal(nomesDistintos([casa("1", "X", { morada_curta: "Rua A 1, Porto" }), casa("2", "X", { morada_curta: "Rua B 2, Lisboa" })]).get("1"), "X (Porto)");
});

test("S11: seletor com a desambiguação antes do canal ligado (homónimas com o mesmo canal ficam diferentes)", () => {
  const c = (id, nome, o = {}) => ({ _id: id, nome, smoobu: false, airbnb: null, booking: null, outros: [], ...o });
  const r = rotulosDasCasas([
    c("1", "Baixa Pombalina", { airbnb: { canal_texto: "Airbnb" } }),
    c("2", "Alfama", { smoobu: true }),
    c("3", "Chiado"),
    c("4", "Graça", { airbnb: {}, booking: {} }),
    c("5", "Sé", { booking: {} }),
  ]);
  assert.equal(r.get("1"), "Baixa Pombalina · Airbnb");
  assert.equal(r.get("2"), "Alfama · Smoobu");
  assert.equal(r.get("3"), "Chiado");
  assert.equal(r.get("4"), "Graça · Airbnb + Booking");
  assert.equal(r.get("5"), "Sé · Booking");
  const d = rotulosDasCasas([
    c("a", "Apartamento T1 Baixa", { morada_rua: "Rua Augusta 100", morada_localidade: "Lisboa", airbnb: {}, booking: {} }),
    c("b", "Apartamento T1 Baixa", { morada_rua: "Rua do Ouro 10", morada_localidade: "Lisboa" }),
  ]);
  assert.equal(d.get("a"), "Apartamento T1 Baixa (Rua Augusta) · Airbnb + Booking");
  assert.equal(d.get("b"), "Apartamento T1 Baixa (Rua do Ouro)");
  const h = rotulosDasCasas([
    c("x", "Casa Azul", { morada_rua: "Rua Augusta 1", airbnb: {}, booking: {} }),
    c("y", "Casa Azul", { morada_rua: "Rua do Ouro 2", airbnb: {}, booking: {} }),
  ]);
  assert.equal(h.get("x"), "Casa Azul (Rua Augusta) · Airbnb + Booking");
  assert.equal(h.get("y"), "Casa Azul (Rua do Ouro) · Airbnb + Booking");
});
