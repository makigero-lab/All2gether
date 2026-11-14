/** Morada curta para distinguir casas com o mesmo nome: «Rua X, Cidade» (estruturada) ou o início da morada livre. */
function moradaCurta(c) {
  const e = (c && c.morada_estruturada) || {};
  const curta = e.rua ? [e.rua, e.cidade].filter(Boolean).join(', ') : String((c && c.morada) || '').split(',').slice(0, 2).join(',').trim();
  return curta ? curta.slice(0, 60) : null;
}

module.exports = { moradaCurta };
