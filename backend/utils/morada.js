/**
 * Morada única — All2gether
 *
 * A morada é UM só texto (o que o gestor cola do Google Maps). A estrutura
 * (rua / código postal / cidade) é derivada daqui para quem a lê
 * (rótulos de casas homónimas, listas, fecho automático...).
 */

const RE_CP = /\b\d{4}-\d{3}\b/;

/**
 * Deriva { rua, codigo_postal, cidade } a partir da morada em texto.
 *  - código postal: primeiro \d{4}-\d{3};
 *  - cidade: o que vem depois do código postal; sem CP, a última parte
 *    depois de vírgula (se houver mais de uma parte);
 *  - rua: o resto.
 */
function derivarMoradaEstruturada(morada) {
  const vazio = { rua: '', codigo_postal: '', cidade: '' };
  if (typeof morada !== 'string') return vazio;
  const texto = morada.replace(/\s+/g, ' ').trim();
  if (!texto) return vazio;

  const limpar = (s) => String(s || '').replace(/^[\s,;-]+|[\s,;-]+$/g, '').trim();
  const m = RE_CP.exec(texto);
  if (m) {
    const antes = limpar(texto.slice(0, m.index));
    const depois = limpar(texto.slice(m.index + m[0].length));
    if (depois) return { rua: antes, codigo_postal: m[0], cidade: depois };
    // «Rua X, Amadora, 2700-418»: a cidade é a última parte antes do CP.
    const partes = antes.split(',').map((x) => x.trim()).filter(Boolean);
    if (partes.length > 1) {
      const cidade = partes.pop();
      return { rua: partes.join(', '), codigo_postal: m[0], cidade };
    }
    return { rua: antes, codigo_postal: m[0], cidade: '' };
  }
  const partes = texto.split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length > 1) {
    const cidade = partes.pop();
    return { rua: partes.join(', '), codigo_postal: '', cidade };
  }
  return { rua: limpar(texto), codigo_postal: '', cidade: '' };
}

/**
 * Morada em texto único a partir do que o cliente enviou: `morada` (preferida)
 * ou, para clientes antigos, `morada_estruturada` concatenada. '' se nada.
 */
function textoMorada(morada, estruturada) {
  if (typeof morada === 'string' && morada.trim()) return morada.replace(/\s+/g, ' ').trim();
  if (estruturada && typeof estruturada === 'object' && typeof estruturada.rua === 'string' && estruturada.rua.trim()) {
    return [estruturada.rua, estruturada.codigo_postal, estruturada.cidade]
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

const ABREVIATURAS = [
  [/(^|[\s,(])Av(?:ª|\.)?(?=\s)/gi, 'Avenida'],
  [/(^|[\s,(])R\.(?=\s)/gi, 'Rua'],
  [/(^|[\s,(])P(?:ç|c)a?\.(?=\s)/gi, 'Praça'],
  [/(^|[\s,(])Lg\.(?=\s)/gi, 'Largo'],
  [/(^|[\s,(])Tv\.(?=\s)/gi, 'Travessa'],
  [/(^|[\s,(])Trav\.(?=\s)/gi, 'Travessa'],
  [/(^|[\s,(])Estr\.(?=\s)/gi, 'Estrada'],
  [/(^|[\s,(])Al\.(?=\s)/gi, 'Alameda'],
  [/(^|[\s,(])Calç\.(?=\s)/gi, 'Calçada'],
  [/(^|[\s,(])Bc\.(?=\s)/gi, 'Beco'],
];

/** Expande abreviaturas comuns de arruamentos portugueses. */
function expandirAbreviaturas(morada) {
  let t = String(morada || '');
  for (const [re, plena] of ABREVIATURAS) t = t.replace(re, (_, pre) => `${pre}${plena}`);
  return t;
}

/** Remove o código postal (e vírgulas sobrantes) da morada. */
function semCodigoPostal(morada) {
  return String(morada || '')
    .replace(RE_CP, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

module.exports = { textoMorada, derivarMoradaEstruturada, expandirAbreviaturas, semCodigoPostal };
