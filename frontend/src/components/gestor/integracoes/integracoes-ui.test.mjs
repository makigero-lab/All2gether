// Regressões da revisão do @UX e do @Tester à área Integrações (não há ambiente de componentes: verifica-se o código;
// o comportamento real foi confirmado no browser a 390x844 e 1366x768 com ligações a um iCal falso local).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const dialog = ler("../../ui/dialog.tsx");
const assistente = ler("./assistente-ligar.tsx");
const matriz = ler("./matriz-proprietario.tsx");
const porConfirmar = ler("./por-confirmar.tsx");
const vista = ler("./vista-geral.tsx");
const pagina = ler("../../../app/gestor/integracoes/page.tsx");
const acordo = ler("../../parceiro/acordo-dados.tsx");
const parceiroPorConfirmar = ler("../../parceiro/reservas-por-confirmar.tsx");
const calendariosCasa = ler("../../parceiro/calendarios-casa.tsx");
const confirmar = ler("../../ui/confirmar-dialog.tsx");
const paginaCalendariosParceiro = ler("../../../app/parceiro/calendarios/page.tsx");

test("D1: o corpo do diálogo faz scroll e o rodapé fica sempre visível (todos os diálogos do padrão)", () => {
  const corpo = dialog.slice(dialog.indexOf("export function DialogContent"), dialog.indexOf("export function DialogFooter"));
  assert.match(corpo, /min-h-0 flex-1 overflow-y-auto/);
  const rodape = dialog.slice(dialog.indexOf("export function DialogFooter"));
  assert.match(rodape, /sticky bottom-0/);
  assert.match(rodape, /bg-card/);
  // o painel é uma coluna (cabeçalho, corpo, rodapé) com altura máxima, com e sem ecrã inteiro
  assert.match(dialog, /relative z-10 flex w-full[^"]*max-h-\[90vh\][^"]*flex-col/);
  assert.doesNotMatch(dialog, /ecraInteiroNoTelemovel && "flex flex-col overflow-hidden/);
});

test("D4: colar o link e trocar de canal NÃO testam; só o clique em «Testar ligação»", () => {
  assert.doesNotMatch(assistente, /onPaste/);
  const troca = assistente.slice(assistente.indexOf("const trocarCanal"), assistente.indexOf("const bloqueado"));
  assert.doesNotMatch(troca, /testar/);
  const usos = assistente.match(/testar\(\)/g) ?? [];
  assert.equal(usos.length, 1, "o teste só é chamado a partir do botão");
  assert.match(assistente, /onClick=\{\(\) => testar\(\)\}/);
});

test("D3/D9: canal errado não mostra o resumo de sucesso; «muitos novos» mostra Aceitar e não «0 limpezas novas»", () => {
  assert.match(assistente, /teste\?\.ok && !canalErrado/);
  assert.match(assistente, /fraseDoTeste\(teste\)/);
  assert.match(assistente, /feito\.tipo === "validacao"/);
  assert.match(assistente, /A criar as limpezas…/);
  assert.doesNotMatch(assistente, /limpezas novas/);
});

test("D2: no telemóvel a matriz passa a uma lista por casa, uma linha por canal", () => {
  assert.match(matriz, /max-width: 639px/);
  assert.match(matriz, /data-matriz-lista/);
  const lista = matriz.slice(matriz.indexOf("data-matriz-lista"), matriz.indexOf("data-matriz>"));
  for (const t of ["Airbnb", "Booking.com", "Smoobu / outro sistema"]) assert.ok(lista.includes(t), t);
});

test("S3: a regra «uma só fonte» é dita uma vez na matriz e na lista; o cadeado só onde há bloqueio", () => {
  assert.match(matriz, /REGRA_UMA_FONTE/);
  assert.match(vista, /REGRA_UMA_FONTE/);
  assert.doesNotMatch(matriz, /uma só fonte por casa/);
  assert.match(matriz, /o Smoobu não pode coexistir com calendários/);
});

test("D5/D6: erro passageiro dá «Tentar agora» (não «Corrigir»); «Atualizar» e «Corrigir link» distinguem-se", () => {
  assert.match(matriz, /Tentar agora/);
  assert.match(matriz, /Corrigir link/);
  assert.match(matriz, /erro && erro !== c\.erro\?\.mensagem/);
  assert.match(vista, /e\.temporario \|\| e\.codigo === "muitos_novos" \? "Ver" : "Corrigir"/);
});

test("D8: o lote usa blocos, mostra progresso, não perde o erro e deixa o resultado num aviso fixo", () => {
  assert.match(porConfirmar, /enviarEmBlocos/);
  assert.match(porConfirmar, /sticky top-0/);
  assert.match(porConfirmar, /data-resultado-lote/);
  const carregar = porConfirmar.slice(porConfirmar.indexOf("const carregar = useCallback"), porConfirmar.indexOf("useEffect(() => { void carregar()"));
  assert.doesNotMatch(carregar, /setErro\(null\)/, "carregar() não apaga a mensagem de erro");
  assert.match(porConfirmar, /Carregar mais/);
  assert.match(porConfirmar, /textoCorte/);
});

test("L1/L3: o painel conta ligações e só de proprietários ativos (como o selo)", () => {
  assert.match(vista, /p\.ativo && p\.n_erros > 0/);
  assert.match(vista, /Precisam de atenção: /);
  assert.match(vista, /linhasErro\.map/, "uma linha por ligação, com o seu botão (Aceitar nas que esperam validação)");
  assert.match(vista, /e\.codigo === "muitos_novos"/);
});

test("L6/S6: sem <main> aninhado e o selo do separador tem aria-label", () => {
  assert.doesNotMatch(pagina, /<main/);
  assert.match(pagina, /aria-label=\{s\.leitor\(s\.n\)\}/);
});

test("M5: com o acordo fora de vigor o portal não mostra o texto nem o botão de aceitar", () => {
  assert.match(acordo, /!a\.obrigatorio \|\| !a\.texto/);
  assert.doesNotMatch(acordo, /Pode lê-lo e aceitá-lo já/);
});

test("S5: «pode ter mudado» com a dica dos menus", () => {
  assert.match(assistente, /pode ter mudado/);
  assert.match(assistente, /Os menus do Airbnb\/Booking mudam às vezes; se não encontrares, diz-nos\./);
  assert.doesNotMatch(assistente, /menu por confirmar/);
});

test("S1: o tempo da falha aparece na matriz, no painel «Precisam de atenção» e na vista do proprietário", () => {
  assert.match(matriz, /textoFalha\(c\.erro\)/);
  assert.match(vista, /textoFalha\(e\)/);
  assert.match(vista, /e\.codigo !== "muitos_novos"/);
  assert.match(calendariosCasa, /textoFalha\(f\)/);
});

test("S4: filtro rápido, ordem por chegada, ano e plataforma, e confirmação antes de marcar bloqueios em lote", () => {
  assert.match(porConfirmar, /useState<FiltroChegada>\("todas"\)/);
  assert.match(porConfirmar, /data-filtro-chegada/);
  assert.match(porConfirmar, /ordenarPorChegada\(lista\)/);
  assert.match(porConfirmar, /periodoComAno\(x\)/);
  assert.match(porConfirmar, /data-plataforma/);
  assert.match(porConfirmar, /textoLongosDeFora\(longos\.length\)/);
  // nenhum botão de bloqueio em lote age sem passar por pedirBloqueio, e nunca window.confirm
  assert.doesNotMatch(porConfirmar, /window\.confirm|[^a-zA-Z]confirm\(/);
  assert.doesNotMatch(porConfirmar, /onClick=\{\(\) => decidir\([^)]*"bloqueio"\)\}/);
  assert.ok((porConfirmar.match(/pedirBloqueio\(/g) ?? []).length >= 3);
  assert.match(porConfirmar, /<ConfirmarDialog/);
  assert.match(parceiroPorConfirmar, /<ConfirmarDialog/);
  assert.match(parceiroPorConfirmar, /periodoComAno\(x\)/);
  assert.doesNotMatch(parceiroPorConfirmar, /onClick=\{\(\) => bloquearTodos\(/);
  assert.match(confirmar, /from "@\/components\/ui\/dialog"/);
  assert.match(confirmar, /data-autofocus/);
});

test("S8: o diálogo foca o campo marcado com data-autofocus; o assistente marca Casa, canal ou Link; o foco volta ao botão ao fechar", () => {
  assert.match(dialog, /querySelector<HTMLElement>\("\[data-autofocus\]"\) \?\? painel/);
  assert.match(dialog, /anterior\?\.focus\?\.\(\)/);
  assert.match(assistente, /data-autofocus=\{focoCasa \? "" : undefined\}/);
  assert.match(assistente, /data-autofocus=\{focoLink \? "" : undefined\}/);
  assert.match(assistente, /focoCanal === k/);
  assert.match(dialog, /e\.key === "Tab"/); // o foco continua preso no diálogo
});

test("S11: as opções do seletor «Casa» usam o rótulo com o canal ligado", () => {
  assert.match(assistente, /rotulosDasCasas\(casasLivres\)/);
  assert.match(assistente, /rotulos\.get\(c\._id\)/);
});

test("ronda 2: a página real do proprietário mostra o tempo da falha; casas homónimas não se fundem; só a barra de ações é fixa", () => {
  assert.match(paginaCalendariosParceiro, /textoFalha\(f\)/);
  assert.match(paginaCalendariosParceiro, /falha_desde\?: string \| null/);
  assert.match(porConfirmar, /g\.casas\.set\(x\.propriedade\._id/);
  assert.match(porConfirmar, /key=\{c\.casaId\}/);
  assert.match(matriz, /nomesDistintos\(p\.casas\)/);
  assert.match(parceiroPorConfirmar, /nomesDistintos\(/);
  // o bloco sticky só tem a barra de ações: filtro e aviso dos 30 noites ficam fora dele
  const sticky = porConfirmar.slice(porConfirmar.indexOf("data-barra-lote"), porConfirmar.indexOf("{corte && ("));
  assert.doesNotMatch(sticky, /data-filtro-chegada|data-longos-fora|Escolher todos/);
  assert.match(porConfirmar, /data-em-curso/);
  assert.match(confirmar, /variant=\{destrutivo \? "destructive" : "default"\}/);
  assert.match(porConfirmar, /<ConfirmarDialog aberto destrutivo/);
});

test("ronda 3: rótulo único para casas homónimas em todos os ecrãs; botões do calendário maiores no pc", () => {
  assert.match(paginaCalendariosParceiro, /nomesDistintos\(todas\)/);
  assert.match(porConfirmar, /Escolher a casa"\} \$\{nomes\.get\(c\.casaId\)/);
  assert.match(porConfirmar, /nomes\.get\(c\.casaId\) \?\? c\.casa/);
  const propriedades = ler("../../../app/gestor/propriedades/page.tsx");
  const calendario = propriedades.slice(propriedades.indexOf("Calendários externos de ${p.nome}") - 400, propriedades.indexOf("Calendários externos de ${p.nome}"));
  assert.match(calendario, /h-9 w-9/);
  assert.doesNotMatch(calendario, /h-8 w-8/);
  assert.doesNotMatch(porConfirmar, /nova tentativa|a tentar de novo/);
});
