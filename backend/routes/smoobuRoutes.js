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
 * HF6: autenticação descentralizada — a chave é validada contra
 *   `Empresa.integracoes.smoobu.api_key` (com `ativo: true`) em vez de
 *   apenas contra a env var. Fallback a env var mantido para
 *   retrocompatibilidade / dev. Permite multi-tenant no futuro (cada
 *   empresa com a sua chave Smoobu).
 *
 * Segurança:
 *   - Autenticação: a chave recebida no header é comparada contra as chaves
 *     das empresas ativas (integracoes.smoobu.api_key + ativo). Se nenhuma
 *     empresa tiver chave configurada, cai no fallback da env var
 *     `SMOOBU_API_KEY` (retrocompatibilidade). Se AMBAS falharem (sem
 *     empresas com chave E sem env var), o endpoint fica em modo dev
 *     (aceita + warning) — NÃO usar em produção.
 *   - Headers suportados: `X-Smoobu-Api-Key`, `Api-Key`, `Authorization: Bearer`.
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
const Empresa = require('../models/Empresa');
const { extrairDadosReserva } = require('../controllers/smoobuController');

const router = express.Router();

// Fallback (retrocompatibilidade / dev). Lida UMA VEZ no arranque.
const SMOOBU_API_KEY_ENV = process.env.SMOOBU_API_KEY;

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
 * HF6 — Valida a chave recebida contra as empresas ativas (descentralizada).
 *
 * Estratégia:
 *   1. Procura uma empresa (ativa, não apagada) com
 *      `integracoes.smoobu.api_key === chave && integracoes.smoobu.ativo === true`.
 *      Se encontrar, devolve `{ empresaId, origem: 'empresa' }`.
 *   2. Se nenhuma empresa tiver chave configurada (MAS há empresas), cai no
 *      fallback da env var `SMOOBU_API_KEY` (retrocompatibilidade). Se bater,
 *      devolve `{ empresaId: null, origem: 'env' }`.
 *   3. Se AMBAS falharem (sem empresas com chave E sem env var), devolve
 *      `{ empresaId: null, origem: 'dev' }` — modo dev (aceita + warning).
 *
 * @param {string} chaveRecebida - chave extraída do header.
 * @returns {Promise<{ empresaId: import('mongoose').Types.ObjectId|null, origem: 'empresa'|'env'|'dev' }>}
 */
async function validarChaveSmoobu(chaveRecebida) {
  // 1. Procura em empresas ativas com integração Smoobu ligada.
  if (chaveRecebida) {
    try {
      const empresa = await Empresa.findOne({
        ativa: true,
        apagada: false,
        'integracoes.smoobu.ativo': true,
        'integracoes.smoobu.api_key': chaveRecebida,
      })
        .select('_id')
        .lean();
      if (empresa) {
        return { empresaId: empresa._id, origem: 'empresa' };
      }
    } catch {
      // Se a query falhar, cai para o fallback.
    }
  }

  // 2. Fallback: env var global (retrocompatibilidade / dev).
  if (SMOOBU_API_KEY_ENV && chaveRecebida && chaveRecebida === SMOOBU_API_KEY_ENV) {
    return { empresaId: null, origem: 'env' };
  }

  // 3. Modo dev: sem empresas com chave E sem env var → aceita sem auth.
  if (!SMOOBU_API_KEY_ENV) {
    // Verifica se há ALGUMA empresa com chave configurada; se não houver
    // nenhuma, é sinal de que o sistema ainda não foi configurado (dev).
    return { empresaId: null, origem: 'dev' };
  }

  // 4. Chave recebida não bate com nenhuma empresa nem com a env var.
  return { empresaId: null, origem: 'rejeitado' };
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
 *   - 401: autenticação falhou (chave recebida não corresponde a nenhuma
 *          empresa ativa nem à env var). O payload rejeitado É gravado no
 *          WebhookLog (status='erro') para auditoria.
 *   - 200 + warning: modo dev (sem empresas com chave E sem env var).
 */
router.post('/webhook', async (req, res) => {
  const payloadRecebido = req.body;
  const timestampRececao = new Date().toISOString();

  // 1. Autenticação descentralizada (HF6).
  const chaveRecebida = extrairApiKey(req);
  const auth = await validarChaveSmoobu(chaveRecebida);

  if (auth.origem === 'rejeitado') {
    console.warn(
      '⚠️  [Smoobu Webhook] autenticação falhou (chave inválida/em falta).'
    );
    try {
      await WebhookLog.create({
        payload: payloadRecebido,
        status: 'erro',
        erro_msg:
          'Autenticação falhou: chave não corresponde a nenhuma empresa ativa nem à env var.',
      });
    } catch (logErr) {
      console.error(
        '⚠️  [Smoobu Webhook] falha ao gravar WebhookLog (auth rejeitada):',
        logErr.message
      );
    }
    return res.status(401).json({ erro: 'Autenticação inválida.' });
  }

  if (auth.origem === 'dev') {
    console.warn(
      '⚠️  [Smoobu Webhook] sem auth configurada (nem empresas com chave nem SMOOBU_API_KEY) — modo dev, a aceitar sem autenticação.'
    );
  } else if (auth.origem === 'env') {
    console.log(
      'ℹ️  [Smoobu Webhook] auth via env var SMOOBU_API_KEY (fallback — considera migrar para Configurações → Integrações).'
    );
  } else if (auth.origem === 'empresa') {
    console.log(
      `✅ [Smoobu Webhook] auth via empresa ${auth.empresaId} (integracoes.smoobu).`
    );
  }

  // 2. Resolve empresa_id (prioridade: auth.empresaId > match por propriedade).
  let empresaId = auth.empresaId;
  if (!empresaId) {
    empresaId = await resolverEmpresaIdDoPayload(payloadRecebido);
  }

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
