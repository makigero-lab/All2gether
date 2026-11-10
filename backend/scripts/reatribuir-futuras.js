#!/usr/bin/env node
/**
 * Volta a atribuir, do zero, as limpezas futuras que ainda não começaram (pedido do
 * utilizador, 2026-11-09: «limpar as limpezas futuras e fazer uma auto-atribuição»).
 *
 * Segurança: a base real nunca fica com limpezas sem pessoa a meio (o job das vagas abria
 * ofertas à equipa). O plano é feito numa CÓPIA em memória com o motor real; em produção
 * só se escreve o resultado final de cada limpeza, de uma vez, e só se a limpeza não mudou
 * desde a cópia.
 *
 * Abrange: tipo 'limpeza', estado atribuida/por_atribuir/nao_atribuida, sem início, de
 * --desde (por defeito amanhã) em diante. Fica de fora: em curso, concluídas, canceladas,
 * manutenções e as que o gestor desatribuiu à mão. O dia nunca muda; a hora e a equipa sim.
 * Por dia: casas com mais pessoas primeiro, depois pela hora atual.
 *
 * Uso (a URI vem do ambiente, nunca da linha de comandos):
 *   SRC_URI=... node scripts/reatribuir-futuras.js                 # simula e grava o relatório
 *   SRC_URI=... node scripts/reatribuir-futuras.js --aplicar       # simula e escreve em produção
 *   SRC_URI=... node scripts/reatribuir-futuras.js --aplicar --avisar  # e avisa quem mudou (1 aviso por pessoa)
 *   opções: --desde AAAA-MM-DD   --saida <pasta>
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const H = require('../utils/horario');
const { foraDoHorario } = require('./reagendar-horarios');

const arg = (n) => process.argv.includes(n);
const val = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const hh = (d) => (H.temHoraReal(d) ? H.hhmm(H.minutosLocais(d)) : '00:00');
const dia = (d) => new Date(d).toISOString().slice(0, 10);

// Coleções que não interessam ao motor (grandes ou sensíveis): não são copiadas.
const NAO_COPIAR = new Set(['webhooklogs', 'auditorias', 'notificacaos', 'notificacoes', 'tarefaarquivos', 'contactohospedes', 'exportacoes', 'relatorios']);

/** Copia a base de origem para a de destino (tarefas só de 2 dias antes de `desde` em diante, sem fotos). */
async function copiarBase(src, dst, desde) {
  const cols = await src.db.listCollections().toArray();
  const resumo = {};
  for (const { name } of cols) {
    if (NAO_COPIAR.has(name) || name.startsWith('system.')) continue;
    const filtro = name === 'tarefas' ? { data: { $gte: new Date(desde.getTime() - 2 * 86400000) } } : {};
    const proj = name === 'tarefas' ? { projection: { fotos_conclusao: 0, 'avarias.fotos': 0, fotos: 0 } } : {};
    const docs = await src.db.collection(name).find(filtro, proj).toArray();
    if (docs.length) await dst.db.collection(name).insertMany(docs, { ordered: false });
    resumo[name] = docs.length;
  }
  return resumo;
}

const FILTRO_CAND = (desde) => ({
  tipo: 'limpeza',
  estado: { $in: ['atribuida', 'por_atribuir', 'nao_atribuida'] },
  iniciada_em: null,
  desatribuida_manual: { $ne: true },
  data: { $gte: desde },
});

