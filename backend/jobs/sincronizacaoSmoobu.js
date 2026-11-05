/**
 * Sincronização Smoobu — Cron Job (All2gether) — HF6 + HF7
 *
 * Corre a cada hora e, para cada empresa com `rotinas.sincronizacao_automatica
 * === true` e `integracoes.smoobu.ativo === true`, verifica se é altura de
 * sincronizar com base na `frequencia_horas` e `ultima_sincronizacao`.
 *
 * Se for altura (ultima_sincronizacao + frequencia_horas < agora), chama
 * `sincronizarReservas` — o motor de backfill que puxa TODAS as reservas
 * futuras do Smoobu (REST API + paginação) e processa cada uma via
 * `processarReservaSmoobu` (cria tarefas, cancela reservas canceladas,
 * idempotente). O próprio handler atualiza `ultima_sincronizacao` no fim.
 *
 * HF7 — Antes deste hotfix, o cron chamava `importarPropriedades` como
 * placeholder (só sincronizava propriedades, não reservas). Agora chama
 * `sincronizarReservas` (o motor real de reservas → tarefas).
 *
 * RECONCILIAÇÃO (rede de segurança dos webhooks): desligada por defeito (toggle por empresa),
 * intervalo mínimo 1 hora, sem sobreposição de execuções, só reservas com check-out de hoje em
 * diante, pedidos espaçados. Usa `req.reconciliacao` no handler: NÃO reativa tarefas canceladas,
 * não toca em concluídas/em curso e não recria tarefas de reservas manuais. Também retoma
 * webhooks presos (`recebido` há mais de 10 min). A sincronização manual mantém o comportamento.
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
const MIN_FREQUENCIA_HORAS = 1;
const TOLERANCIA_MS = 5 * 60 * 1000; // o tick corre ao minuto 15; evita saltar 1 hora por segundos
let sincronizacaoEmCurso = false;
let retomaEmCurso = false;

async function executarSincronizacaoSmoobu() {
  if (sincronizacaoEmCurso) {
    console.warn('⚠️  [Sincronização Smoobu] execução anterior ainda em curso — a saltar.');
    return { processadas: 0, saltadas: 0, erros: 0, sobreposta: true };
  }
  sincronizacaoEmCurso = true;
  try {
    return await executarSincronizacaoSmoobuInterno();
  } finally {
    sincronizacaoEmCurso = false;
  }
}

async function executarSincronizacaoSmoobuInterno() {
  const agora = new Date();
  console.log(`🔄 [Sincronização Smoobu] a verificar empresas elegíveis (${agora.toISOString()}).`);

  // Empresas com o toggle ligado. A chave pode vir da BD ou da env var SMOOBU_API_KEY
  // (obterApiKeySmoobu); só é saltada quem desligou a integração de forma explícita
  // (chave na BD com ativo=false) ou não tem chave nenhuma (aviso).
  const candidatas = await Empresa.find({
    ativa: true,
    apagada: false,
    'rotinas.sincronizacao_automatica': true,
  })
    .select('_id nome rotinas integracoes.smoobu')
    .lean();

  const { obterApiKeySmoobu } = require('../controllers/smoobuController');
  const empresas = [];
  for (const emp of candidatas) {
    const smoobu = emp.integracoes?.smoobu;
    if (smoobu?.ativo === false && smoobu?.api_key && String(smoobu.api_key).trim()) {
      console.log(`ℹ️  [Sincronização Smoobu] empresa ${emp._id} ("${emp.nome}"): integração desativada — saltada.`);
      continue;
    }
    const { chave } = await obterApiKeySmoobu(emp._id);
    if (!chave) {
      console.warn(
        `⚠️  [Sincronização Smoobu] empresa ${emp._id} ("${emp.nome}") tem a sincronização automática ligada mas NÃO há chave Smoobu (nem na BD nem em SMOOBU_API_KEY) — saltada.`
      );
      continue;
    }
    empresas.push(emp);
  }

  if (empresas.length === 0) {
    console.log('ℹ️  [Sincronização Smoobu] nenhuma empresa elegível para sincronização automática.');
    return { processadas: 0, saltadas: 0, erros: 0 };
  }

  let processadas = 0;
  let saltadas = 0;
  let erros = 0;

  for (const empresa of empresas) {
    const freqHoras = Math.max(MIN_FREQUENCIA_HORAS, Number(empresa.rotinas?.frequencia_horas) || 24);
    const ultima = empresa.integracoes?.smoobu?.ultima_sincronizacao;
    const empresaId = empresa._id;

    // Verifica se está devidade (ultima + freq < agora).
    if (ultima) {
      const proximaDevida = new Date(ultima.getTime() + freqHoras * 60 * 60 * 1000 - TOLERANCIA_MS);
      if (proximaDevida > agora) {
        saltadas++;
        continue;
      }
    }

    // Dispara a sincronização de RESERVAS (HF7 — motor real).
    // O handler `sincronizarReservas` puxa todas as reservas futuras do Smoobu
    // e processa cada uma (cria tarefas, cancela canceladas, idempotente).
    // Também atualiza `ultima_sincronizacao` no fim (internamente).
    try {
      const { sincronizarReservas } = require('../controllers/smoobuController');
      // Simula um req/res mínimo para reutilizar o handler existente.
      // Isto evita duplicar a lógica. O handler não usa res para nada além
      // de res.status().json() no fim, que capturamos aqui para log.
      const reqFake = {
        user: { empresa_id: empresaId },
        reconciliacao: true,
        pausaMs: Number(process.env.SMOOBU_RECONCILIACAO_PAUSA_MS ?? 400),
      };
      let resultado = null;
      let statusHttp = 200;
      const resFake = {
        status: (code) => {
          statusHttp = code;
          return {
            json: (data) => {
              resultado = data;
            },
          };
        },
      };
      await sincronizarReservas(reqFake, resFake);

      // O handler devolve o erro via res (não lança): só conta como sucesso com 200.
      // Em falha NÃO marca ultima_sincronizacao (nova tentativa no próximo tick).
      if (statusHttp !== 200) {
        throw new Error(`sincronizarReservas devolveu ${statusHttp}: ${resultado?.erro || 'sem detalhe'}`);
      }

      const summary = resultado
        ? `${resultado.criadas || 0} tarefas criadas, ${resultado.existentes || 0} já existiam, ${resultado.erros || 0} erros (de ${resultado.totalRecebidas || 0} reservas)`
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
 * Retoma webhooks presos: logs `recebido` há mais de `idadeMinutos` (processo reiniciado a meio,
 * erro ao gravar o estado...). Idempotente: o processamento já o é (tarefa por reserva) e cada
 * log é "reservado" atomicamente antes de ser processado, para duas instâncias não o repetirem.
 * Um log é saltado se existir um evento POSTERIOR da mesma reserva já processado (reprocessar o
 * antigo poderia desfazer, por exemplo, um cancelamento). Limite por execução.
 *
 * @returns {Promise<{ retomados: number, saltados: number, erros: number }>}
 */
