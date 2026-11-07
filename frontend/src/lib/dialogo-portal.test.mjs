// Regressão: o diálogo «Não consegui começar» não fechava ao carregar em «Avisar o gestor».
// Causa: o Dialog ficava dentro do cartão (active:scale = transform) e o `fixed` deixava de ser relativo
// ao ecrã, por isso o painel saltava ao carregar e o clique falhava. O Dialog tem de ir em portal para o
// body, e o botão tem de fechar o diálogo (setAberto(false)) antes de avisar o pai.
// (Não há ambiente de componentes no projeto: verifica-se o código; o comportamento real foi confirmado
// no browser com cliques reais, a 360 px.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialog = readFileSync(new URL("../components/ui/dialog.tsx", import.meta.url), "utf8");
const comecar = readFileSync(new URL("../components/staff/comecar-limpeza.tsx", import.meta.url), "utf8");

test("Dialog renderiza em portal no body (imune a transform dos pais)", () => {
  assert.match(dialog, /import \{ createPortal \} from "react-dom"/);
  assert.match(dialog, /createPortal\(\s*<div className=\{?"?[^>]*fixed inset-0 z-50[\s\S]*?document\.body\s*\)/);
});

test("«Não consegui começar»: Avisar o gestor fecha o diálogo, limpa o formulário e avisa o pai", () => {
  const fn = comecar.slice(comecar.indexOf("async function enviar()"));
  const corpo = fn.slice(0, fn.indexOf("return ("));
  const iPost = corpo.indexOf("nao-consegui");
  const iFecha = corpo.indexOf("setAberto(false)");
  const iFeito = corpo.indexOf("onFeito()");
  assert.ok(iPost > -1 && iFecha > iPost && iFeito > iFecha, "ordem: pedido, fechar, avisar o pai");
  assert.match(corpo, /setMotivo\(""\)/);
  assert.match(corpo, /setNota\(""\)/);
});
