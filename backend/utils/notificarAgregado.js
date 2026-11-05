/**
 * Notificações agregadas por pessoa — All2gether.
 *
 * Um "Gravar" do parceiro envia várias linhas, uma de cada vez (pedidos
 * separados). Para cada pessoa não receber uma notificação por linha,
 * as mensagens acumulam-se e saem juntas quando deixa de haver novidades
 * durante JANELA_MS (ou ao fim de MAXIMO_MS). Em memória: se o servidor
 * reiniciar nesse intervalo, as pendentes perdem-se (são avisos, não dados).
 */
const { notificarUtilizador } = require('./notificar');

const JANELA_MS = Number(process.env.NOTIF_AGREGADA_JANELA_MS) || 8000;
const MAXIMO_MS = Number(process.env.NOTIF_AGREGADA_MAXIMO_MS) || 30000;

// chave `${utilizadorId}|${tipo}` -> { utilizadorId, tipo, linhas: [], timer, inicio, titulo, url }
const pendentes = new Map();

async function enviar(entrada) {
  const n = entrada.linhas.length;
  if (n === 0) return;
  const corpo = n === 1 ? entrada.linhas[0] : `${n} alterações: ${entrada.linhas.join('; ')}`.slice(0, 300);
  await notificarUtilizador(entrada.utilizadorId, entrada.titulo, corpo, entrada.url, {
    criarInApp: true,
    tipo: entrada.tipo,
    mensagem: `${entrada.titulo}: ${corpo}`,
  });
}

/**
 * Acumula uma linha para a pessoa. `tipo` é o tipo da Notificacao (enum do modelo) e separa grupos.
 */
function agregarNotificacao(utilizadorId, tipo, titulo, linha, url = '/staff') {
  const chave = `${utilizadorId}|${tipo}`;
  let e = pendentes.get(chave);
  if (!e) {
    e = { utilizadorId: String(utilizadorId), tipo, titulo, url, linhas: [], timer: null, inicio: Date.now() };
    pendentes.set(chave, e);
  }
  e.linhas.push(linha);
  if (e.timer) clearTimeout(e.timer);
  const restante = Math.max(0, MAXIMO_MS - (Date.now() - e.inicio));
  e.timer = setTimeout(() => {
    pendentes.delete(chave);
    enviar(e).catch(() => {});
  }, Math.min(JANELA_MS, restante));
  if (e.timer.unref) e.timer.unref();
}

/** Envia já tudo o que está pendente (usado nos testes e no encerramento). */
async function enviarPendentesAgora() {
  const todas = [...pendentes.values()];
  pendentes.clear();
  for (const e of todas) {
    if (e.timer) clearTimeout(e.timer);
    await enviar(e);
  }
}

module.exports = { agregarNotificacao, enviarPendentesAgora };