/** Plano com o motor real, na ligação por defeito do mongoose (a cópia). */
async function planear(desde) {
  const Tarefa = require('../models/Tarefa');
  const Propriedade = require('../models/Propriedade');
  const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
  const { idsEquipa } = require('../utils/equipaTarefa');

  const cands = await Tarefa.find(FILTRO_CAND(desde)).lean();
  const props = new Map((await Propriedade.find({ _id: { $in: [...new Set(cands.map((t) => String(t.propriedade_id)))] } }).lean()).map((p) => [String(p._id), p]));
  const porDia = new Map();
  for (const t of cands) {
    const k = `${t.empresa_id}|${dia(t.data)}`;
    porDia.set(k, [...(porDia.get(k) || []), t]);
  }
  const plano = [];
  for (const k of [...porDia.keys()].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))) {
    const lista = porDia.get(k);
    // Limpa o dia na cópia (nada fica de fora da agenda de ninguém).
    await Tarefa.updateMany(
      { _id: { $in: lista.map((t) => t._id) } },
      { $set: { utilizador_id: null, equipa_atribuida: [], pessoas_em_falta: 0, estado: 'por_atribuir', motivo_nao_atribuicao: null } }
    );
    lista.sort((a, b) => {
      const sa = Number(props.get(String(a.propriedade_id))?.staff_necessario) || 1;
      const sb = Number(props.get(String(b.propriedade_id))?.staff_necessario) || 1;
      return sb - sa || new Date(a.data) - new Date(b.data) || String(a._id).localeCompare(String(b._id));
    });
    for (const t of lista) {
      const prop = props.get(String(t.propriedade_id));
      const novo = { utilizador_id: null, equipa_atribuida: [], estado: 'por_atribuir', data: t.data, tempo_viagem_minutos: 0, pessoas_em_falta: 0, motivo_nao_atribuicao: 'Propriedade não encontrada' };
      if (prop) {
        const p = await planearAtribuicao({ empresaId: t.empresa_id, propriedade: prop, dia: new Date(`${dia(t.data)}T00:00:00Z`), tempoLimpeza: t.tempo_limpeza_minutos || prop.tempo_limpeza_minutos || 45 });
        Object.assign(novo, {
          utilizador_id: p.utilizador_id || null,
          equipa_atribuida: p.equipa_atribuida || [],
          estado: p.estado,
          data: p.estado === 'atribuida' ? p.data : t.data,
          tempo_viagem_minutos: p.tempo_viagem_minutos || 0,
          pessoas_em_falta: p.faltam || 0,
          motivo_nao_atribuicao: p.estado === 'atribuida' ? null : p.motivo_nao_atribuicao,
        });
      }
      await Tarefa.updateOne({ _id: t._id }, { $set: novo });
      plano.push({ antes: t, depois: { ...novo, equipa: idsEquipa(novo) } });
    }
  }
  return plano;
}

/** Sobreposições e horas fora do horário nas limpezas futuras atribuídas (na ligação atual). */
async function verificar(desde) {
  const Tarefa = require('../models/Tarefa');
  const { idsEquipa } = require('../utils/equipaTarefa');
  const ts = await Tarefa.find({ data: { $gte: desde }, estado: { $in: ['atribuida', 'em_curso'] } })
    .select('data tempo_limpeza_minutos tempo_viagem_minutos utilizador_id equipa_atribuida tipo estado').lean();
  const fora = ts.filter((t) => t.tipo === 'limpeza' && t.estado === 'atribuida' && foraDoHorario(t));
  const porPessoaDia = new Map();
  for (const t of ts) for (const m of idsEquipa(t)) {
    const k = `${m}|${dia(t.data)}`;
    porPessoaDia.set(k, [...(porPessoaDia.get(k) || []), t]);
  }
  const sobrepostas = [];
  for (const [k, lista] of porPessoaDia) {
    const ord = lista.filter((t) => H.temHoraReal(t.data)).sort((a, b) => a.data - b.data);
    for (let i = 1; i < ord.length; i++) {
      const fimAnt = ord[i - 1].data.getTime() + (ord[i - 1].tempo_limpeza_minutos || 45) * 60000;
      if (ord[i].data.getTime() < fimAnt) sobrepostas.push({ pessoa: k.split('|')[0], dia: k.split('|')[1], a: String(ord[i - 1]._id), b: String(ord[i]._id) });
    }
  }
  return { atribuidas: ts.length, foraDoHorario: fora.map((t) => ({ id: String(t._id), dia: dia(t.data), hora: hh(t.data) })), sobrepostas };
}

