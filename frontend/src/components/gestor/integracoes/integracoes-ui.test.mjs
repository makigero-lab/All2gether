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
