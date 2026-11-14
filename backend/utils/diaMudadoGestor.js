/**
 * Limpeza provisória (reserva do Smoobu sem data de saída): se o gestor lhe muda o dia, atribui ou reatribui
 * enquanto a marca `data_saida_desconhecida` está ligada, guarda o dia que ele pôs e quem foi. A marca
 * provisória NÃO se tira. Quando chega a data real, a do Smoobu manda; se for diferente do dia que o gestor
 * pôs, ele recebe um aviso (ver smoobuController.atualizarTarefaPorReserva).
 */

/** Dia (AAAA-MM-DD) de uma data guardada (UTC, como o resto do sistema compara dias de limpeza). */
function diaDe(data) {
  const d = new Date(data);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Regista no documento (sem guardar) o dia atual da limpeza como escolha do gestor, só se a data for provisória.
 * Chamar depois de definir o dia/pessoa e antes do `save()`.
 * @returns {boolean} true se registou.
 */
function registarDiaMudadoPeloGestor(tarefa, utilizador, diaAntes = undefined) {
  if (!tarefa || tarefa.data_saida_desconhecida !== true) return false;
  const dia = diaDe(tarefa.data);
  if (!dia) return false;
  // `so_pessoa`: o gestor só atribuiu/reatribuiu a pessoa e o dia ficou o que já era (só muda o texto do aviso A5).
  // Fica a false assim que o gestor muda mesmo o dia (ou se `diaAntes` não vem: mudar dia pede sempre o dia).
  const jaMudouDia = !!(tarefa.dia_mudado_pelo_gestor && tarefa.dia_mudado_pelo_gestor.dia && tarefa.dia_mudado_pelo_gestor.so_pessoa === false);
  const soPessoa = !jaMudouDia && diaAntes !== undefined && diaAntes === dia;
  tarefa.dia_mudado_pelo_gestor = {
    dia,
    so_pessoa: soPessoa,
    por: (utilizador && (utilizador._id || utilizador.id)) || null,
    em: new Date(),
  };
  return true;
}

/**
 * A hora/dia desta limpeza foi posta à mão pelo gestor (e por isso a automação não lhe mexe)?
 * Sinais que existem hoje: «mudar dia/hora» (`data_ajustada_gestor`), dia posto numa data provisória
 * (`dia_mudado_pelo_gestor`) e limpeza criada à mão (`origem: 'manual'`). Atribuir pessoa a uma limpeza que já
 * tinha hora NÃO deixa marca (a hora fica, mas não se sabe se era a do motor).
 */
function eMarcadaPeloGestor(t) {
  if (!t) return false;
  return !!(t.data_ajustada_gestor || (t.dia_mudado_pelo_gestor && t.dia_mudado_pelo_gestor.dia) || t.origem === 'manual');
}

module.exports = { registarDiaMudadoPeloGestor, diaDe, eMarcadaPeloGestor };