async function main() {
  const SRC = process.env.SRC_URI;
  if (!SRC) throw new Error('Falta SRC_URI no ambiente.');
  const aplicar = arg('--aplicar');
  const avisar = arg('--avisar');
  const agora = new Date();
  const hojeLx = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(agora);
  const desde = val('--desde') ? new Date(`${val('--desde')}T00:00:00Z`) : new Date(new Date(`${hojeLx}T00:00:00Z`).getTime() + 86400000);
  const saida = val('--saida') || path.resolve(__dirname, '..', '..', 'trabalho-local', `reatribuicao-${hojeLx}`);
  fs.mkdirSync(saida, { recursive: true });
  const marca = new Date().toISOString().replace(/[:.]/g, '-');

  // 1) Cópia para memória e diagnóstico das horas antes das 09:00 (na cópia).
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mem = await MongoMemoryServer.create();
  const src = await mongoose.createConnection(SRC, { readPreference: 'secondaryPreferred' }).asPromise();
  await mongoose.connect(mem.getUri());
  const copia = await copiarBase(src, mongoose.connection, new Date(`${hojeLx}T00:00:00Z`));
  console.log('Cópia:', JSON.stringify(copia));

  const Tarefa = require('../models/Tarefa');
  const Utilizador = require('../models/Utilizador');
  const Propriedade = require('../models/Propriedade');
  const nomes = new Map((await Utilizador.find({}).select('nome').lean()).map((u) => [String(u._id), u.nome]));
  const casas = new Map((await Propriedade.find({}).select('nome').lean()).map((p) => [String(p._id), p.nome]));
  const nomesDe = (ids) => (ids || []).map((i) => nomes.get(String(i)) || String(i)).join(' + ') || '—';

  const hojeIni = new Date(`${hojeLx}T00:00:00Z`);
  const antesDas9 = await Tarefa.find({ data: { $gte: hojeIni }, estado: { $nin: ['cancelada', 'concluida'] } }).lean();
  const diagnostico = antesDas9
    .filter((t) => H.minutosLocais(t.data) < H.HORARIO.INICIO_DIA)
    .map((t) => ({
      id: String(t._id), dia: dia(t.data), hora: hh(t.data), estado: t.estado, tipo: t.tipo, tipo_limpeza: t.tipo_limpeza,
      origem: t.origem || null, casa: casas.get(String(t.propriedade_id)), pessoas: nomesDe([t.utilizador_id, ...(t.equipa_atribuida || [])].filter(Boolean)),
      criada: t.createdAt, alterada: t.updatedAt, inicio_origem: t.inicio_origem || null, data_ajustada_gestor: !!t.data_ajustada_gestor,
      reserva_smoobu: t.smoobu_reserva_id || t.reserva_id || null,
    }));
  console.log(`Antes das 09:00 (hoje em diante, não canceladas/concluídas): ${diagnostico.length}`);

  const verifAntes = await verificar(desde);

  // 2) Plano na cópia.
  const plano = await planear(desde);
  const verifPlano = await verificar(desde);

  const linhas = plano.map(({ antes: a, depois: d }) => {
    const eqA = [a.utilizador_id, ...(a.equipa_atribuida || [])].filter(Boolean).map(String).filter((v, i, s) => s.indexOf(v) === i);
    return {
      id: String(a._id), dia: dia(a.data), casa: casas.get(String(a.propriedade_id)),
      antes: { estado: a.estado, hora: hh(a.data), pessoas: nomesDe(eqA) },
      depois: { estado: d.estado, hora: hh(d.data), pessoas: nomesDe(d.equipa), faltam: d.pessoas_em_falta, motivo: d.motivo_nao_atribuicao },
      mudou: a.estado !== d.estado || hh(a.data) !== hh(d.data) || eqA.slice().sort().join() !== d.equipa.slice().sort().join(),
      perdeu: a.estado === 'atribuida' && d.estado !== 'atribuida',
    };
  });
  const resumo = {
    desde: dia(desde),
    limpezas: linhas.length,
    iguais: linhas.filter((l) => !l.mudou).length,
    mudam: linhas.filter((l) => l.mudou).length,
    atribuidas_antes: linhas.filter((l) => l.antes.estado === 'atribuida').length,
    atribuidas_depois: linhas.filter((l) => l.depois.estado === 'atribuida').length,
    ficam_sem_equipa_que_tinham: linhas.filter((l) => l.perdeu).length,
    com_vaga: linhas.filter((l) => l.depois.estado === 'atribuida' && l.depois.faltam > 0).length,
    antes: { fora_do_horario: verifAntes.foraDoHorario.length, sobrepostas: verifAntes.sobrepostas.length },
    plano: { fora_do_horario: verifPlano.foraDoHorario.length, sobrepostas: verifPlano.sobrepostas.length },
    antes_das_9_hoje_em_diante: diagnostico.length,
  };
  fs.writeFileSync(path.join(saida, `plano-${marca}.json`), JSON.stringify({ resumo, diagnostico, linhas, verifAntes, verifPlano }, null, 1));
  console.log('Resumo:', JSON.stringify(resumo, null, 1));

  await mongoose.disconnect();
  await mem.stop();
  if (!aplicar) { await src.close(); console.log(`Simulação apenas. Relatório em ${saida}`); return; }

  // 3) Aplicar em produção: cópia de segurança e escrita condicional (a limpeza não mudou desde a cópia).
  await src.close();
  await mongoose.connect(SRC);
  const { obterLock, libertarLock } = require('../utils/lockEmpresa');
  const empresas = [...new Set(plano.map((p) => String(p.antes.empresa_id)))];
  const locks = [];
  for (const e of empresas) {
    const d = await obterLock(`vagas:${e}`, { ttlMs: 5 * 60 * 1000, esperaMs: 30000 });
    if (!d) throw new Error(`Empresa ${e} ocupada (outra atribuição a correr). Nada foi escrito.`);
    locks.push([`vagas:${e}`, d]);
  }
  const atuais = await Tarefa.find({ _id: { $in: plano.map((p) => p.antes._id) } }).lean();
  fs.writeFileSync(path.join(saida, `seguranca-${marca}.json`), JSON.stringify(atuais));
  let escritas = 0; let conflitos = 0;
  const avisos = new Map();
  const juntar = (id, txt) => { const l = avisos.get(String(id)) || []; if (!l.includes(txt)) avisos.set(String(id), [...l, txt]); };
  try {
    for (const { antes: a, depois: d } of plano) {
      const set = {
        utilizador_id: d.utilizador_id || null,
        equipa_atribuida: d.utilizador_id ? d.equipa_atribuida : [],
        estado: d.estado,
        data: d.data,
        tempo_viagem_minutos: d.tempo_viagem_minutos,
        pessoas_em_falta: d.utilizador_id ? d.pessoas_em_falta : 0,
        motivo_nao_atribuicao: d.motivo_nao_atribuicao,
      };
      if (d.estado === 'atribuida' && !d.pessoas_em_falta && a.oferta_estado === 'aberta') set.oferta_estado = 'fechada';
      const r = await Tarefa.updateOne({ _id: a._id, updatedAt: a.updatedAt, estado: a.estado }, { $set: set });
      if (r.matchedCount === 1) {
        escritas++;
        const eqA = [...new Set([a.utilizador_id, ...(a.equipa_atribuida || [])].filter(Boolean).map(String))];
        const eqD = [...new Set((d.equipa || []).map(String))];
        const casa = casas.get(String(a.propriedade_id)) || 'uma casa';
        const dTxt = new Date(a.data).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
        for (const m of eqA) if (!eqD.includes(m)) juntar(m, `saíste da limpeza de ${casa} (${dTxt})`);
        for (const m of eqD) if (!eqA.includes(m)) juntar(m, `nova limpeza: ${casa} a ${dTxt} às ${hh(d.data)}`);
        for (const m of eqD) if (eqA.includes(m) && hh(a.data) !== hh(d.data)) juntar(m, `${casa} a ${dTxt} passou para as ${hh(d.data)}`);
      } else conflitos++;
    }
  } finally {
    for (const [k, dono] of locks) await libertarLock(k, dono);
  }
  console.log(`Escritas: ${escritas}; mudaram entretanto (não tocadas): ${conflitos}.`);

  if (avisar) {
    const { notificarUtilizador } = require('../utils/notificar');
    for (const [id, txts] of avisos) {
      await notificarUtilizador(id, '🗓️ Limpezas reorganizadas', txts.slice(0, 6).join('; ') + (txts.length > 6 ? `; e mais ${txts.length - 6}.` : '.'), '/staff', { tipo: 'tarefa_reatribuida', criarInApp: true });
    }
    console.log(`Avisos: ${avisos.size} pessoas.`);
  }

  // 4) Validação em produção.
  const verifDepois = await verificar(desde);
  fs.writeFileSync(path.join(saida, `verificacao-${marca}.json`), JSON.stringify(verifDepois, null, 1));
  console.log('Produção depois:', JSON.stringify({ fora_do_horario: verifDepois.foraDoHorario.length, sobrepostas: verifDepois.sobrepostas.length }));
  await mongoose.disconnect();
}

if (require.main === module) {
  // Alguns módulos deixam temporizadores ativos: sai explicitamente no fim.
  main().then(() => process.exit(0)).catch(async (e) => {
    console.error('Erro:', e.message);
    try { await mongoose.disconnect(); } catch { /* */ }
    process.exit(1);
  });
}

module.exports = { planear, verificar, copiarBase };
