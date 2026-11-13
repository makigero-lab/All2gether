#!/usr/bin/env node
/**
 * Rotação da chave de cifra: volta a cifrar com a chave atual (a) os links dos calendários externos e
 * (b) a chave e o segredo do Smoobu das empresas.
 * Antes: acrescenta a chave nova a ICAL_CHAVES (ex.: "1:...,2:...") e põe ICAL_CHAVE_ATUAL=2.
 * SIMULA por defeito (conta, não escreve); só escreve com --aplicar. Idempotente.
 *
 * ATENÇÃO: a chave antiga NUNCA se retira de ICAL_CHAVES enquanto houver dados cifrados com ela. No fim,
 * o script diz "ainda há N valores cifrados com a chave X": só quando já não diz nada (depois de --aplicar)
 * é seguro retirar essa chave. Retirá-la antes torna os valores ilegíveis (o Smoobu da empresa pára).
 *
 * Uso (a URI e as chaves vêm do ambiente):
 *   node scripts/rodarChaveIcal.js            # simulação
 *   node scripts/rodarChaveIcal.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const FonteCalendario = require('../models/FonteCalendario');
const Empresa = require('../models/Empresa');
const { chavesConfiguradas, cifrar, decifrar, idChaveDe } = require('../utils/calendarioExterno/cifra');
const { estaCifrado, aad } = require('../utils/segredoEmpresa');

const CAMPOS_SMOOBU = ['api_key', 'api_secret'];
const PROJECAO_SMOOBU = { 'integracoes.smoobu.api_key': 1, 'integracoes.smoobu.api_secret': 1 };

/** Conta os valores cifrados (links e credenciais Smoobu) por id de chave: { '1': 3, '2': 5 }. */
async function contarCifradosPorChave() {
  const n = {};
  const somar = (t) => { const id = idChaveDe(t); if (id) n[id] = (n[id] || 0) + 1; };
  for await (const f of FonteCalendario.collection.find({ url_cifrada: { $type: 'string' } }, { projection: { url_cifrada: 1 } })) somar(f.url_cifrada);
  for await (const e of Empresa.collection.find({}, { projection: PROJECAO_SMOOBU })) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    for (const c of CAMPOS_SMOOBU) if (estaCifrado(s[c])) somar(s[c]);
  }
  return n;
}

/** Texto "ainda há N valores cifrados com a chave X" para cada chave que não é a atual. */
function avisosChavesAntigas(contagem, atual) {
  return Object.entries(contagem)
    .filter(([id, q]) => id !== String(atual) && q > 0)
    .map(([id, q]) => `ainda há ${q} valores cifrados com a chave ${id}: NÃO a retires de ICAL_CHAVES`);
}

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

  // Credenciais Smoobu das empresas (chave e segredo). Escrita condicional: só se o valor ainda for o lido.
  const smoobu = { precisam_de_rodar: 0, rodadas: 0, alteradas_entretanto: 0, falhas: 0 };
  const empresas = await Empresa.collection.find({}, { projection: PROJECAO_SMOOBU }).toArray();
  for (const e of empresas) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    const set = {}; const filtro = { _id: e._id };
    try {
      for (const campo of CAMPOS_SMOOBU) {
        const v = s[campo];
        if (!estaCifrado(v) || idChaveDe(v) === atual) continue;
        set[`integracoes.smoobu.${campo}`] = cifrar(decifrar(v, aad(e._id, campo)), aad(e._id, campo));
        filtro[`integracoes.smoobu.${campo}`] = v;
      }
    } catch (err) {
      smoobu.falhas += 1;
      console.error(`❌ empresa ${e._id}: não foi possível decifrar com as ICAL_CHAVES atuais (${err.message}).`);
      continue;
    }
    if (!Object.keys(set).length) continue;
    smoobu.precisam_de_rodar += 1;
    if (!aplicar) continue;
    const u = await Empresa.collection.updateOne(filtro, { $set: set });
    if (u.matchedCount === 1) smoobu.rodadas += 1; else smoobu.alteradas_entretanto += 1;
  }

  const ainda_cifrados_por_chave = await contarCifradosPorChave();
  return {
    aplicado: aplicar, total: fontes.length, precisam_de_rodar: precisam, rodadas, falhas,
    smoobu, ainda_cifrados_por_chave, avisos: avisosChavesAntigas(ainda_cifrados_por_chave, atual),
  };
}

module.exports = { rodarChaveIcal, contarCifradosPorChave, avisosChavesAntigas };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const r = await rodarChaveIcal({ aplicar: process.argv.includes('--aplicar') });
    console.log(r.aplicado ? 'Aplicado:' : 'Simulação (nada foi escrito):', r);
    for (const a of r.avisos) console.warn(`⚠️  ${a}`);
    if (r.falhas || r.smoobu.falhas) process.exitCode = 1;
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
