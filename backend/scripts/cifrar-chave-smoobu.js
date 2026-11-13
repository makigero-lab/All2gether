#!/usr/bin/env node
/**
 * Cifra a chave e o segredo do Smoobu das empresas que ainda os têm em claro (e preenche o HMAC da chave,
 * usado pelo webhook). Idempotente: o que já está cifrado fica como está.
 * SIMULA por defeito (conta, não escreve); só escreve com --aplicar. Nunca imprime chaves nem segredos.
 *
 * Pré-requisito: ICAL_CHAVES, ICAL_CHAVE_ATUAL e ICAL_HMAC_CHAVE já definidas no ambiente (Render).
 *
 * Uso:
 *   node scripts/cifrar-chave-smoobu.js            # simulação
 *   node scripts/cifrar-chave-smoobu.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const Empresa = require('../models/Empresa');
const { chavesConfiguradas } = require('../utils/calendarioExterno/cifra');
const { estaCifrado, protegerSegredo, lerSegredo, hmacChave } = require('../utils/segredoEmpresa');

async function cifrarChaveSmoobu({ aplicar = false } = {}) {
  if (!chavesConfiguradas()) throw new Error('As chaves ICAL_* não estão configuradas: nada foi feito.');
  const col = Empresa.collection;
  const empresas = await col
    .find(
      { $or: [{ 'integracoes.smoobu.api_key': { $nin: [null, ''] } }, { 'integracoes.smoobu.api_secret': { $nin: [null, ''] } }] },
      { projection: { 'integracoes.smoobu.api_key': 1, 'integracoes.smoobu.api_secret': 1, 'integracoes.smoobu.api_key_hmac': 1 } }
    )
    .toArray();
  const r = { aplicado: aplicar, empresas: empresas.length, a_cifrar: 0, cifradas: 0, ja_cifradas: 0, falhas: 0 };
  for (const e of empresas) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    const set = {};
    try {
      for (const campo of ['api_key', 'api_secret']) {
        const v = s[campo];
        if (!v || estaCifrado(v)) continue;
        const cifrado = protegerSegredo(v, e._id, campo);
        if (lerSegredo(cifrado, e._id, campo) !== String(v).trim()) throw new Error('verificação da cifra falhou');
        set[`integracoes.smoobu.${campo}`] = cifrado;
      }
      // HMAC da chave (a partir do valor em claro, venha de onde vier).
      const chave = lerSegredo(s.api_key, e._id, 'api_key');
      const hm = hmacChave(chave);
      if (chave && s.api_key_hmac !== hm) set['integracoes.smoobu.api_key_hmac'] = hm;
      if (Object.keys(set).length === 0) { r.ja_cifradas += 1; continue; }
      r.a_cifrar += 1;
      if (aplicar) { await col.updateOne({ _id: e._id }, { $set: set }); r.cifradas += 1; }
    } catch (err) {
      r.falhas += 1;
      console.error(`❌ empresa ${e._id}: ${err.message}`);
    }
  }
  return r;
}

module.exports = { cifrarChaveSmoobu };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const r = await cifrarChaveSmoobu({ aplicar: process.argv.includes('--aplicar') });
    console.log(r.aplicado ? 'Aplicado:' : 'Simulação (nada foi escrito):', r);
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