async function retomarWebhooksPresos({ idadeMinutos = 10, limite = 20, maxIdadeDias = 7 } = {}) {
  if (retomaEmCurso) return { retomados: 0, saltados: 0, erros: 0, sobreposta: true };
  retomaEmCurso = true;
  try {
    const WebhookLog = require('../models/WebhookLog');
    const Empresa = require('../models/Empresa');
    const { processarWebhookSmoobu } = require('../controllers/smoobuController');

    const agora = Date.now();
    const corte = new Date(agora - idadeMinutos * 60 * 1000);
    const desde = new Date(agora - maxIdadeDias * 24 * 60 * 60 * 1000);

    const candidatos = await WebhookLog.find({
      status: 'recebido',
      updatedAt: { $lt: corte },
      createdAt: { $gt: desde },
    })
      .sort({ createdAt: 1 })
      .limit(limite)
      .select('_id')
      .lean();

    let retomados = 0;
    let saltados = 0;
    let erros = 0;

    for (const c of candidatos) {
      // Reserva atómica: só quem conseguir mudar updatedAt processa este log.
      const log = await WebhookLog.findOneAndUpdate(
        { _id: c._id, status: 'recebido', updatedAt: { $lt: corte } },
        { $set: { updatedAt: new Date() } },
        { new: true, timestamps: false }
      ).lean();
      if (!log) continue; // outra instância/execução apanhou-o

      try {
        const rid = log.payload?.data?.id;
        let superado = false;
        if (rid != null) {
          const ids = [String(rid)];
          if (/^\d+$/.test(String(rid))) ids.push(Number(rid));
          superado = Boolean(
            await WebhookLog.exists({
              _id: { $ne: log._id },
              status: 'processado',
              createdAt: { $gt: log.createdAt },
              'payload.data.id': { $in: ids },
            })
          );
        }
        if (superado) {
          await WebhookLog.findByIdAndUpdate(log._id, {
            status: 'processado',
            erro_msg: 'Não retomado: existe um evento posterior da mesma reserva já processado.',
          });
          saltados++;
          continue;
        }

        if (log.empresa_id) {
          const emp = await Empresa.findById(log.empresa_id).select('integracoes.smoobu.ativo').lean();
          if (emp && emp.integracoes?.smoobu?.ativo === false) {
            await WebhookLog.findByIdAndUpdate(log._id, {
              status: 'processado',
              erro_msg: 'Integração Smoobu desativada para esta empresa. Não retomado.',
            });
            saltados++;
            continue;
          }
        }

        await processarWebhookSmoobu(log.payload, log._id, log.empresa_id || null, log.empresa_id || null);
        retomados++;
      } catch (err) {
        erros++;
        console.error(`❌ [Webhooks presos] log ${log._id} falhou:`, err.message);
      }
    }

    if (candidatos.length > 0) {
      console.log(
        `🔁 [Webhooks presos] ${retomados} retomado(s), ${saltados} saltado(s), ${erros} com erro (de ${candidatos.length}).`
      );
    }
    return { retomados, saltados, erros };
  } finally {
    retomaEmCurso = false;
  }
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

  // Retoma de webhooks presos (recuperação, independente do toggle da reconciliação).
  console.log('⏰ [Webhooks presos] Cron agendado de 15 em 15 minutos (*/15 * * * *).');
  cron.schedule('*/15 * * * *', async () => {
    try {
      await retomarWebhooksPresos();
    } catch (err) {
      console.error('❌ [Webhooks presos] erro não capturado no cron:', err.message);
    }
  });

  return { executarSincronizacaoSmoobu, retomarWebhooksPresos };
}

module.exports = { iniciarSincronizacaoSmoobu, executarSincronizacaoSmoobu, retomarWebhooksPresos };
