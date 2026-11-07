/**
 * Conflitos de concorrência (dois pedidos a alterar o mesmo documento ao mesmo tempo):
 * o Mongoose lança VersionError no save() do segundo. Devolve-se 409 claro em vez de 500.
 */
const MSG_CONFLITO = 'A limpeza acabou de ser alterada; atualiza a página.';

function ehConflitoConcorrencia(err) {
  return !!err && (err.name === 'VersionError' || err.name === 'DocumentNotFoundError');
}

/** Responde 409 se `err` for um conflito de concorrência; devolve true se respondeu. */
function responderSeConflito(res, err, mensagem = MSG_CONFLITO) {
  if (!ehConflitoConcorrencia(err)) return false;
  res.status(409).json({ erro: mensagem, codigo: 'CONFLITO_CONCORRENCIA' });
  return true;
}

module.exports = { ehConflitoConcorrencia, responderSeConflito, MSG_CONFLITO };
