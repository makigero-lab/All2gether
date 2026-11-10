/**
 * Ofertas de vagas à equipa — job (ver utils/ofertaVaga.js).
 * De 5 em 5 minutos (Europe/Lisbon): fecha/expira as ofertas que chegaram ao prazo (e avisa os
 * gestores) e abre ofertas para as limpezas com vaga que ainda não tenham uma. É a rede de
 * segurança de todos os sítios onde uma limpeza pode ficar sem ninguém (Smoobu, proprietário,
 * reatribuições, rotinas). Sem sobreposição; uma execução 20 s após o arranque.
 */
const cron = require('node-cron');
const { ofertasAtivas, expirarOfertas, abrirOfertasPendentes } = require('../utils/ofertaVaga');

async function executarOfertasVagas(agora = new Date()) {
  if (!ofertasAtivas()) return { desativado: true };
  try {
    const exp = await expirarOfertas(agora);
    const ab = await abrirOfertasPendentes(agora);
    if (exp.expiradas || exp.fechadas || ab.abertas) {
      console.log(`🙋 [Vagas livres] ${ab.abertas} oferta(s) aberta(s), ${exp.expiradas} expirada(s), ${exp.fechadas} fechada(s).`);
    }
    return { ...exp, ...ab };
  } catch (err) {
    console.error('❌ [Vagas livres] erro:', err.message);
    return { erro: err.message };
  }
}

function iniciarOfertasVagas() {
  console.log('⏰ [Vagas livres] Cron agendado de 5 em 5 minutos (*/5 * * * *).');
  let aCorrer = false;
  const correr = async () => {
    if (aCorrer) return;
    aCorrer = true;
    try { await executarOfertasVagas(); } finally { aCorrer = false; }
  };
  cron.schedule('*/5 * * * *', correr, { timezone: 'Europe/Lisbon' });
  const t0 = setTimeout(correr, 20 * 1000);
  if (t0.unref) t0.unref();
  return { executarOfertasVagas };
}

module.exports = { iniciarOfertasVagas, executarOfertasVagas };
