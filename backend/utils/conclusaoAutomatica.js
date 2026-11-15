/**
 * Fecho automático das limpezas — regras partilhadas (All2gether)
 *
 * Às 20:00 (Lisboa) o sistema passa a 'concluida' as limpezas 'em_curso' com pessoa que ninguém fechou
 * (ver jobs/fechoAutomatico.js). Isso NÃO prova que a limpeza foi feita: `conclusao_origem: 'automatica'`.
 * Se a pessoa a confirmar depois (fotos/notas + «Concluir»), passa a `conclusao_origem: 'staff'` com a
 * hora real da confirmação e `confirmada_depois_em`; `fechada_automaticamente_em` mantém-se.
 * Tudo o que mostra «hora de conclusão», conta tempo real ou avisa o proprietário usa estes helpers.
 */

/** Fechada pelo sistema e ainda sem confirmação da equipa. */
function fechadaAutomaticamente(t) {
  return !!t && t.estado === 'concluida' && t.conclusao_origem === 'automatica';
}

/** Fechada pelo sistema e confirmada pela equipa mais tarde (a hora da confirmação não é a do trabalho). */
function confirmadaDepois(t) {
  return !!t && t.estado === 'concluida' && t.conclusao_origem !== 'automatica' && !!t.confirmada_depois_em;
}

/**
 * Hora de conclusão REAL (a pessoa carregou em «Concluir» durante o trabalho, ou o gestor fechou), ou null.
 * Fechada pelo sistema: `concluida_em` é só a hora do fecho. Confirmada depois: é a hora da confirmação.
 */
function horaConclusaoReal(t) {
  if (!t || fechadaAutomaticamente(t) || confirmadaDepois(t)) return null;
  return t.hora_conclusao || t.concluida_em || null;
}

module.exports = { fechadaAutomaticamente, confirmadaDepois, horaConclusaoReal };
