#!/usr/bin/env node
/**
 * Cifra a chave e o segredo do Smoobu das empresas que ainda os têm em claro (e preenche o HMAC da chave,
 * usado pelo webhook). Idempotente: o que já está cifrado fica como está.
 * SIMULA por defeito (conta, não escreve); só escreve com --aplicar. Nunca imprime chaves nem segredos.
 *
 * Pré-requisito: ICAL_CHAVES, ICAL_CHAVE_ATUAL e ICAL_HMAC_CHAVE já definidas no ambiente (Render).
 * Se algum valor já cifrado não se decifra com as chaves atuais (chave de cifra errada), conta como falha e,
 * com --aplicar, ABORTA sem escrever nada. A escrita é condicional (só se o valor ainda for o lido).
 * ICAL_HMAC_CHAVE nunca se muda sem voltar a correr este script com --aplicar (repara o HMAC da chave).
 * Marcha-atrás: scripts/decifrar-chave-smoobu.js.
 *
 * Uso:
 *   node scripts/cifrar-chave-smoobu.js            # simulação
 *   node scripts/cifrar-chave-smoobu.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const Empresa = require('../models/Empresa');
const { chavesConfiguradas } = require('../utils/calendarioExterno/cifra');
const { estaCifrado, protegerSegredo, lerSegredo, lerSegredoEstado, hmacChave } = require('../utils/segredoEmpresa');

async function cifrarChaveSmoobu({ aplicar = false } = {}) {
  if (!chavesConfiguradas()) throw new Error('As chaves ICAL_* não estão configuradas: nada foi feito.');
  const col = Empresa.collection;
  const empresas = await col
    .find(
      { $or: [{ 'integracoes.smoobu.api_key': { $nin: [null, ''] } }, { 'integracoes.smoobu.api_secret': { $nin: [null, ''] } }] },
      { projection: { 'integracoes.smoobu.api_key': 1, 'integracoes.smoobu.api_secret': 1, 'integracoes.smoobu.api_key_hmac': 1 } }
    )
    .toArray();
  const r = { aplicado: aplicar, empresas: empresas.length, a_cifrar: 0, cifradas: 0, ja_cifradas: 0, ilegiveis: 0, alteradas_entretanto: 0, falhas: 0 };
  const plano = [];
  for (const e of empresas) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    const set = {};
    try {
      let ilegivel = false;
      for (const campo of ['api_key', 'api_secret']) {
        const v = s[campo];
        if (!v) continue;
        if (estaCifrado(v)) {
          // Já cifrado: tem de se conseguir decifrar com as chaves atuais, senão está "cifrado" mas perdido
          // (ICAL_CHAVES errada). Isso NÃO é "já cifrada" nem "0 falhas".
          if (lerSegredoEstado(v, e._id, campo).ilegivel) { ilegivel = true; console.error(`❌ empresa ${e._id}: ${campo} já está cifrado mas não se consegue decifrar com as ICAL_CHAVES atuais.`); }
          continue;
        }
        const cifrado = protegerSegredo(v, e._id, campo);
        if (lerSegredo(cifrado, e._id, campo) !== String(v).trim()) throw new Error('verificação da cifra falhou');
        set[`integracoes.smoobu.${campo}`] = cifrado;
      }
      if (ilegivel) { r.ilegiveis += 1; r.falhas += 1; continue; }
      // HMAC da chave (a partir do valor em claro, venha de onde vier).
      const chave = lerSegredo(s.api_key, e._id, 'api_key');
      const hm = hmacChave(chave);
      if (chave && s.api_key_hmac !== hm) set['integracoes.smoobu.api_key_hmac'] = hm;
      if (Object.keys(set).length === 0) { r.ja_cifradas += 1; continue; }
      r.a_cifrar += 1;
      plano.push({ e, s, set });
    } catch (err) {
      r.falhas += 1;
      console.error(`❌ empresa ${e._id}: ${err.message}`);
    }
  }
  if (r.ilegiveis > 0 && aplicar) {
    throw new Error(
      `Abortado, nada foi escrito: ${r.ilegiveis} empresa(s) têm a chave/segredo do Smoobu cifrados que não se conseguem decifrar com as ICAL_CHAVES atuais. ` +
      'Provavelmente a chave de cifra está errada ou foi perdida (repõe a ICAL_CHAVES certa no ambiente) ou o valor foi corrompido (volta a escrever a chave e o segredo no ecrã).'
    );
  }
  if (aplicar) {
    for (const { e, s, set } of plano) {
      try {
        // Só escreve se os valores ainda forem os que foram lidos: se o gestor gravou outra chave entretanto,
        // não a sobrescreve com a cifra da antiga.
        const filtro = { _id: e._id };
        for (const campo of ['api_key', 'api_secret']) filtro[`integracoes.smoobu.${campo}`] = s[campo] == null ? null : s[campo];
        const u = await col.updateOne(filtro, { $set: set });
        if (u.matchedCount === 1) r.cifradas += 1;
        else { r.alteradas_entretanto += 1; console.warn(`⚠️  empresa ${e._id}: alterada entretanto, não foi tocada (volta a correr o script).`); }
      } catch (err) {
        r.falhas += 1;
        console.error(`❌ empresa ${e._id}: ${err.message}`);
      }
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
    if (r.falhas > 0) { console.error('Há falhas: vê as mensagens acima antes de continuar.'); process.exitCode = 1; }
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
