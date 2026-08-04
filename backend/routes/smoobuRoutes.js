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

// HF8 — Permite desativar completamente a auth do webhook quando o Smoobu
// não envia a chave em headers (por defeito, o Smoobu NÃO envia). Nesse caso,
// o utilizador deve garantir proteção por allowlist de IP no reverse proxy /
// Render. Por defeito: false (auth ativa). Definir SMOOBU_WEBHOOK_AUTH_DISABLED=true
// para desativar.
const SMOOBU_WEBHOOK_AUTH_DISABLED =
  String(process.env.SMOOBU_WEBHOOK_AUTH_DISABLED || '').toLowerCase() === 'true';

/**
 * Extrai a chave de API do pedido, procurando em vários headers plausíveis.
 *
 * O Smoobu permite configurar o header no painel de webhooks. Cobrimos os
 * headers mais comuns usados pelo Smoobu e por plataformas similares:
 *   - X-Smoobu-Api-Key         (header custom Smoobu)
 *   - Api-Key                   (header genérico, usado pelo Smoobu na REST API)
 *   - Authorization: Bearer     (standard OAuth/Bearer)
 *   - X-Smoobu-Webhook-Secret   (webhook secret do Smoobu)
 *   - Webhook-Secret            (variante genérica)
 *   - X-Webhook-Secret          (outra variante)
 *   - Smoobu-Api-Key            (variante sem prefixo X-)
 */
