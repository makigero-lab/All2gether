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
function registarDiaMudadoPeloGestor(tarefa, utilizador) {
  if (!tarefa || tarefa.data_saida_desconhecida !== true) return false;
  const dia = diaDe(tarefa.data);
  if (!dia) return false;
  tarefa.dia_mudado_pelo_gestor = {
    dia,
    por: (utilizador && (utilizador._id || utilizador.id)) || null,
    em: new Date(),
  };
  return true;
}

module.exports = { registarDiaMudadoPeloGestor, diaDe };
