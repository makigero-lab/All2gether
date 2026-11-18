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
  // «Portugal» / «PT» no fim é o país, nunca a cidade.
  const texto = morada.replace(/\s+/g, ' ').trim().replace(/[,\s]+(portugal|pt)\s*$/i, '');
  if (!texto) return vazio;

  const limpar = (s) => String(s || '').replace(/^[\s,;-]+|[\s,;-]+$/g, '').trim();
  const m = RE_CP.exec(texto);
  if (m) {
    const antes = limpar(texto.slice(0, m.index));
    // Cidade: só a 1.ª parte depois do CP (até à vírgula): «2700-418 Amadora, Portugal».
    const depois = limpar(limpar(texto.slice(m.index + m[0].length)).split(',')[0]);
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
  // Sem CP, a última parte só é cidade se não parecer andar/fração («R/C Esq», «3º», «Lote 4»).
  if (partes.length > 1 && !pareceAndar(partes[partes.length - 1])) {
    const cidade = partes.pop();
    return { rua: partes.join(', '), codigo_postal: '', cidade };
  }
  return { rua: limpar(texto), codigo_postal: '', cidade: '' };
}

const RE_ANDAR = /(^|[\s/])(r\/c|rc|res-do-chao|esq|esquerdo|dto|dir|direito|bloco|bl|lote|fra[cç][aã]o|edif[ií]cio|ed|andar|cave|loja)\b|\d\s*[ºo°ª](?![a-zà-ú])|^\d+\s*(esq|dto|dir)?\.?$/i;
/** «R/C Esq», «3º Dto», «Bloco B», «Lote 4», «Fração A», «Edifício X». */
function pareceAndar(segmento) {
  return RE_ANDAR.test(String(segmento || '').trim());
}

const MAX_MORADA = 300;
/**
 * Valida a morada recebida na API: string, trim, até 300 caracteres,
 * com pelo menos uma letra ou número (rejeita «,,,»).
 * @returns {{ ok: true, valor: string } | { ok: false, erro: string }}
 */
function validarMorada(valor) {
  if (typeof valor !== 'string') return { ok: false, erro: 'A morada tem de ser um texto.' };
  const v = valor.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(v)) return { ok: false, erro: 'Indica uma morada válida (rua, número, código postal e localidade).' };
  if (v.length > MAX_MORADA) return { ok: false, erro: `A morada é demasiado longa (máximo ${MAX_MORADA} caracteres).` };
  return { ok: true, valor: v };
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

module.exports = { validarMorada, pareceAndar, MAX_MORADA, textoMorada, derivarMoradaEstruturada, expandirAbreviaturas, semCodigoPostal };
