/**
 * Fecho automático das limpezas — Cron Job (All2gether)
 *
 * Todos os dias às 20:00 (Europe/Lisbon) passa a 'concluida' as limpezas do dia que ficaram
 * 'em_curso' com pessoa atribuída e que ninguém fechou (o início automático põe-nas 'em_curso'
 * à hora marcada). O lembrete para fechar a tarefa sai uma hora antes (19:00, caoGuarda).
 *
 * Marca o fecho como AUTOMÁTICO (`conclusao_origem: 'automatica'`, `fechada_automaticamente_em`):
 * não prova que a limpeza foi feita, por isso não avisa o proprietário, não conta no tempo real e a
 * prova mostra «fechada pelo sistema». `concluida_em` = hora do fecho; `hora_conclusao` fica vazia.
 *
 * O que NÃO fecha (decisões):
 *   - manutenções (concluir resolveria a avaria);
 *   - 'em_curso' sem ninguém (o gestor decide, como já hoje);
 *   - 'atribuida' (a pessoa nunca começou: o início automático não a arrancou porque ela registou
 *     «Não consegui começar», está inativa ou a hora é inválida). Fechá-la afirmaria um trabalho
 *     de que não há sinal nenhum; fica à vista do gestor como pendente;
 *   - canceladas/concluídas.
 *
 * Segurança: a escrita é condicional (só se o estado ainda for 'em_curso' e ainda houver pessoa),
 * logo idempotente e à prova de corrida com a pessoa a fechar, de duas instâncias e de reexecuções.
 * Recuperação: o servidor pode estar a dormir às 20:00 (Render), por isso o job corre também ao
 * arrancar e de hora a hora; apanha os dias já passados até {JANELA_RECUPERACAO_DIAS} dias atrás
 * (mais antigos ficam para o gestor). O dia de hoje só entra depois das 20:00 de Lisboa.
 */

const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const H = require('../utils/horario');

const HORA_FECHO = 20; // Lisboa
const JANELA_RECUPERACAO_DIAS = 3;

/** Dias ('aaaa-mm-dd') cuja hora de fecho já passou em `agora`: de hoje (se >= 20:00) para trás. */
function diasParaFechar(agora) {
  const hoje = H.hojeLisboa(agora);
  const dias = [];
  if (H.minutosLocais(agora) >= HORA_FECHO * 60) dias.push(hoje);
  for (let i = 1; i <= JANELA_RECUPERACAO_DIAS; i++) dias.push(H.somarDiasISO(hoje, -i));
  return dias;
}

/**
 * @param {Date} [agora]
 * @returns {Promise<{ candidatas: number, fechadas: number }>}
 */
async function executarFechoAutomatico(agora = new Date()) {
  try {
    const dias = diasParaFechar(agora);
    // O dia de uma tarefa é o dia UTC de `data` (convenção de horario.js).
    const desde = new Date(`${dias[dias.length - 1]}T00:00:00.000Z`);
    const ate = new Date(`${H.somarDiasISO(dias[0], 1)}T00:00:00.000Z`);
    const candidatas = await Tarefa.find({
      tipo: 'limpeza',
      estado: 'em_curso',
      utilizador_id: { $ne: null },
      fechada_automaticamente_em: null, // fechada uma vez: se o gestor a reabrir, não volta a fechar
      data: { $gte: desde, $lt: ate },
    })
      .select('data')
      .lean();

    let fechadas = 0;
    for (const t of candidatas) {
      if (!dias.includes(H.diaUTC(t.data))) continue;
      const r = await Tarefa.updateOne(
        { _id: t._id, tipo: 'limpeza', estado: 'em_curso', utilizador_id: { $ne: null }, fechada_automaticamente_em: null },
        { $set: { estado: 'concluida', conclusao_origem: 'automatica', concluida_em: agora, data_conclusao: agora, fechada_automaticamente_em: agora } }
      );
      if (r.modifiedCount > 0) fechadas++;
    }
    if (fechadas > 0) {
      console.log(`🔒 [Fecho automático] ${fechadas} limpeza(s) fechadas pelo sistema.`);
    }
    return { candidatas: candidatas.length, fechadas };
  } catch (err) {
    // Falha visível (não parece «0 limpezas»): o chamador regista e tenta de novo na hora seguinte.
    console.error('❌ [Fecho automático] Erro:', err.message);
    return { candidatas: 0, fechadas: 0, erro: err.message };
  }
}

/** 20:00 (Europe/Lisbon) + recuperação 30 s após o arranque e de hora a hora. */
function iniciarFechoAutomatico() {
  console.log(`⏰ [Fecho automático] Cron agendado para ${HORA_FECHO}:00 (Europe/Lisbon), com recuperação ao arrancar e de hora a hora.`);
  let aCorrer = false;
  const correr = async () => {
    if (aCorrer) return; // sem sobreposição
    aCorrer = true;
    try {
      await executarFechoAutomatico();
    } finally {
      aCorrer = false;
    }
  };
  cron.schedule(`0 ${HORA_FECHO} * * *`, correr, { timezone: 'Europe/Lisbon' });
  const t0 = setTimeout(correr, 30 * 1000);
  const t1 = setInterval(correr, 60 * 60 * 1000);
  if (t0.unref) t0.unref();
  if (t1.unref) t1.unref();
  return { executarFechoAutomatico };
}

module.exports = { iniciarFechoAutomatico, executarFechoAutomatico, diasParaFechar, HORA_FECHO, JANELA_RECUPERACAO_DIAS };
