/**
 * Sincronização Smoobu — Cron Job (All2gether) — HF6
 *
 * Corre a cada hora e, para cada empresa com `rotinas.sincronizacao_automatica
 * === true` e `integracoes.smoobu.ativo === true`, verifica se é altura de
 * sincronizar com base na `frequencia_horas` e `ultima_sincronizacao`.
 *
 * Se for altura (ultima_sincronizacao + frequencia_horas < agora), chama a
 * lógica de importação de propriedades (que popula `Propriedade.smoobu_id`).
 *
 * NOTA: O backfill de RESERVAS em massa (`sincronizarReservas` do legacy)
 * ainda não foi portado (follow-up do HF5). Até lá, este job sincroniza
 * PROPRIEDADES (que é o pré-requisito para o webhook HF4 funcionar).
 * Quando `sincronizarReservas` for portado, substituir a chamada
 * `importarPropriedades` por `sincronizarReservas` aqui.
 *
 * Robustez:
 *   - Erros por empresa são loggados mas não param o job (try/catch por iteração).
 *   - Uma empresa com erro fica com `ultima_sincronizacao` inalterada (será
 *     tentada novamente no próximo tick do cron).
 */

const cron = require('node-cron');
const Empresa = require('../models/Empresa');

/**
 * Itera sobre as empresas elegíveis e dispara a sincronização das que
 * estão devidas (ultima_sincronizacao + frequencia_horas < agora).
 *
 * @returns {Promise<{ processadas: number, saltadas: number, erros: number }>}
 */
async function executarSincronizacaoSmoobu() {
  const agora = new Date();
  console.log(`🔄 [Sincronização Smoobu] a verificar empresas elegíveis (${agora.toISOString()}).`);

  // Procura empresas com sincronização automática ligada E integração ativa.
  const empresas = await Empresa.find({
    ativa: true,
    apagada: false,
    'rotinas.sincronizacao_automatica': true,
    'integracoes.smoobu.ativo': true,
    'integracoes.smoobu.api_key': { $ne: '', $exists: true },
  })
    .select('_id nome rotinas integracoes.smoobu')
    .lean();

  if (empresas.length === 0) {
    console.log('ℹ️  [Sincronização Smoobu] nenhuma empresa com sincronização automática ativa.');
    return { processadas: 0, saltadas: 0, erros: 0 };
  }

  let processadas = 0;
  let saltadas = 0;
  let erros = 0;

  for (const empresa of empresas) {
    const freqHoras = Number(empresa.rotinas?.frequencia_horas) || 24;
    const ultima = empresa.integracoes?.smoobu?.ultima_sincronizacao;
    const empresaId = empresa._id;

    // Verifica se está devidade (ultima + freq < agora).
    if (ultima) {
      const proximaDevida = new Date(ultima.getTime() + freqHoras * 60 * 60 * 1000);
      if (proximaDevida > agora) {
        saltadas++;
        continue;
      }
    }

    // Dispara a sincronização (placeholder: chama importarPropriedades).
    // Quando `sincronizarReservas` for portado, substituir aqui.
    try {
      const { importarPropriedades } = require('../controllers/smoobuController');
      // Simula um req/res mínimo para reutilizar o handler existente.
      // Isto evita duplicar a lógica de upsert. O handler não usa res para
      // nada além de res.status().json() no fim, que ignoramos aqui.
      const reqFake = { user: { empresa_id: empresaId } };
      let resultado = null;
      const resFake = {
        status: () => ({
          json: (data) => {
            resultado = data;
          },
        }),
      };
      await importarPropriedades(reqFake, resFake);

      // Atualiza ultima_sincronizacao (mesmo se houve erros parciais nas
      // propriedades — a sincronização foi tentada e não vale a pena repetir
      // imediatamente).
      await Empresa.findByIdAndUpdate(empresaId, {
        $set: { 'integracoes.smoobu.ultima_sincronizacao': new Date() },
      });

      const summary = resultado
        ? `${resultado.criadas || 0} criadas, ${resultado.atualizadas || 0} atualizadas, ${resultado.erros || 0} erros`
        : 'sem detalhe';
      console.log(
        `✅ [Sincronização Smoobu] empresa ${empresaId} ("${empresa.nome}") sincronizada: ${summary}.`
      );
      processadas++;
    } catch (err) {
      erros++;
      console.error(
        `❌ [Sincronização Smoobu] empresa ${empresaId} ("${empresa.nome}") falhou:`,
        err.message
      );
      // Não atualiza ultima_sincronizacao — será tentada novamente no próximo tick.
    }
  }

  console.log(
    `🔄 [Sincronização Smoobu] concluído: ${processadas} processada(s), ${saltadas} saltada(s) (ainda não devidas), ${erros} com erro.`
  );
  return { processadas, saltadas, erros };
}

/**
 * Agenda o cron job para correr a cada hora (no minuto 15 para evitar
 * colisão com outros jobs agendados no topo da hora).
 */
function iniciarSincronizacaoSmoobu() {
  console.log('⏰ [Sincronização Smoobu] Cron agendado para cada hora (15 * * * *).');

  cron.schedule('15 * * * *', async () => {
    try {
      await executarSincronizacaoSmoobu();
    } catch (err) {
      console.error('❌ [Sincronização Smoobu] erro não capturado no cron:', err.message);
    }
  });

  return { executarSincronizacaoSmoobu };
}

module.exports = { iniciarSincronizacaoSmoobu, executarSincronizacaoSmoobu };
