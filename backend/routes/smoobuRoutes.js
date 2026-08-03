/**
 * Rotas: /api/smoobu
 *
 * Endpoint de receção de webhooks INBOUND do Smoobu (plataforma de
 * Alojamento Local). O Smoobu envia eventos de reserva (criação, atualização,
 * cancelamento) para este endpoint quando configurado no painel do Smoobu.
 *
 * HF3: criado o recetor/logger (auth SMOOBU_API_KEY + WebhookLog best-effort).
 * HF4: integrada a lógica de conversão de reservas em tarefas (controller
 *   smoobuController.js). Padrão anti-timeout do Smoobu: resposta 200
 *   IMEDIATA + processamento assíncrono via setImmediate.
 *
 * Segurança:
 *   - Autenticação via env var `SMOOOBU_API_KEY`. O Smoobu deve enviar a
 *     chave num dos headers suportados: `X-Smoobu-Api-Key`, `Api-Key` ou
 *     `Authorization: Bearer <key>` (flexível — o Smoobu permite configurar
 *     o header no painel).
 *   - Se a env var NÃO estiver definida, o endpoint aceita todos os pedidos
 *     (modo dev) mas emite um warning no log — em produção a env var TEM de
 *     estar definida para evitar aceitar payloads não autorizados.
 *
 * Robustez (anti-crash):
 *   - O payload é sempre gravado em `WebhookLog` num bloco try/catch —
 *     uma falha na BD NUNCA aborta o pedido (o Smoobu faria retry em cadeia).
 *   - Devolve sempre 200 para pedidos autenticados (webhook best practice —
 *     o Smoobu para de fazer retries em 2xx). Erros de processamento ficam
 *     registados em `WebhookLog.status = 'erro'` para reprocesso.
 *   - O processamento de conversão reserva→tarefa corre ASSINCRONAMENTE
 *     (setImmediate) depois do 200 ser enviado — o Smoobu cancela pedidos
 *     demorados (>~10s), pelo que NUNCA podemos bloquear a resposta.
 *
 * Rate limiting:
 *   - A rota `/api/smoobu` está ISENTA do rate limiter global (100 req/15min)
 *     definido em server.js — os webhooks são M2M de um IP conhecido (Smoobu)
 *     e podem burstar. A autenticação via SMOOBU_API_KEY substitui a proteção
 *     anti-abuso que o rate limiter proporciona noutros endpoints.
 */

const express = require('express');
const WebhookLog = require('../models/WebhookLog');
const Propriedade = require('../models/Propriedade');
const { extrairDadosReserva } = require('../controllers/smoobuController');

const router = express.Router();

// Lida UMA VEZ no arranque. Se vazia, o endpoint fica em modo dev (sem auth).
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;

/**
 * Extrai a chave de API do pedido, procurando em vários headers comuns.
 * O Smoobu permite configurar o header no painel, pelo que suportamos:
 *   - X-Smoobu-Api-Key  (header custom, mais comum)
 *   - Api-Key           (header genérico)
 *   - Authorization: Bearer <key>  (standard OAuth/Bearer)
 */
