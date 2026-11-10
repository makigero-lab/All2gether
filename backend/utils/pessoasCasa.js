/**
 * Pessoas necessárias por defeito numa casa (decisão do utilizador, 2026-11-09):
 * casas de cliente particular ou com tipologia T2 ou maior levam 2 pessoas; as outras 1.
 * O gestor pode pôr outro valor à mão; esse valor fica marcado como manual e a regra
 * deixa de lhe mexer. Casas antigas sem a marca: um valor diferente de 1 conta como manual.
 */

/** Pessoas que a regra dá para esta casa. */
function staffPorDefeito(p) {
  const t = p && p.tipologia;
  return (p && p.cliente_particular === true) || (Number.isInteger(t) && t >= 2) ? 2 : 1;
}

/** O nº de pessoas foi posto à mão (a regra não lhe mexe)? */
function staffManual(p) {
  if (!p) return false;
  if (typeof p.staff_necessario_manual === 'boolean') return p.staff_necessario_manual;
  return (Number(p.staff_necessario) || 1) !== 1;
}

/**
 * Lê `tipologia` (null/'' = desconhecida, ou inteiro 0 a 20) e `cliente_particular` do corpo.
 * @returns {{ erro?: string, set: object }}
 */
function lerCamposCasa(body) {
  const set = {};
  if (body && body.tipologia !== undefined) {
    const v = body.tipologia;
    if (v === null || v === '') set.tipologia = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 20) return { erro: 'tipologia deve ser um número inteiro de 0 a 20 (T0, T1, T2...) ou vazio.', set };
      set.tipologia = n;
    }
  }
  if (body && body.cliente_particular !== undefined) {
    if (typeof body.cliente_particular !== 'boolean') return { erro: 'cliente_particular deve ser verdadeiro ou falso.', set };
    set.cliente_particular = body.cliente_particular;
  }
  return { set };
}

/**
 * Decide o nº de pessoas a gravar.
 * @param {object} casa - valores finais (tipologia, cliente_particular, staff_necessario e marca atuais)
 * @param {number|undefined} enviado - staff_necessario enviado (já validado) ou undefined
 * @returns {{ staff_necessario: number, staff_necessario_manual: boolean }}
 */
function decidirPessoas(casa, enviado) {
  const regra = staffPorDefeito(casa);
  if (enviado !== undefined && enviado !== null) {
    const n = Number(enviado);
    return { staff_necessario: n, staff_necessario_manual: n !== regra };
  }
  if (staffManual(casa)) {
    return { staff_necessario: Number(casa.staff_necessario) || 1, staff_necessario_manual: true };
  }
  return { staff_necessario: regra, staff_necessario_manual: false };
}

module.exports = { staffPorDefeito, staffManual, lerCamposCasa, decidirPessoas };
