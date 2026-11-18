/**
 * Redação de segredos em mensagens de log — All2gether.
 *
 * As mensagens de erro de fetch/Google podem trazer o URL do pedido (com
 * `key=...`) ou o próprio valor da chave. Antes de logar, o valor da chave e
 * qualquer parâmetro `key=` passam a «***».
 */

/** Substitui a chave (valor exato) e `key=...` por «***». */
function redigir(texto, chaves = [process.env.GOOGLE_MAPS_API_KEY]) {
  let t = String(texto);
  for (const k of chaves) {
    const v = typeof k === 'string' ? k.trim() : '';
    if (v.length >= 4) t = t.split(v).join('***');
  }
  return t.replace(/(\bkey=)[^&\s"')]+/gi, '$1***');
}

const redigirArg = (a) => (typeof a === 'string' ? redigir(a) : a);

/** console.warn/error que redige strings (os testes continuam a poder espiar o console). */
const logSeguro = {
  warn: (...args) => console.warn(...args.map(redigirArg)),
  error: (...args) => console.error(...args.map(redigirArg)),
};

module.exports = { redigir, logSeguro };
