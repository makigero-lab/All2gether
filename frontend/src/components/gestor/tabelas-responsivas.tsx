"use client";

import { useEffect } from "react";

/**
 * Prepara as tabelas `table.rt` para o modo cartão (abaixo de 760 px, ver globals.css): copia o texto
 * de cada <th> para `data-l` nas células e, se o <th> tiver `data-k`, a prioridade (`--k`) das células.
 * Observa o DOM porque as listas carregam e mudam depois de montar.
 */
export function TabelasResponsivas() {
  useEffect(() => {
    const preparar = (t: HTMLTableElement) => {
      const ths = Array.from(t.querySelectorAll<HTMLTableCellElement>("thead th"));
      if (ths.length === 0) return;
      const rotulos = ths.map((th) => (th.textContent ?? "").trim());
      const ks = ths.map((th) => th.dataset.k ?? "");
      t.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((tr) => {
        Array.from(tr.children).forEach((c, i) => {
          const td = c as HTMLElement;
          if (i === 0) return;
          const l = rotulos[i] ?? "";
          if (td.dataset.l !== l) td.dataset.l = l;
          const k = ks[i] ?? "";
          if (k !== "" && td.dataset.k !== k) {
            td.dataset.k = k;
            td.style.setProperty("--k", k);
          }
        });
      });
    };
    const todas = () => document.querySelectorAll<HTMLTableElement>("table.rt").forEach(preparar);
    todas();
    let agendado = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(agendado);
      agendado = requestAnimationFrame(todas);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(agendado);
    };
  }, []);
  return null;
}
