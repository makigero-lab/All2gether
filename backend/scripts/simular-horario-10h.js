#!/usr/bin/env node
/**
 * Novo horário das limpezas (10:00-17:30, a limpeza tem de acabar até às 17:30): SIMULA o efeito nas limpezas futuras.
 *
 * Por defeito NÃO ESCREVE NADA. Mostra só contagens e ids (nunca nomes de pessoas, casas ou hóspedes):
 *   - quantas limpezas futuras `atribuida` ficam fora do novo horário;
 *   - quantas dessas foram postas à mão pelo gestor (ficam como estão: o gestor manda) e quantas são automáticas;
 *   - das automáticas, o que a reatribuição faria (reagendar a mesma equipa / passar a outra pessoa / ficar por atribuir).
 * Só com `--aplicar` reagenda as AUTOMÁTICAS (nunca as do gestor), com o mesmo motor de `reagendar-horarios.js`.
 *
 * Uso (MONGODB_URI vem do ambiente; NÃO correr contra produção sem ordem do utilizador):
 *   node scripts/simular-horario-10h.js                 # simula
 *   node scripts/simular-horario-10h.js --empresa <id>  # limita a uma empresa
 *   node scripts/simular-horario-10h.js --aplicar       # escreve (só as automáticas)
 *
 * Limite conhecido: atribuir uma pessoa a uma limpeza que já tinha hora não deixa marca, por isso uma hora que o
 * gestor só «confirmou» assim conta como automática. A lista de ids permite rever antes de aplicar.
 */
const mongoose = require('mongoose');

const H = require('../utils/horario');
const { eMarcadaPeloGestor } = require('../utils/diaMudadoGestor');
const { reagendarHorarios, foraDoHorario } = require('./reagendar-horarios');

/** Contagens e ids; sem dados pessoais. */
async function simularHorario10h({ aplicar = false, agora = new Date(), empresaId = null } = {}) {
  const Tarefa = require('../models/Tarefa');
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const filtro = { estado: 'atribuida', data: { $gte: hoje } };
  if (empresaId) filtro.empresa_id = empresaId;
  const todas = await Tarefa.find(filtro)
    .select('data tempo_limpeza_minutos data_ajustada_gestor dia_mudado_pelo_gestor origem')
    .lean();
  const fora = todas.filter(foraDoHorario);
  const doGestor = fora.filter(eMarcadaPeloGestor);
  const automaticas = fora.filter((t) => !eMarcadaPeloGestor(t));
  const r = await reagendarHorarios({ aplicar, agora, empresaId, soAutomaticas: true });
  return {
    aplicado: !!aplicar,
    janela: `${H.hhmm(H.HORARIO.INICIO_DIA)}-${H.hhmm(H.HORARIO.FIM_MAXIMO_LIMPEZA)}`,
    futurasAtribuidas: todas.length,
    foraDoNovoHorario: fora.length,
    marcadasPeloGestor: doGestor.length,
    automaticas: automaticas.length,
    reatribuicao: { reagendadas: r.reagendadas, passadasAOutraPessoa: r.passadas, porAtribuir: r.porAtribuir },
    idsMarcadasPeloGestor: doGestor.map((t) => String(t._id)),
    idsAutomaticas: automaticas.map((t) => String(t._id)),
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Defina MONGODB_URI no ambiente.');
    process.exit(1);
  }
  const aplicar = process.argv.includes('--aplicar');
  const i = process.argv.indexOf('--empresa');
  const empresaId = i > -1 ? process.argv[i + 1] : null;
  await mongoose.connect(uri);
  try {
    const r = await simularHorario10h({ aplicar, empresaId });
    console.log(aplicar ? 'MODO: APLICAR (só as automáticas)' : 'MODO: simulação (não escreve; use --aplicar para alterar)');
    console.log(`Novo horário: ${r.janela}`);
    console.log(`Limpezas futuras atribuídas: ${r.futurasAtribuidas}`);
    console.log(`Fora do novo horário: ${r.foraDoNovoHorario} (à mão pelo gestor, ficam: ${r.marcadasPeloGestor} | automáticas: ${r.automaticas})`);
    console.log(`Reatribuição das automáticas: reagendadas ${r.reatribuicao.reagendadas} | passadas a outra pessoa ${r.reatribuicao.passadasAOutraPessoa} | por atribuir ${r.reatribuicao.porAtribuir}`);
    if (r.idsMarcadasPeloGestor.length) console.log(`Ids à mão: ${r.idsMarcadasPeloGestor.join(', ')}`);
    if (r.idsAutomaticas.length) console.log(`Ids automáticas: ${r.idsAutomaticas.join(', ')}`);
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

module.exports = { simularHorario10h };