function extrairApiKey(req) {
  const xSmoobu = req.get('X-Smoobu-Api-Key');
  if (xSmoobu) return xSmoobu.trim();

  const apiKey = req.get('Api-Key');
  if (apiKey) return apiKey.trim();

  const auth = req.get('Authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return null;
}

/**
 * Resolve o empresa_id a partir do payload (best-effort, para o WebhookLog).
 * Procura a propriedade pelo smoobu_id extraído do payload. Se não encontrar,
 * devolve null (o log fica sem empresa — não bloqueia o processamento).
 */
async function resolverEmpresaIdDoPayload(payload) {
  try {
    const { smoobuPropId } = extrairDadosReserva(payload);
    if (!smoobuPropId) return null;
    const prop = await Propriedade.findOne({ smoobu_id: smoobuPropId })
      .select('empresa_id')
      .lean();
    return prop?.empresa_id ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/smoobu/webhook
 *
 * Recebe um evento do Smoobu, valida a autenticação, grava o payload no
 * `WebhookLog` (best-effort), devolve 200 IMEDIATO, e dispara o
 * processamento assíncrono de conversão reserva→tarefa via setImmediate.
 *
 * Respostas:
 *   - 200: payload recebido e gravado (processamento decorre em background).
 *   - 401: autenticação falhou (SMOOBU_API_KEY definida mas chave recebida
 *          não corresponde). O payload rejeitado É gravado no WebhookLog
 *          (status='erro') para auditoria.
 *   - 200 + warning: SMOOBU_API_KEY não configurada (modo dev) — aceita mas
 *          avisa no log.
 */
router.post('/webhook', async (req, res) => {
  const payloadRecebido = req.body;
  const timestampRececao = new Date().toISOString();

  // 1. Autenticação.
  if (SMOOBU_API_KEY) {
    const chaveRecebida = extrairApiKey(req);
    if (!chaveRecebida || chaveRecebida !== SMOOBU_API_KEY) {
      console.warn(
        '⚠️  [Smoobu Webhook] autenticação falhou (chave inválida/em falta).'
      );
      // Grava o payload rejeitado para auditoria (best-effort).
      try {
        await WebhookLog.create({
          payload: payloadRecebido,
          status: 'erro',
          erro_msg:
            'Autenticação falhou: SMOOBU_API_KEY inválida ou em falta no header.',
        });
      } catch (logErr) {
        console.error(
          '⚠️  [Smoobu Webhook] falha ao gravar WebhookLog (auth rejeitada):',
          logErr.message
        );
      }
      return res.status(401).json({ erro: 'Autenticação inválida.' });
    }
  } else {
    console.warn(
      '⚠️  [Smoobu Webhook] SMOOBU_API_KEY não configurada — a aceitar pedidos sem autenticação (modo dev).'
    );
  }

  // 2. Resolve empresa_id (best-effort, para o WebhookLog) — NÃO bloqueia.
  const empresaId = await resolverEmpresaIdDoPayload(payloadRecebido);

  // 3. Grava o payload no WebhookLog (best-effort — NUNCA crasha o pedido).
  let webhookLogId = null;
  try {
    const log = await WebhookLog.create({
      payload: payloadRecebido,
      status: 'recebido',
      empresa_id: empresaId || undefined,
    });
    webhookLogId = log._id;
    console.log(
      `📥 [Smoobu Webhook] payload recebido e gravado (WebhookLog=${log._id}${
        empresaId ? `, empresa=${empresaId}` : ''
      }).`
    );
  } catch (logErr) {
    // O log falhou, mas o pedido NÃO deve crashar — o Smoobu faria retry.
    console.error(
      '⚠️  [Smoobu Webhook] falha ao gravar WebhookLog:',
      logErr.message
    );
    return res.status(200).json({
      recebido: true,
      aviso: 'Payload recebido mas o registo de log falhou.',
      timestamp: timestampRececao,
    });
  }

  // 4. Devolve 200 IMEDIATO (anti-timeout do Smoobu). O processamento
  //    de conversão reserva→tarefa corre assincronamente via setImmediate.
  //    Isto é CRÍTICO: o Smoobu cancela pedidos demorados (>~10s) e faz
  //    retry, o que levaria a tarefas duplicadas. Respondendo 200 primeiro
  //    e processando depois, garantimos que o Smoobu não reenvia.
  res.status(200).json({
    recebido: true,
    log_id: webhookLogId,
    timestamp: timestampRececao,
  });

  // 5. Processamento assíncrono (fire-and-forget).
  //    setImmediate garante que o loop de eventos envia o 200 ANTES de
  //    iniciar o processamento pesado (load balancer, REST API do Smoobu,
  //    criação de tarefa, notificações).
  if (webhookLogId) {
    setImmediate(async () => {
      // require inline para evitar dependência circular no arranque e
      // permitir que o controller use os modelos já carregados.
      const { processarWebhookSmoobu } = require('../controllers/smoobuController');
      try {
        await processarWebhookSmoobu(payloadRecebido, webhookLogId, empresaId);
      } catch (err) {
        // Captura de segurança extra — processarWebhookSmoobu já tem o seu
        // próprio try/catch, mas isto garante que NUNCA há unhandledRejection.
        console.error(
          '❌ [Smoobu Webhook] erro não capturado no processamento assíncrono:',
          err.message
        );
        try {
          await WebhookLog.findByIdAndUpdate(webhookLogId, {
            status: 'erro',
            erro_msg: `Erro não capturado: ${err.message}`,
          });
        } catch {
          /* já fizemos o que podíamos */
        }
      }
    });
  }
});

module.exports = router;
