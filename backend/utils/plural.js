/**
 * «1 tarefa desatribuída» / «2 tarefas desatribuídas»: singular e plural reais, nunca «tarefa(s)».
 * Uso: pl(n, 'tarefa desatribuída', 'tarefas desatribuídas').
 */
function pl(n, singular, plural) {
  return `${n} ${Number(n) === 1 ? singular : plural}`;
}

module.exports = { pl };
