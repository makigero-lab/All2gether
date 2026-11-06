/**
 * Resumo das 18:05 para o gestor — Cron Job (All2gether)
 *
 * Uma única mensagem (via `avisarGestores`: sino + push) com o que pede atenção:
 *   - limpezas de HOJE não concluídas;
 *   - limpezas de AMANHÃ por atribuir;
 *   - avarias abertas;
 *   - ausências pendentes de decisão.
 * Só envia se houver pelo menos uma coisa a dizer. Idempotente por dia e por gestor
 * (chave `resumo18:AAAA-MM-DD` na notificação). Ao arrancar, se o servidor esteve em baixo às
 * 18:05, recupera até às 23:00 (a chave impede duplicados).
 */
const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const Ausencia = require('../models/Ausencia');
const Utilizador = require('../models/Utilizador');
const { avisarGestores } = require('../utils/notificar');
const { contarAvariasAbertas } = require('../utils/avarias');
const { FILTRO_SEM_PESSOA } = require('../utils/atribuicaoAutomatica');

/** 'AAAA-MM-DD' e minutos desde as 00:00 em Lisboa. */
function agoraLisboa(d = new Date()) {
  const p = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  for (const x of fmt.formatToParts(d)) if (x.type !== 'literal') p[x.type] = x.value;
  return { dia: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

/** Conta o que há a reportar para uma empresa. */
async function contarResumo(empresaId, diaISO) {
  const hojeIni = new Date(`${diaISO}T00:00:00.000Z`);
  const amanhaIni = new Date(hojeIni.getTime() + 24 * 3600 * 1000);
  const depoisIni = new Date(amanhaIni.getTime() + 24 * 3600 * 1000);
  const [hojeNaoConcluidas, amanhaPorAtribuir, avarias, ausencias] = await Promise.all([
    Tarefa.countDocuments({
      empresa_id: empresaId, tipo: 'limpeza', data: { $gte: hojeIni, $lt: amanhaIni },
      estado: { $nin: ['concluida', 'cancelada'] },
    }),
    Tarefa.countDocuments({
      empresa_id: empresaId, tipo: 'limpeza', data: { $gte: amanhaIni, $lt: depoisIni },
      $or: [{ estado: { $in: ['por_atribuir', 'nao_atribuida'] } }, FILTRO_SEM_PESSOA],
    }),
    contarAvariasAbertas(empresaId),
    Ausencia.countDocuments({ empresa_id: empresaId, estado: { $in: ['pendente', 'pendente_emergencia'] } }),
  ]);
  return { hojeNaoConcluidas, amanhaPorAtribuir, avarias, ausencias };
}

function montarTexto(c) {
  const partes = [];
  if (c.hojeNaoConcluidas) partes.push(plural(c.hojeNaoConcluidas, 'limpeza de hoje por concluir', 'limpezas de hoje por concluir'));
  if (c.amanhaPorAtribuir) partes.push(plural(c.amanhaPorAtribuir, 'limpeza de amanhã por atribuir', 'limpezas de amanhã por atribuir'));
  if (c.avarias) partes.push(plural(c.avarias, 'avaria aberta', 'avarias abertas'));
  if (c.ausencias) partes.push(plural(c.ausencias, 'ausência pendente', 'ausências pendentes'));
  return partes.join(' · ');
}

/**
 * @param {Date} [agora]
 * @returns {Promise<{ empresas: number, enviados: number }>}
 */
async function executarResumoGestor(agora = new Date()) {
  try {
    const { dia } = agoraLisboa(agora);
    const empresas = await Utilizador.distinct('empresa_id', {
      role: { $in: ['gestor', 'admin'] }, ativo: true, eliminado_em: null, empresa_id: { $ne: null },
    });
    let enviados = 0;
    for (const empresaId of empresas) {
      const c = await contarResumo(empresaId, dia);
      const texto = montarTexto(c);
      if (!texto) continue; // nada a reportar: não envia
      await avisarGestores(empresaId, '🗒️ Resumo do dia', texto, '/gestor', { chave: `resumo18:${dia}` });
      enviados++;
    }
    return { empresas: empresas.length, enviados };
  } catch (err) {
    console.error('❌ [Resumo gestor] Erro:', err.message);
    return { empresas: 0, enviados: 0, erro: err.message };
  }
}

function iniciarResumoGestor() {
  console.log('⏰ [Resumo gestor] Cron agendado para 18:05 (Europe/Lisbon) diariamente.');
  cron.schedule('5 18 * * *', () => executarResumoGestor(), { timezone: 'Europe/Lisbon' });
  // Recuperação: servidor reiniciado depois das 18:05 (e antes das 23:00).
  const { minutos } = agoraLisboa();
  if (minutos >= 18 * 60 + 5 && minutos < 23 * 60) {
    const t = setTimeout(() => executarResumoGestor(), 30 * 1000);
    if (t.unref) t.unref();
  }
  return { executarResumoGestor };
}

module.exports = { iniciarResumoGestor, executarResumoGestor, contarResumo, montarTexto, agoraLisboa };
