#!/usr/bin/env node
/**
 * Limpa "equipas fantasma": tarefas SEM responsável (utilizador_id null) mas
 * com equipa_atribuida preenchida, nos estados por_atribuir, nao_atribuida e
 * cancelada. Define equipa_atribuida: [] e pessoas_em_falta: 0. Não toca em
 * mais nenhum campo. Idempotente.
 *
 * Uso (MONGODB_URI vem do ambiente):
 *   node scripts/limpar-equipas-fantasma.js            # só conta (não altera)
 *   node scripts/limpar-equipas-fantasma.js --aplicar  # altera
 *
 * Mostra apenas números por estado (sem dados pessoais).
 */
const mongoose = require('mongoose');

const ESTADOS = ['por_atribuir', 'nao_atribuida', 'cancelada'];
const FILTRO = {
  utilizador_id: null,
  'equipa_atribuida.0': { $exists: true },
  estado: { $in: ESTADOS },
};

/** Conta por estado (e, com aplicar=true, altera). Usa a coleção direta (sem hooks). */
async function limparEquipasFantasma(db, { aplicar = false } = {}) {
  const col = db.collection('tarefas');
  const porEstado = {};
  for (const estado of ESTADOS) {
    porEstado[estado] = await col.countDocuments({ ...FILTRO, estado });
  }
  const total = Object.values(porEstado).reduce((a, b) => a + b, 0);
  let alteradas = 0;
  if (aplicar && total > 0) {
    const r = await col.updateMany(FILTRO, { $set: { equipa_atribuida: [], pessoas_em_falta: 0 } });
    alteradas = r.modifiedCount;
  }
  return { porEstado, total, alteradas, aplicado: !!aplicar };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Defina MONGODB_URI no ambiente.');
    process.exit(1);
  }
  const aplicar = process.argv.includes('--aplicar');
  await mongoose.connect(uri);
  try {
    const r = await limparEquipasFantasma(mongoose.connection.db, { aplicar });
    console.log(aplicar ? 'MODO: APLICAR' : 'MODO: só leitura (use --aplicar para alterar)');
    for (const [estado, n] of Object.entries(r.porEstado)) console.log(`  ${estado}: ${n}`);
    console.log(`Total com equipa fantasma: ${r.total}`);
    if (aplicar) console.log(`Tarefas alteradas: ${r.alteradas}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
  });
}

module.exports = { limparEquipasFantasma };
