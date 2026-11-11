#!/usr/bin/env node
/**
 * Reagenda as limpezas atribuídas cuja hora está fora do horário de trabalho
 * (antes das 09:00 -- incluindo a meia-noite -- ou a acabar depois das 18:00).
 *
 * Regras (ver utils/horario.js): 09:00-17:30, uma limpeza acaba até às 18:00,
 * almoço de 1 h (início entre 12:00 e 14:00), viagens contam.
 *
 * Só toca em tarefas FUTURAS (dia de hoje em diante), no estado `atribuida`.
 * Nunca em `em_curso`, `concluida` ou `cancelada` (essas contam como agenda
 * fixa). Para cada tarefa afetada, pela ordem atual (data, id):
 *   1. procura a primeira hora que cabe a TODA a equipa, no dia dela;
 *   2. se não couber, passa ao motor (outra pessoa);
 *   3. se ninguém puder, fica por atribuir com o motivo real.
 * Idempotente: depois de aplicado não há mais tarefas fora do horário.
 *
 * Uso (MONGODB_URI vem do ambiente):
 *   node scripts/reagendar-horarios.js                      # só mostra números e a lista
 *   node scripts/reagendar-horarios.js --aplicar            # altera
 *   node scripts/reagendar-horarios.js --aplicar --avisar   # e avisa quem mudou (1 aviso por pessoa)
 *   node scripts/reagendar-horarios.js --empresa <id>       # limita a uma empresa
 *
 * A lista mostra: tarefa, dia, pessoa, propriedade, antes e depois. Sem dados de hóspedes.
 * Nota: sem --aplicar, as passagens para outra pessoa são uma ESTIMATIVA (o motor vê
 * a base como está, sem as outras alterações da mesma execução).
 */
const mongoose = require('mongoose');

const H = require('../utils/horario');

const hh = (d) => (H.temHoraReal(d) ? H.hhmm(H.minutosLocais(d)) : '00:00 (sem hora)');

/** A hora desta tarefa está fora do horário de trabalho? */
function foraDoHorario(t) {
  if (!H.temHoraReal(t.data)) return true; // meia-noite: atribuída sem hora
  const ini = H.minutosLocais(t.data);
  const dur = Number(t.tempo_limpeza_minutos) || 45;
  return ini < H.HORARIO.INICIO_DIA || ini >= H.HORARIO.FIM_DIA || ini + dur > H.HORARIO.FIM_MAXIMO_LIMPEZA;
}

/**
 * @param {object} [o]
 * @param {boolean} [o.aplicar=false]
 * @param {boolean} [o.avisar=false] - com aplicar: avisa só quem mudou (1x por pessoa) e os gestores se sobrar por atribuir
 * @param {Date} [o.agora=new Date()]
 * @param {*} [o.empresaId] - limita a uma empresa
 * @returns {Promise<{ aplicado, total, reagendadas, passadas, porAtribuir, linhas: object[], avisos: number }>}
 */
