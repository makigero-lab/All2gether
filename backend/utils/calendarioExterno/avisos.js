/**
 * Avisos do calendário externo ao proprietário (sino) e ao gestor — All2gether.
 * Best-effort: nunca lança. Os textos nunca levam o link do calendário.
 */
const { avisarGestores, notificarSino } = require('../notificar');
const { semUrl } = require('./cifra');

const URL_PARCEIRO = '/parceiro/reservas';
const URL_GESTOR = '/gestor/propriedades';

async function avisarParceiro(parceiroId, empresaId, texto, { chave = null } = {}) {
  try {
    return await notificarSino(parceiroId, semUrl(texto), { tipo: 'aviso', url: URL_PARCEIRO, empresa_id: empresaId, chave });
  } catch (e) { console.error('⚠️  avisarParceiro (calendário):', e.message); return false; }
}

async function avisarGestor(empresaId, titulo, texto, { chave = null } = {}) {
  try {
    await avisarGestores(empresaId, titulo, semUrl(texto), URL_GESTOR, chave ? { chave } : {});
  } catch (e) { console.error('⚠️  avisarGestor (calendário):', e.message); }
}

/** Envia o resultado de uma reconciliação: uma notificação agregada por destinatário. */
async function enviarAvisosDaLeitura({ fonte, avisos }) {
  if (avisos.parceiro.length) {
    await avisarParceiro(fonte.parceiro_id, fonte.empresa_id, `Calendário ${fonte.rotulo || fonte.canal}: ${avisos.parceiro.join(' ')}`.slice(0, 900));
  }
  if (avisos.gestor.length) {
    await avisarGestor(fonte.empresa_id, 'Calendário externo', avisos.gestor.join(' ').slice(0, 900));
  }
}

module.exports = { avisarParceiro, avisarGestor, enviarAvisosDaLeitura };
