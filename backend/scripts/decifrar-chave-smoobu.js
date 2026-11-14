#!/usr/bin/env node
/**
 * REVERSÃO de cifrar-chave-smoobu: repõe a chave e o segredo do Smoobu das empresas EM CLARO (como antes
 * da cifra) e limpa o HMAC da chave. Serve para poder fazer rollback do código para uma versão que ainda
 * não sabe ler valores cifrados. Idempotente: o que já está em claro fica como está.
 * SIMULA por defeito (conta, não escreve); só escreve com --aplicar. Nunca imprime chaves nem segredos.
 *
 * Pré-requisito: as ICAL_CHAVES (as mesmas com que se cifrou) ainda definidas no ambiente. Um valor que não
 * se decifra conta como falha e fica intocado (volta a escrever a chave e o segredo pelo ecrã).
 *
 * ORDEM DO ROLLBACK DO CÓDIGO (ver docs/OPERACOES-CHAVES.md):
 *   1. node scripts/decifrar-chave-smoobu.js            (simulação: falhas deve ser 0)
 *   2. node scripts/decifrar-chave-smoobu.js --aplicar
 *   3. Só depois, rollback do deploy no Render. (NUNCA o contrário.)
 *   4. Confirmar "Testar ligação" no ecrã de Configurações.
 *
 * Uso:
 *   node scripts/decifrar-chave-smoobu.js            # simulação
 *   node scripts/decifrar-chave-smoobu.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const Empresa = require('../models/Empresa');
const { estaCifrado, lerSegredoEstado } = require('../utils/segredoEmpresa');

async function decifrarChaveSmoobu({ aplicar = false } = {}) {
  const col = Empresa.collection;
  const empresas = await col
    .find(
      { $or: [{ 'integracoes.smoobu.api_key': { $nin: [null, ''] } }, { 'integracoes.smoobu.api_secret': { $nin: [null, ''] } }] },
      { projection: { 'integracoes.smoobu.api_key': 1, 'integracoes.smoobu.api_secret': 1, 'integracoes.smoobu.api_key_hmac': 1 } }
    )
    .toArray();
  const r = { aplicado: aplicar, empresas: empresas.length, a_decifrar: 0, decifradas: 0, ja_em_claro: 0, alteradas_entretanto: 0, falhas: 0 };
  for (const e of empresas) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    const set = {}; const filtro = { _id: e._id };
    let falhou = false;
    for (const campo of ['api_key', 'api_secret']) {
      const v = s[campo];
      if (!v || !estaCifrado(v)) continue;
      const l = lerSegredoEstado(v, e._id, campo);
      if (l.ilegivel) { falhou = true; console.error(`❌ empresa ${e._id}: ${campo} não se consegue decifrar com as ICAL_CHAVES atuais (deixado como está).`); continue; }
      set[`integracoes.smoobu.${campo}`] = l.valor;
      filtro[`integracoes.smoobu.${campo}`] = v;
    }
    if (falhou) { r.falhas += 1; continue; }
    // O HMAC só serve com a chave cifrada; o código antigo ignora-o, por isso limpa-se.
    if (s.api_key_hmac) { set['integracoes.smoobu.api_key_hmac'] = ''; filtro['integracoes.smoobu.api_key_hmac'] = s.api_key_hmac; }
    if (!Object.keys(set).length) { r.ja_em_claro += 1; continue; }
    r.a_decifrar += 1;
    if (!aplicar) continue;
    const u = await col.updateOne(filtro, { $set: set });
    if (u.matchedCount === 1) r.decifradas += 1; else r.alteradas_entretanto += 1;
  }
  return r;
}

module.exports = { decifrarChaveSmoobu };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const r = await decifrarChaveSmoobu({ aplicar: process.argv.includes('--aplicar') });
    console.log(r.aplicado ? 'Aplicado:' : 'Simulação (nada foi escrito):', r);
    if (r.falhas > 0) { console.error('Há falhas: NÃO faças o rollback do código até estarem resolvidas.'); process.exitCode = 1; }
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
