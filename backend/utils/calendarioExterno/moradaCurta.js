/**
 * Partes curtas da morada de uma casa, para distinguir casas com o mesmo nome:
 * rua (tal como foi escrita) e localidade (sem código postal).
 * Estruturada (rua + cidade) ou, na morada livre, a 1.ª parte e a última («Rua X 5, 3º Esq, 1250-001 Lisboa»).
 */
function moradaPartes(c) {
  const e = (c && c.morada_estruturada) || {};
  if (e.rua) return { rua: String(e.rua).trim().slice(0, 60), localidade: e.cidade ? String(e.cidade).trim().slice(0, 40) : null };
  const partes = String((c && c.morada) || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length === 0) return { rua: null, localidade: null };
  const ultima = partes.length > 1 ? partes[partes.length - 1].replace(/^\d{4}(-\d{3})?\s*/, '').trim() : '';
  return { rua: partes[0].slice(0, 60), localidade: ultima ? ultima.slice(0, 40) : null };
}

/** «Rua X, Cidade» (estruturada) ou o início da morada livre. */
function moradaCurta(c) {
  const e = (c && c.morada_estruturada) || {};
  const curta = e.rua ? [e.rua, e.cidade].filter(Boolean).join(', ') : String((c && c.morada) || '').split(',').slice(0, 2).join(',').trim();
  return curta ? curta.slice(0, 60) : null;
}

/** Campos públicos para a interface (rótulo único das casas homónimas). */
function moradaParaApi(c) {
  const p = moradaPartes(c);
  return { morada_curta: moradaCurta(c), morada_rua: p.rua, morada_localidade: p.localidade };
}

module.exports = { moradaCurta, moradaPartes, moradaParaApi };
