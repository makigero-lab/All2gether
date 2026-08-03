/**
 * Rotas: /api/smoobu
 *
 * Endpoint de receção de webhooks INBOUND do Smoobu (plataforma de
 * Alojamento Local). O Smoobu envia eventos de reserva (criação, atualização,
 * cancelamento) para este endpoint quando configurado no painel do Smoobu.
 *
 * F0 (histórico): a antiga integração Smoobu (que convertia reservas em
 * tarefas de limpeza automaticamente via `criarTarefaPorReserva`) foi
 * removida. O modelo `WebhookLog` foi mantido precisamente para esta
 * re-integração. Esta versão implementa a camada de RECEÇÃO + LOG
 * (auditoria) — o processamento de reservas em tarefas é uma funcionalidade
 * separada (ver WORKLOG.md, Task HF3 — Próximos passos).
 *
 * Segurança:
 *   - Autenticação via env var `SMOOBU_API_KEY`. O Smoobu deve enviar a
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
 *     o Smoobu para de fazer retries em 2xx). Erros de processamento futuro
 *     ficarão registados em `WebhookLog.status = 'erro'` para reprocesso.
 *
 * Rate limiting:
 *   - A rota `/api/smoobu` está ISENTA do rate limiter global (100 req/15min)
 *     definido em server.js — os webhooks são M2M de um IP conhecido (Smoobu)
 *     e podem burstar. A autenticação via SMOOBU_API_KEY substitui a proteção
 *     anti-abuso que o rate limiter proporciona noutros endpoints.
 */

const express = require('express');
const WebhookLog = require('../models/WebhookLog');

const router = express.Router();

// Lida UMA VEZ no arranque. Se vazia, o endpoint fica em modo dev (sem auth).
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;

/**
 * Extrai a chave de API do pedido, procurando em vários headers comuns.
 * O Smoobu permite configurar o header no painel, pelo que suportamos:
 *   - X-Smoobu-Api-Key  (header custom, mais comum)
 *   - Api-Key           (header genérico)
 *   - Authorization: Bearer <key>  (standard OAuth/Bearer)
 *
 * @param {import('express').Request} req
 * @returns {string | null} a chave extraída, ou null se não vier no pedido.
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
 * POST /api/smoobu/webhook
 *
 * Recebe um evento do Smoobu, valida a autenticação, grava o payload no
 * `WebhookLog` (best-effort) e devolve 200.
 *
 * Respostas:
 *   - 200: payload recebido e gravado (ou gravado com warning de log).
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
  //    Se SMOOBU_API_KEY estiver definida, valida a chave recebida.
  //    Se NÃO estiver definida (dev), aceita mas avisa (NÃO usar em prod).
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

  // 2. Grava o payload no WebhookLog (best-effort — NUNCA crasha o pedido).
  let webhookLogId = null;
  try {
    const log = await WebhookLog.create({
      payload: payloadRecebido,
      status: 'recebido',
    });
    webhookLogId = log._id;
    console.log(
      `📥 [Smoobu Webhook] payload recebido e gravado (WebhookLog=${log._id}).`
    );
  } catch (logErr) {
    // O log falhou, mas o pedido NÃO deve crashar — o Smoobu faria retry.
    // Devolve 200 mesmo assim: o serviço continua disponível e o erro fica
    // no log do servidor para investigação.
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

  // 3. Processamento — PLACEHOLDER (F0).
  //    A conversão de reservas Smoobu em tarefas de limpeza foi removida em
  //    F0. Re-implementar requer: mapear o payload Smoobu → Propriedade
  //    existente (match por smoobu_id/morada) + detalhes_reserva (checkin,
  //    checkout, pax, nome_hospede) + chamar o load balancer para atribuir
  //    staff. Ver WORKLOG.md Task HF3 — Próximos passos.
  //    Por agora: marca como 'processado' (receção confirmada, sem ação de
  //    domínio). Os payloads ficam disponíveis em WebhookLog para reprocesso
  //    assim que a lógica de conversão existir.
  try {
    await WebhookLog.findByIdAndUpdate(webhookLogId, {
      status: 'processado',
    });
  } catch (updateErr) {
    // Não-crítico: o payload já está gravado como 'recebido'.
    console.error(
      '⚠️  [Smoobu Webhook] falha ao marcar como processado:',
      updateErr.message
    );
  }

  // 4. Devolve 200 — webhook best practice (o Smoobu para de fazer retries).
  return res.status(200).json({
    recebido: true,
    log_id: webhookLogId,
    timestamp: timestampRececao,
  });
});

module.exports = router;