function extrairApiKey(req) {
  const candidatos = [
    'X-Smoobu-Api-Key',
    'Api-Key',
    'X-Smoobu-Webhook-Secret',
    'Webhook-Secret',
    'X-Webhook-Secret',
    'Smoobu-Api-Key',
  ];
  for (const header of candidatos) {
    const valor = req.get(header);
    if (valor && valor.trim()) return valor.trim();
  }

  // Authorization: Bearer <key> (standard).
  const auth = req.get('Authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  return null;
}

/**
 * Lista os headers presentes no pedido (para log de debug em caso de rejeição).
 * Não inclui valores sensíveis (só nomes dos headers).
 */
function listarHeadersPresentes(req) {
  const headers = Object.keys(req.headers || {});
  const relevantes = headers.filter((h) =>
    /smoobu|api|key|auth|webhook|secret|token/i.test(h)
  );
  return relevantes.length > 0 ? relevantes.join(', ') : '(nenhum relevante)';
}

/**
 * HF8 — Valida a chave recebida contra as empresas ativas (descentralizada).
 *
 * Correções vs HF6:
 *   - A query à BD NÃO exige `integracoes.smoobu.ativo: true` para a AUTH.
 *     A presença da chave na BD é suficiente para validar a autenticidade.
 *     O `ativo` controla se o PROCESSAMENTO acontece (decidido downstream),
 *     não se a auth é válida. Isto corrige o bug onde o utilizador configurava
 *     a chave mas não ligava o toggle — a auth falhava indevidamente.
 *   - Se o `ativo` estiver false, devolve `origem: 'empresa_desativada'`
 *     para o handler decidir (silenciosamente aceita mas não processa).
 *   - Se a env var `SMOOBU_WEBHOOK_AUTH_DISABLED=true`, desativa a auth
 *     completamente (para o caso do Smoobu não enviar headers — usar com
 *     allowlist de IP no reverse proxy).
 *   - Logs detalhados em caso de rejeição (quais headers foram recebidos).
 *
 * @param {string} chaveRecebida - chave extraída do header (ou null).
 * @returns {Promise<{ empresaId: import('mongoose').Types.ObjectId|null, origem: 'empresa'|'empresa_desativada'|'env'|'dev'|'auth_desativada'|'rejeitado' }>}
 */
async function validarChaveSmoobu(chaveRecebida) {
  // 0. Auth completamente desativada (SMOOBU_WEBHOOK_AUTH_DISABLED=true).
  // Usar apenas com allowlist de IP no reverse proxy.
  if (SMOOBU_WEBHOOK_AUTH_DISABLED) {
    return { empresaId: null, origem: 'auth_desativada' };
  }

  // 1. Procura em empresas ativas com a chave configurada (SEM exigir ativo).
  if (chaveRecebida) {
    try {
      const empresa = await Empresa.findOne({
        ativa: true,
        apagada: false,
        'integracoes.smoobu.api_key': chaveRecebida,
      })
        .select('_id integracoes.smoobu')
        .lean();
      if (empresa) {
        const smoobuAtivo = empresa.integracoes?.smoobu?.ativo === true;
        return {
          empresaId: empresa._id,
          origem: smoobuAtivo ? 'empresa' : 'empresa_desativada',
        };
      }
    } catch {
      // Se a query falhar, cai para o fallback.
    }
  }

  // 2. Fallback: env var global (retrocompatibilidade / dev).
  if (SMOOBU_API_KEY_ENV && chaveRecebida && chaveRecebida === SMOOBU_API_KEY_ENV) {
    return { empresaId: null, origem: 'env' };
  }

  // 3. Modo dev: sem env var E sem empresas com chave → aceita sem auth.
  //    Isto só acontece quando o sistema ainda não foi configurado.
  if (!SMOOBU_API_KEY_ENV) {
    try {
      const algumaEmpresaComChave = await Empresa.exists({
        ativa: true,
        apagada: false,
        'integracoes.smoobu.api_key': { $ne: '', $exists: true },
      });
      if (!algumaEmpresaComChave) {
        return { empresaId: null, origem: 'dev' };
      }
    } catch {
      // Se a query falhar, assume dev (não bloqueia o webhook).
      return { empresaId: null, origem: 'dev' };
    }
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

  // 1. Autenticação descentralizada (HF6 + HF8).
  const chaveRecebida = extrairApiKey(req);
  const auth = await validarChaveSmoobu(chaveRecebida);

  if (auth.origem === 'rejeitado') {
    // Log detalhado para debug: mostra quais headers foram recebidos e as
    // causas possíveis (Smoobu não envia chave? env var definida mas sem match?).
    const headersPresentes = listarHeadersPresentes(req);
    const temEnvVar = Boolean(SMOOBU_API_KEY_ENV);
    console.warn(
      `⚠️  [Smoobu Webhook] autenticação falhou.\n` +
        `   Headers recebidos (auth-relevantes): ${headersPresentes}\n` +
        `   Chave extraída: ${chaveRecebida ? '(presente, ' + chaveRecebida.length + ' chars)' : '(ausente)'}\n` +
        `   Env var SMOOBU_API_KEY: ${temEnvVar ? 'definida' : 'NÃO definida'}\n` +
        `   Possíveis causas:\n` +
        `     - O Smoobu não está a enviar a chave em nenhum header coberto\n` +
        `       (cobre: X-Smoobu-Api-Key, Api-Key, Authorization: Bearer,\n` +
        `        X-Smoobu-Webhook-Secret, Webhook-Secret, X-Webhook-Secret,\n` +
        `        Smoobu-Api-Key).\n` +
        `     - A chave recebida não corresponde a nenhuma empresa ativa na BD\n` +
        `       nem à env var SMOOBU_API_KEY.\n` +
        `     - Se o Smoobu não suportar envio de chave, define\n` +
        `       SMOOBU_WEBHOOK_AUTH_DISABLED=true e protege por allowlist de IP.`
    );
    try {
      await WebhookLog.create({
        payload: payloadRecebido,
        status: 'erro',
        erro_msg:
          'Autenticação falhou: chave não corresponde a nenhuma empresa ativa nem à env var. Verifica os logs do servidor para detalhes.',
      });
    } catch (logErr) {
      console.error(
        '⚠️  [Smoobu Webhook] falha ao gravar WebhookLog (auth rejeitada):',
        logErr.message
      );
    }
    return res.status(401).json({ erro: 'Autenticação inválida.' });
  }

  if (auth.origem === 'auth_desativada') {
    console.warn(
      '⚠️  [Smoobu Webhook] auth DESATIVADA via SMOOBU_WEBHOOK_AUTH_DISABLED=true — a aceitar sem autenticação (garante allowlist de IP no reverse proxy).'
    );
  } else if (auth.origem === 'dev') {
    console.warn(
      '⚠️  [Smoobu Webhook] sem auth configurada (nem empresas com chave nem SMOOBU_API_KEY) — modo dev, a aceitar sem autenticação.'
    );
  } else if (auth.origem === 'env') {
    console.log(
      'ℹ️  [Smoobu Webhook] auth via env var SMOOBU_API_KEY (fallback — considera migrar para Configurações → Integrações).'
    );
  } else if (auth.origem === 'empresa') {
    console.log(
      `✅ [Smoobu Webhook] auth via empresa ${auth.empresaId} (integracoes.smoobu ativo).`
    );
  } else if (auth.origem === 'empresa_desativada') {
    console.log(
      `ℹ️  [Smoobu Webhook] auth via empresa ${auth.empresaId} (integracoes.smoobu DESATIVADA — payload aceite para log mas processamento saltado).`
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

  // 4.b Se a integração Smoobu estiver DESATIVADA para esta empresa
  //     (toggle `ativo: false`), NÃO processa — só loga para auditoria.
  //     O webhook foi aceite (auth válida) mas o processamento é saltado.
  if (auth.origem === 'empresa_desativada') {
    try {
      await WebhookLog.findByIdAndUpdate(webhookLogId, {
        status: 'processado',
        erro_msg: 'Integração Smoobu desativada para esta empresa (toggle ativo=false). Payload aceite para auditoria mas não processado.',
      });
    } catch {
      /* não-crítico */
    }
    return;
  }

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
