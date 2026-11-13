#!/usr/bin/env node
/**
 * Migração: grava origem 'smoobu' nas limpezas que vieram do Smoobu.
 *
 * Contexto: até 2026-11-13 o Smoobu nunca gravava Tarefa.origem, por isso todas as limpezas ficaram
 * com o valor por defeito 'manual'. Agora as novas já saem com origem 'smoobu'; este script corrige
 * as existentes: toda a Tarefa com smoobu_reserva_id preenchido e origem diferente de 'smoobu'.
 *
 * É IDEMPOTENTE (repetir não muda nada) e só mexe no campo `origem`. SIMULA por defeito: conta e mostra
 * exemplos sem escrever; só escreve com --aplicar.
 *
 * Uso (a URI vem do ambiente, nunca da linha de comandos):
 *   MONGODB_URI=... node scripts/migrar-origem-smoobu.js            # simulação
 *   MONGODB_URI=... node scripts/migrar-origem-smoobu.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');

const FILTRO = { smoobu_reserva_id: { $nin: [null, ''] }, origem: { $ne: 'smoobu' } };

/**
 * @param {{ aplicar?: boolean }} opcoes
 * @returns {Promise<{ aplicado: boolean, candidatas: number, atualizadas: number, porEstado: object }>}
 */
async function migrarOrigemSmoobu({ aplicar = false } = {}) {
  const candidatas = await Tarefa.countDocuments(FILTRO);
  const porEstado = {};
  for (const g of await Tarefa.aggregate([{ $match: FILTRO }, { $group: { _id: '$estado', n: { $sum: 1 } } }])) porEstado[g._id] = g.n;
  let atualizadas = 0;
  if (aplicar && candidatas > 0) {
    // timestamps: false -> não mexe em updatedAt (é só uma correção de classificação)
    const r = await Tarefa.updateMany(FILTRO, { $set: { origem: 'smoobu' } }, { timestamps: false });
    atualizadas = r.modifiedCount || 0;
  }
  return { aplicado: !!aplicar, candidatas, atualizadas, porEstado };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.SRC_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI (ou SRC_URI) no ambiente.');
    process.exit(1);
  }
  const aplicar = process.argv.includes('--aplicar');
  await mongoose.connect(uri);
  try {
    const r = await migrarOrigemSmoobu({ aplicar });
    console.log(aplicar ? 'APLICADO' : 'SIMULAÇÃO (nada foi escrito; usa --aplicar para escrever)');
    console.log(`Limpezas do Smoobu com origem errada: ${r.candidatas}`);
    console.log('Por estado:', JSON.stringify(r.porEstado));
    if (aplicar) console.log(`Atualizadas: ${r.atualizadas}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}

module.exports = { migrarOrigemSmoobu, FILTRO };