async function reagendarHorarios({ aplicar = false, avisar = false, agora = new Date(), empresaId = null } = {}) {
  const Tarefa = require('../models/Tarefa');
  const Utilizador = require('../models/Utilizador');
  const { idsEquipa } = require('../utils/equipaTarefa');
  const { obterRangeDia, itemDeTarefa, prepararViagens } = require('../utils/scheduler');
  const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');

  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const filtro = { estado: 'atribuida', data: { $gte: hoje } };
  if (empresaId) filtro.empresa_id = empresaId;

  const candidatas = await Tarefa.find(filtro)
    .populate({ path: 'propriedade_id', select: 'nome coordenadas staff_necessario empresa_id' })
    .sort({ data: 1, _id: 1 })
    .lean();
  const afetadas = candidatas.filter((t) => foraDoHorario(t) && idsEquipa(t).length > 0);

  const nomes = new Map();
  const nomeDe = async (id) => {
    const k = String(id);
    if (!nomes.has(k)) {
      const u = await Utilizador.findById(id).select('nome').lean();
      nomes.set(k, u ? u.nome : '?');
    }
    return nomes.get(k);
  };

  const resultado = { aplicado: !!aplicar, total: afetadas.length, reagendadas: 0, passadas: 0, porAtribuir: 0, linhas: [], avisos: 0 };
  const sobrepostas = new Map(); // dry-run: id -> { data, ids }
  const mudaram = new Map(); // pessoa -> { hora: n, saiu: n, entrou: n }
  const marca = (id, campo) => {
    const k = String(id);
    const m = mudaram.get(k) || { hora: 0, saiu: 0, entrou: 0 };
    m[campo]++;
    mudaram.set(k, m);
  };

  const cacheDias = new Map();
  const tarefasDoDia = async (diaISO, recarregar = false) => {
    if (recarregar || !cacheDias.has(diaISO)) {
      const r = obterRangeDia(diaISO);
      const q = { data: { $gte: r.start, $lt: r.end }, estado: { $nin: ['cancelada'] } };
      if (empresaId) q.empresa_id = empresaId;
      cacheDias.set(diaISO, await Tarefa.find(q).populate({ path: 'propriedade_id', select: 'nome coordenadas' }).lean());
    }
    return cacheDias.get(diaISO).map((t) => (sobrepostas.has(String(t._id)) ? { ...t, ...sobrepostas.get(String(t._id)) } : t));
  };

  for (const t of afetadas) {
    const diaISO = H.diaUTC(t.data);
    const membros = idsEquipa(t);
    const prop = t.propriedade_id || {};
    const dur = Number(t.tempo_limpeza_minutos) || 45;
    const doDia = await tarefasDoDia(diaISO, aplicar);

    const agendas = membros.map((m) =>
      doDia
        .filter((o) => String(o._id) !== String(t._id) && idsEquipa(o).includes(String(m)))
        .map(itemDeTarefa)
        .filter(Boolean)
    );
    const nova = { duracao: dur, coord: prop.coordenadas, propId: prop._id };
    const viagemFn = await prepararViagens(agendas.flat(), { ...nova, nova: true }, obterRangeDia(diaISO).start);
    const ini = membros.length > 1 ? H.primeiroInicioEquipa(agendas, nova, viagemFn) : H.primeiroInicio(agendas[0], nova, viagemFn);

    const base = {
      tarefa: String(t._id),
      dia: diaISO,
      pessoa: (await Promise.all(membros.map(nomeDe))).join(' + '),
      propriedade: prop.nome || '—',
      antes: hh(t.data),
    };

    if (ini !== null) {
      const nova_data = H.utcDeMinutosLocais(diaISO, ini);
      let viagem = 0;
      for (const ag of agendas) {
        const ant = [...ag].sort((a, b) => b.fim - a.fim).find((x) => x.fim <= ini);
        if (ant) viagem = Math.max(viagem, viagemFn(ant, { ...nova, nova: true }));
      }
      if (aplicar) await Tarefa.updateOne({ _id: t._id, estado: 'atribuida' }, { $set: { data: nova_data, tempo_viagem_minutos: viagem } });
      else sobrepostas.set(String(t._id), { data: nova_data, tempo_viagem_minutos: viagem });
      resultado.reagendadas++;
      membros.forEach((m) => marca(m, 'hora'));
      resultado.linhas.push({ ...base, depois: H.hhmm(ini), resultado: 'reagendada' });
      continue;
    }

    // Não cabe a esta equipa: o motor procura outra pessoa (o dia da tarefa não muda).
    if (aplicar) {
      await Tarefa.updateOne(
        { _id: t._id, estado: 'atribuida' },
        { $set: { utilizador_id: null, equipa_atribuida: [], pessoas_em_falta: 0, estado: 'por_atribuir', motivo_nao_atribuicao: 'A reagendar (fora do horário)' } }
      );
      await tarefasDoDia(diaISO, true);
    }
    const plano = await planearAtribuicao({
      empresaId: t.empresa_id,
      propriedade: { ...prop, _id: prop._id },
      dia: obterRangeDia(diaISO).start,
      tempoLimpeza: dur,
    });
    if (plano.estado === 'atribuida') {
      if (aplicar) {
        await Tarefa.updateOne(
          { _id: t._id },
          { $set: {
            utilizador_id: plano.utilizador_id, equipa_atribuida: plano.equipa_atribuida, estado: 'atribuida', data: plano.data,
            tempo_viagem_minutos: plano.tempo_viagem_minutos, motivo_nao_atribuicao: null, pessoas_em_falta: plano.faltam,
          } }
        );
      } else {
        sobrepostas.set(String(t._id), { data: plano.data, utilizador_id: plano.utilizador_id, equipa_atribuida: plano.equipa_atribuida });
      }
      resultado.passadas++;
      const novos = plano.equipa_atribuida.map(String);
      membros.filter((m) => !novos.includes(String(m))).forEach((m) => marca(m, 'saiu'));
      novos.filter((m) => !membros.includes(String(m))).forEach((m) => marca(m, 'entrou'));
      resultado.linhas.push({
        ...base,
        pessoa: base.pessoa + ' -> ' + (await Promise.all(novos.map(nomeDe))).join(' + '),
        depois: hh(plano.data),
        resultado: 'passada a outra pessoa',
      });
    } else {
      const padrao = H.horaPadraoDoDia(diaISO);
      if (aplicar) {
        await Tarefa.updateOne(
          { _id: t._id },
          { $set: { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao, utilizador_id: null, equipa_atribuida: [], pessoas_em_falta: 0, data: padrao } }
        );
      } else {
        sobrepostas.set(String(t._id), { data: padrao, utilizador_id: null, equipa_atribuida: [] });
      }
      resultado.porAtribuir++;
      membros.forEach((m) => marca(m, 'saiu'));
      resultado.linhas.push({ ...base, depois: 'por atribuir', resultado: plano.motivo_nao_atribuicao || 'por atribuir' });
    }
  }

  // Avisos (só com --aplicar --avisar): uma notificação por pessoa que mudou.
  if (aplicar && avisar && mudaram.size > 0) {
    const { notificarUtilizador, avisarGestores } = require('../utils/notificar');
    for (const [id, m] of mudaram) {
      const partes = [];
      if (m.hora) partes.push(`${m.hora} limpeza(s) mudaram de hora`);
      if (m.saiu) partes.push(`${m.saiu} passaram a outra pessoa ou ficaram por atribuir`);
      if (m.entrou) partes.push(`recebeste ${m.entrou} limpeza(s)`);
      try {
        await notificarUtilizador(id, '🗓️ Horário atualizado', `Acertámos o horário: ${partes.join('; ')}. Vê a tua agenda.`, '/staff', { tipo: 'tarefa_reatribuida', criarInApp: true });
        resultado.avisos++;
      } catch (e) { /* best-effort */ }
    }
    if (resultado.porAtribuir > 0) {
      const empresas = new Set(afetadas.map((t) => String(t.empresa_id)));
      for (const e of empresas) {
        await avisarGestores(e, '⚠️ Limpezas por atribuir', `${resultado.porAtribuir} limpeza(s) não couberam no horário de ninguém e ficaram por atribuir.`, '/gestor/tarefas').catch(() => {});
      }
    }
  }
  return resultado;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Defina MONGODB_URI no ambiente.');
    process.exit(1);
  }
  const aplicar = process.argv.includes('--aplicar');
  const avisar = process.argv.includes('--avisar');
  const i = process.argv.indexOf('--empresa');
  const empresaId = i > -1 ? process.argv[i + 1] : null;
  await mongoose.connect(uri);
  try {
    const r = await reagendarHorarios({ aplicar, avisar, empresaId });
    console.log(aplicar ? 'MODO: APLICAR' : 'MODO: só leitura (use --aplicar para alterar)');
    console.log(`Fora do horário: ${r.total} | reagendadas: ${r.reagendadas} | passadas a outra pessoa: ${r.passadas} | por atribuir: ${r.porAtribuir}`);
    for (const l of r.linhas) console.log(`  ${l.tarefa} | ${l.dia} | ${l.pessoa} | ${l.propriedade} | ${l.antes} -> ${l.depois} | ${l.resultado}`);
    if (aplicar && avisar) console.log(`Avisos enviados: ${r.avisos}`);
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

module.exports = { reagendarHorarios, foraDoHorario };
