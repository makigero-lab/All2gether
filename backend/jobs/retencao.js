/**
 * Retenção de dados pessoais (RGPD) — All2gether.
 *
 * Corre todos os dias às 03:30 (Europe/Lisbon). Já existiam TTL para ContactoHospede (email/telefone,
 * 90 dias após o check-out) e WebhookLog (check-out + 90 dias). Este job cobre o resto:
 *   - Nomes e notas de hóspedes (Tarefa, TarefaArquivo, ReservaManual): anonimizados 90 dias
 *     depois do dia da limpeza/check-out (a limpeza e o histórico ficam, sem dados da pessoa).
 *   - Ausências: baixas por doença (dado de saúde) apagadas 12 meses depois do fim; as outras
 *     (férias, faltas, folgas) 36 meses depois do fim. Valores por defeito, ajustáveis por ambiente:
 *     RETENCAO_HOSPEDES_DIAS, RETENCAO_AUSENCIAS_DOENCA_MESES, RETENCAO_AUSENCIAS_MESES.
 * Idempotente e best-effort (nunca lança).
 */
const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const ReservaManual = require('../models/ReservaManual');
const Ausencia = require('../models/Ausencia');

function inteiro(nome, padrao, min, max) {
  const n = Number(process.env[nome]);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

async function executarRetencao(agora = new Date()) {
  const diasHospedes = inteiro('RETENCAO_HOSPEDES_DIAS', 90, 30, 3650);
  const mesesDoenca = inteiro('RETENCAO_AUSENCIAS_DOENCA_MESES', 12, 1, 120);
  const mesesAusencias = inteiro('RETENCAO_AUSENCIAS_MESES', 36, 1, 120);
  const out = { hospedes: 0, ausencias: 0 };
  try {
    const limiteHospedes = new Date(agora.getTime() - diasHospedes * 86400000);
    const comDados = {
      $or: [
        { 'detalhes_reserva.nome_hospede': { $nin: [null, ''] } },
        { 'detalhes_reserva.notas_hospede': { $nin: [null, ''] } },
      ],
    };
    const limpar = { $set: { 'detalhes_reserva.nome_hospede': null, 'detalhes_reserva.notas_hospede': null } };
    for (const Modelo of [Tarefa, TarefaArquivo]) {
      const r = await Modelo.collection.updateMany({ data: { $lt: limiteHospedes }, ...comDados }, limpar);
      out.hospedes += r.modifiedCount || 0;
    }
    const rr = await ReservaManual.collection.updateMany(
      { check_out: { $lt: limiteHospedes }, nome_hospede: { $nin: [null, ''] } },
      { $set: { nome_hospede: null } }
    );
    out.hospedes += rr.modifiedCount || 0;

    const menos = (meses) => { const d = new Date(agora); d.setMonth(d.getMonth() - meses); return d; };
    const a1 = await Ausencia.deleteMany({ tipo: 'doenca', data_fim: { $lt: menos(mesesDoenca) } });
    const a2 = await Ausencia.deleteMany({ tipo: { $ne: 'doenca' }, data_fim: { $lt: menos(mesesAusencias) } });
    out.ausencias = (a1.deletedCount || 0) + (a2.deletedCount || 0);

    if (out.hospedes || out.ausencias) {
      console.log(`🧹 [Retenção] ${out.hospedes} registo(s) de hóspedes anonimizado(s), ${out.ausencias} ausência(s) apagada(s).`);
    }
  } catch (err) {
    console.error('❌ [Retenção] erro:', err.message);
    out.erro = err.message;
  }
  return out;
}

function iniciarRetencao() {
  console.log('⏰ [Retenção] Cron agendado para 03:30 (Europe/Lisbon) diariamente.');
  cron.schedule('30 3 * * *', () => { executarRetencao(); }, { timezone: 'Europe/Lisbon' });
  return { executarRetencao };
}

module.exports = { iniciarRetencao, executarRetencao };
