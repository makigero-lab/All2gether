/**
 * Início automático da limpeza — Cron Job (All2gether)
 *
 * Início HÍBRIDO: o staff carrega em «Comecei» (grava `iniciada_em`, `inicio_origem: 'botao'`).
 * Se ninguém carregar, este job passa a limpeza de 'atribuida' a 'em_curso' à hora marcada
 * (`inicio_origem: 'automatico'`, `iniciada_em` = hora marcada).
 *
 * Regras:
 *   - Só limpezas (tipo 'limpeza') com hora real (não a meia-noite/placeholder) e com
 *     responsável ativo. Sem responsável nunca arranca sozinha.
 *   - Não arranca se o staff registou «Não consegui começar» (o gestor foi avisado).
 *   - Idempotente: o update é atómico e filtra por estado 'atribuida'; duas instâncias ou
 *     duas execuções seguidas não repetem nada.
 *   - Recuperação: corre ao arrancar o servidor e de minuto a minuto; apanha as limpezas cuja
 *     hora passou durante um reinício, até {JANELA_RECUPERACAO_HORAS} h para trás (mais
 *     antigas ficam para o gestor: não se «começa» sozinha uma limpeza de ontem).
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const H = require('../utils/horario');

const JANELA_RECUPERACAO_HORAS = 12;

/**
 * @param {Date} [agora]
 * @returns {Promise<{ candidatas: number, iniciadas: number }>}
 */
async function executarInicioAutomatico(agora = new Date()) {
  try {
    const desde = new Date(agora.getTime() - JANELA_RECUPERACAO_HORAS * 60 * 60 * 1000);
    const candidatas = await Tarefa.find({
      tipo: 'limpeza',
      estado: 'atribuida',
      utilizador_id: { $ne: null },
      data: { $gte: desde, $lte: agora },
      nao_consegui_comecar: { $exists: false },
    })
      .populate({ path: 'utilizador_id', select: 'ativo eliminado_em' })
      .select('data utilizador_id')
      .lean();

    let iniciadas = 0;
    for (const t of candidatas) {
      const u = t.utilizador_id;
      if (!u || !u.ativo || u.eliminado_em) continue;
      if (!H.temHoraReal(t.data)) continue;
      const r = await Tarefa.updateOne(
        { _id: t._id, estado: 'atribuida', utilizador_id: { $ne: null }, nao_consegui_comecar: { $exists: false } },
        { $set: { estado: 'em_curso', iniciada_em: t.data, inicio_origem: 'automatico', iniciada_por: null } }
      );
      if (r.modifiedCount > 0) iniciadas++;
    }
    if (iniciadas > 0) {
      console.log(`▶️  [Início automático] ${iniciadas} limpeza(s) passaram a «em curso».`);
    }
    return { candidatas: candidatas.length, iniciadas };
  } catch (err) {
    console.error('❌ [Início automático] Erro:', err.message);
    return { candidatas: 0, iniciadas: 0, erro: err.message };
  }
}

/** De minuto a minuto (Europe/Lisbon) + uma execução de recuperação 15 s após o arranque. */
function iniciarInicioLimpeza() {
  console.log('⏰ [Início automático] Cron agendado de minuto a minuto (* * * * *).');
  let aCorrer = false;
  const correr = async () => {
    if (aCorrer) return; // sem sobreposição
    aCorrer = true;
    try {
      await executarInicioAutomatico();
    } finally {
      aCorrer = false;
    }
  };
  cron.schedule('* * * * *', correr, { timezone: 'Europe/Lisbon' });
  const t0 = setTimeout(correr, 15 * 1000);
  if (t0.unref) t0.unref();
  return { executarInicioAutomatico };
}

module.exports = { iniciarInicioLimpeza, executarInicioAutomatico, JANELA_RECUPERACAO_HORAS };
