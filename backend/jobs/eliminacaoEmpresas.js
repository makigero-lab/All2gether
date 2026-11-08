/**
 * Eliminação definitiva de empresas — All2gether (RGPD, art. 28.º, n.º 3, al. g).
 *
 * Corre todos os dias às 04:10 (Europe/Lisbon). Apaga de facto as empresas cujo período de
 * segurança (`eliminacao_agendada_para`) já passou. Nunca apaga antes da data. Idempotente:
 * uma empresa já apagada deixa de existir e não volta a ser processada; uma falha a meio
 * retoma no dia seguinte (a empresa só sai no fim). Best-effort: nunca lança, e avisa os
 * Super Admins quando uma empresa não pôde ser apagada.
 */
const cron = require('node-cron');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const { apagarEmpresaDefinitivo } = require('../utils/rgpdEmpresa');
const { notificarSino } = require('../utils/notificar');

async function avisarAdmins(mensagem, chave) {
  try {
    const admins = await Utilizador.find({ role: 'admin', ativo: true, eliminado_em: null }).select('_id').lean();
    for (const a of admins) await notificarSino(a._id, mensagem, { tipo: 'aviso', url: '/admin', chave });
  } catch (e) {
    console.error('⚠️  [Eliminação] avisarAdmins:', e.message);
  }
}

async function executarEliminacaoEmpresas(agora = new Date()) {
  const out = { apagadas: 0, falhas: 0, adiadas: 0 };
  try {
    const devidas = await Empresa.find({ eliminacao_agendada_para: { $ne: null, $lte: agora } }).select('_id nome').lean();
    for (const e of devidas) {
      try {
        const r = await apagarEmpresaDefinitivo(e._id, { agora });
        if (r.apagada) {
          out.apagadas++;
          console.log(`🗑️  [Eliminação] empresa ${e._id} apagada.`);
        } else if (r.motivo === 'em_curso' || r.motivo === 'ocupada') {
          out.adiadas++;
        } else {
          out.falhas++;
          console.error(`❌ [Eliminação] empresa ${e._id} não apagada (${r.motivo}).`);
          await avisarAdmins(`A eliminação agendada da empresa "${e.nome}" não foi feita (${r.motivo}). Verifica e cancela ou corrige.`, `eliminacao_falhou:${e._id}:${agora.toISOString().slice(0, 10)}`);
        }
      } catch (err) {
        out.falhas++;
        console.error(`❌ [Eliminação] empresa ${e._id}:`, err.message);
        await avisarAdmins(`A eliminação agendada da empresa "${e.nome}" falhou. Tenta de novo amanhã ou verifica os logs.`, `eliminacao_falhou:${e._id}:${agora.toISOString().slice(0, 10)}`);
      }
    }
  } catch (err) {
    out.falhas++;
    console.error('❌ [Eliminação] job:', err.message);
  }
  return out;
}

function iniciarEliminacaoEmpresas() {
  console.log('⏰ [Eliminação] Cron agendado para 04:10 (Europe/Lisbon) diariamente.');
  cron.schedule('10 4 * * *', () => { executarEliminacaoEmpresas(); }, { timezone: 'Europe/Lisbon' });
  return { executarEliminacaoEmpresas };
}

module.exports = { iniciarEliminacaoEmpresas, executarEliminacaoEmpresas };
