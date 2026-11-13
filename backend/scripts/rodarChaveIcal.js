#!/usr/bin/env node
/**
 * Rotação da chave de cifra dos calendários externos: volta a cifrar os links com a chave atual.
 * Antes: acrescenta a chave nova a ICAL_CHAVES (ex.: "1:...,2:...") e põe ICAL_CHAVE_ATUAL=2.
 * SIMULA por defeito (conta, não escreve); só escreve com --aplicar. Idempotente.
 *
 * Uso (a URI e as chaves vêm do ambiente):
 *   node scripts/rodarChaveIcal.js            # simulação
 *   node scripts/rodarChaveIcal.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const FonteCalendario = require('../models/FonteCalendario');
const { chavesConfiguradas, cifrar, decifrar, idChaveDe } = require('../utils/calendarioExterno/cifra');

async function rodarChaveIcal({ aplicar = false } = {}) {
  if (!chavesConfiguradas()) throw new Error('As chaves ICAL_* não estão configuradas.');
  const atual = String(process.env.ICAL_CHAVE_ATUAL).trim();
  const fontes = await FonteCalendario.find({ removida: false, url_cifrada: { $exists: true } }).select('+url_cifrada');
  let precisam = 0; let rodadas = 0; let falhas = 0;
  for (const f of fontes) {
    if (idChaveDe(f.url_cifrada) === atual) continue;
    precisam += 1;
    try {
      const novo = cifrar(decifrar(f.url_cifrada, String(f._id)), String(f._id));
      if (aplicar) { await FonteCalendario.updateOne({ _id: f._id }, { $set: { url_cifrada: novo } }); rodadas += 1; }
    } catch { falhas += 1; }
  }
  return { aplicado: aplicar, total: fontes.length, precisam_de_rodar: precisam, rodadas, falhas };
}

module.exports = { rodarChaveIcal };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const r = await rodarChaveIcal({ aplicar: process.argv.includes('--aplicar') });
    console.log(r.aplicado ? 'Aplicado:' : 'Simulação (nada foi escrito):', r);
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
