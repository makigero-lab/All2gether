/**
 * Smoobu Controller — Autocell
 *
 * Sincronização em massa de reservas do Smoobu via REST API.
 *
 * Ao contrário do webhook (que é push — o Smoobu envia quando há nova reserva),
 * este endpoint é pull — o Admin pede ao Autocell para ir buscar todas as
 * reservas futuras ao Smoobu e criarem as tarefas correspondentes.
 *
 * Casos de uso:
 *   - Configuração inicial: importar reservas já existentes no Smoobu antes
 *     de o webhook ter sido configurado.
 *   - Recuperação: re-importar reservas que possam ter sido perdidas (webhook
 *     em baixo, BD reiniciada, etc.).
 *   - Auditoria: confirmar que não há reservas sem tarefa associada.
 *
 * A idempotência é garantida pela função `processarReservaSmoobu` (verifica
 * `smoobu_reserva_id` antes de criar). Correr várias vezes não cria duplicados.
 */

const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');

/**
 * POST /api/admin/smoobu/sincronizar
 *
 * Vai buscar todas as reservas futuras (a partir de hoje) ao Smoobu via REST API
 * e cria as tarefas correspondentes usando a mesma lógica do webhook.
 *
 * Fluxo:
 *   1. Valida que SMOOBU_API_KEY está configurada.
 *   2. Calcula a data de hoje (YYYY-MM-DD) para não importar o passado.
 *   3. Faz fetch a https://login.smoobu.com/api/reservations?from=YYYY-MM-DD
 *      com o header Api-Key.
 *   4. Itera sobre o array `reservations` do JSON de resposta.
 *   5. Para cada reserva, mapeia para o formato do webhook e chama
 *      `_processarReservaSmoobu` (que tem idempotência integrada).
 *   6. Cada reserva é envolvida num try/catch — se uma falhar, as outras
 *      continuam.
 *   7. Devolve um JSON com contadores: total recebida, importadas (criadas
 *      ou já existentes), erros, e detalhe de cada erro.
 *
 * Resposta 200:
 *   {
 *     totalRecebidas: number,
 *     importadas: number,       // criadas + já existentes (idempotentes)
 *     criadas: number,          // novas (tarefa criada)
 *     existentes: number,       // já tinham tarefa (idempotência)
 *     erros: number,
 *     detalheErros: [{ reservaId, erro }]
 *   }
 *
 * Respostas de erro:
 *   400 — SMOOBU_API_KEY não configurada
 *   502 — erro no fetch ao Smoobu (timeout, 4xx/5xx, JSON inválido)
 *   500 — erro interno
 */
exports.sincronizarReservas = async (req, res) => {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({
      erro:
        'SMOOBU_API_KEY não configurada. Define-a nas variáveis de ambiente do backend.',
    });
  }

  // Data de hoje em YYYY-MM-DD (UTC) — não importamos o passado.
  const agora = new Date();
  const from = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);

  // Fetch ao Smoobu.
  let respostaSmoobu;
  try {
    respostaSmoobu = await fetch(
      `https://login.smoobu.com/api/reservations?from=${from}`,
      {
        method: 'GET',
        headers: {
          'Api-Key': apiKey.trim(),
          Accept: 'application/json',
        },
        // Timeout de 30s — o Smoobu pode demorar se houver muitas reservas.
        signal: AbortSignal.timeout(30000),
      }
    );
  } catch (err) {
    console.error('❌ sincronizarReservas: fetch falhou:', err.message);
    return res.status(502).json({
      erro: 'Não foi possível ligar ao Smoobu.',
      detalhe: err.message,
    });
  }

  if (!respostaSmoobu.ok) {
    const texto = await respostaSmoobu.text().catch(() => '');
    console.error(
      `❌ sincronizarReservas: Smoobu devolveu ${respostaSmoobu.status} ${respostaSmoobu.statusText}`
    );
    return res.status(502).json({
      erro: `Smoobu devolveu erro ${respostaSmoobu.status}.`,
      detalhe: texto.slice(0, 500) || respostaSmoobu.statusText,
    });
  }

  let body;
  try {
    body = await respostaSmoobu.json();
  } catch (err) {
    console.error('❌ sincronizarReservas: JSON inválido:', err.message);
    return res.status(502).json({
      erro: 'Resposta do Smoobu não é JSON válido.',
      detalhe: err.message,
    });
  }

  // O Smoobu devolve { reservations: [...] } ou { data: { reservations: [...] } }
  // consoante a versão da API. Cobrimos ambas.
  const reservas =
    body?.reservations ??
    body?.data?.reservations ??
    (Array.isArray(body) ? body : []);

  if (!Array.isArray(reservas)) {
    return res.status(502).json({
      erro: 'Resposta do Smoobu não contém array "reservations".',
      detalhe: JSON.stringify(body).slice(0, 500),
    });
  }

  // Importa a função de processamento do webhook (idempotente).
  const { _processarReservaSmoobu } = require('./webhookController');

  let criadas = 0;
  let existentes = 0;
  let erros = 0;
  const detalheErros = [];

  for (const reserva of reservas) {
    const reservaId = reserva?.id ?? reserva?.reservationId ?? reserva?.reservation_id;

    try {
      // Verifica idempotência ANTES de chamar o processador (otimização:
      // evita refazer o load balancer se a tarefa já existe). O processador
      // também verifica, mas assim poupamos trabalho e conseguimos distinguir
      // "criada" de "já existente" nos contadores.
      let jaExistia = false;
      if (reservaId) {
        const existente = await Tarefa.findOne({
          smoobu_reserva_id: String(reservaId),
        }).lean();
        if (existente) {
          jaExistia = true;
        }
      }

      // Mapeia a reserva do formato REST API para o formato do webhook.
      // O processador espera: { action, data: { id, arrival, apartment: { id, name } } }
      const payloadWebhook = {
        action: 'newReservation',
        data: {
          id: reserva.id,
          arrival: reserva.arrival ?? reserva.start_date ?? reserva.startDate,
          apartment: {
            id: reserva.apartment?.id ?? reserva.apartment_id ?? reserva.apartmentId,
            name: reserva.apartment?.name ?? reserva.apartment_name,
          },
        },
      };

      const resultado = await _processarReservaSmoobu(payloadWebhook);

      if (jaExistia) {
        existentes++;
      } else if (resultado) {
        criadas++;
      }
      // resultado null = action ignorada ou reserva sem tarefa (não conta)
    } catch (err) {
      erros++;
      detalheErros.push({
        reservaId: reservaId != null ? String(reservaId) : null,
        erro: err.message,
      });
      console.error(
        `⚠️  sincronizarReservas: reserva ${reservaId} falhou:`,
        err.message
      );
      // Continua para a próxima reserva.
    }
  }

  console.log(
    `✅ sincronizarReservas: ${reservas.length} recebidas, ${criadas} criadas, ` +
      `${existentes} já existiam, ${erros} com erro.`
  );

  return res.status(200).json({
    totalRecebidas: reservas.length,
    importadas: criadas + existentes,
    criadas,
    existentes,
    erros,
    detalheErros,
  });
};

/* ------------------------------------------------------------------ */
/* Listar propriedades do Smoobu                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/smoobu/propriedades
 *
 * Vai buscar a lista de apartamentos ao Smoobu via REST API (endpoint
 * oficial `/api/apartments`) e devolve-a ao frontend de forma limpa.
 *
 * Isto facilita o mapeamento no fluxo de criação de propriedades: em vez
 * de o Admin ter de digitar o `smoobu_id` manualmente, o frontend pode
 * mostrar um dropdown com os apartamentos que vêm do Smoobu.
 *
 * Requer: variável de ambiente SMOOBU_API_KEY.
 *
 * Resposta 200: { propriedadesSmoobu: [{ id, name, ... }, ...] }
 *
 * Erros:
 *   400 — SMOOBU_API_KEY não configurada
 *   502 — erro no fetch ao Smoobu (timeout, 4xx/5xx, JSON inválido)
 *   500 — erro interno
 */
exports.getPropriedadesSmoobu = async (req, res) => {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({
      erro:
        'SMOOBU_API_KEY não configurada. Define-a nas variáveis de ambiente do backend.',
    });
  }

  let respostaSmoobu;
  try {
    respostaSmoobu = await fetch('https://login.smoobu.com/api/apartments', {
      method: 'GET',
      headers: {
        'Api-Key': apiKey.trim(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('❌ getPropriedadesSmoobu: fetch falhou:', err.message);
    return res.status(502).json({
      erro: 'Não foi possível ligar ao Smoobu.',
      detalhe: err.message,
    });
  }

  if (!respostaSmoobu.ok) {
    const texto = await respostaSmoobu.text().catch(() => '');
    console.error(
      `❌ getPropriedadesSmoobu: Smoobu devolveu ${respostaSmoobu.status} ${respostaSmoobu.statusText}`
    );
    return res.status(502).json({
      erro: `Smoobu devolveu erro ${respostaSmoobu.status}.`,
      detalhe: texto.slice(0, 500) || respostaSmoobu.statusText,
    });
  }

  let body;
  try {
    body = await respostaSmoobu.json();
  } catch (err) {
    console.error('❌ getPropriedadesSmoobu: JSON inválido:', err.message);
    return res.status(502).json({
      erro: 'Resposta do Smoobu não é JSON válido.',
      detalhe: err.message,
    });
  }

  // O Smoobu devolve { apartments: [...] }. Cobrimos variantes por precaução.
  const apartments =
    body?.apartments ?? body?.data?.apartments ?? (Array.isArray(body) ? body : []);

  if (!Array.isArray(apartments)) {
    return res.status(502).json({
      erro: 'Resposta do Smoobu não contém array "apartments".',
      detalhe: JSON.stringify(body).slice(0, 500),
    });
  }

  // Devolve apenas os campos úteis ao frontend (id + name), evitando
  // vazar informação sensível ou campos volumosos desnecessários.
  const propriedadesSmoobu = apartments.map((a) => ({
    id: a.id,
    name: a.name,
  }));

  return res.status(200).json({ propriedadesSmoobu });
};

/* ------------------------------------------------------------------ */
/* Sincronizar propriedades do Smoobu (upsert)                        */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/smoobu/sincronizar-propriedades
 *
 * Importa em massa os apartamentos do Smoobu para a coleção Propriedade.
 * Usa upsert com `$setOnInsert`: insere APENAS as propriedades que ainda
 * não existem (por `smoobu_id`). As propriedades já existentes NÃO são
 * alteradas — preserva edições manuais do Admin (nome, morada, tempo de
 * limpeza, coordenadas, ativo).
 *
 * Isto é útil na configuração inicial: em vez de criar cada propriedade à
 * mão, o Admin sincroniza todas de uma vez e depois edita só as que precisam
 * de ajustes (morada, tempo de limpeza).
 *
 * Requer: variável de ambiente SMOOBU_API_KEY.
 *
 * Resposta 200:
 *   {
 *     totalRecebidas: number,
 *     criadas: number,       // novas (inseridas)
 *     existentes: number,    // já existiam (não mexidas)
 *     erros: number,
 *     detalheErros: [{ smoobuId, erro }]
 *   }
 *
 * Erros:
 *   400 — SMOOBU_API_KEY não configurada
 *   502 — erro no fetch ao Smoobu (timeout, 4xx/5xx, JSON inválido)
 *   500 — erro interno
 */
exports.sincronizarPropriedades = async (req, res) => {
  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({
      erro:
        'SMOOBU_API_KEY não configurada. Define-a nas variáveis de ambiente do backend.',
    });
  }

  // empresa_id vem do JWT (injetado pelo middleware auth).
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    return res.status(400).json({ erro: 'empresa_id em falta no token.' });
  }

  // Fetch ao Smoobu (mesmo endpoint do getPropriedadesSmoobu).
  let respostaSmoobu;
  try {
    respostaSmoobu = await fetch('https://login.smoobu.com/api/apartments', {
      method: 'GET',
      headers: {
        'Api-Key': apiKey.trim(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('❌ sincronizarPropriedades: fetch falhou:', err.message);
    return res.status(502).json({
      erro: 'Não foi possível ligar ao Smoobu.',
      detalhe: err.message,
    });
  }

  if (!respostaSmoobu.ok) {
    const texto = await respostaSmoobu.text().catch(() => '');
    console.error(
      `❌ sincronizarPropriedades: Smoobu devolveu ${respostaSmoobu.status} ${respostaSmoobu.statusText}`
    );
    return res.status(502).json({
      erro: `Smoobu devolveu erro ${respostaSmoobu.status}.`,
      detalhe: texto.slice(0, 500) || respostaSmoobu.statusText,
    });
  }

  let body;
  try {
    body = await respostaSmoobu.json();
  } catch (err) {
    console.error('❌ sincronizarPropriedades: JSON inválido:', err.message);
    return res.status(502).json({
      erro: 'Resposta do Smoobu não é JSON válido.',
      detalhe: err.message,
    });
  }

  const apartments =
    body?.apartments ?? body?.data?.apartments ?? (Array.isArray(body) ? body : []);

  if (!Array.isArray(apartments)) {
    return res.status(502).json({
      erro: 'Resposta do Smoobu não contém array "apartments".',
      detalhe: JSON.stringify(body).slice(0, 500),
    });
  }

  // Upsert de cada apartamento. $setOnInsert garante que só escreve na
  // criação — propriedades existentes não são tocadas (preserva edições).
  let criadas = 0;
  let existentes = 0;
  let erros = 0;
  const detalheErros = [];

  for (const apt of apartments) {
    const smoobuId = apt?.id != null ? String(apt.id) : null;
    try {
      if (!smoobuId) {
        throw new Error('Apartamento sem id.');
      }

      const resultado = await Propriedade.updateOne(
        { smoobu_id: smoobuId },
        {
          $setOnInsert: {
            nome: apt.name || `Propriedade ${smoobuId}`,
            empresa_id: empresaId,
            tempo_limpeza_minutos: 45,
          },
        },
        { upsert: true }
      );

      // upsertedCount > 0 → nova; modifiedCount/existing → já existia.
      if (resultado.upsertedCount > 0) {
        criadas++;
      } else {
        existentes++;
      }
    } catch (err) {
      erros++;
      detalheErros.push({ smoobuId, erro: err.message });
      console.error(
        `⚠️  sincronizarPropriedades: apartamento ${smoobuId} falhou:`,
        err.message
      );
      // Continua para o próximo.
    }
  }

  console.log(
    `✅ sincronizarPropriedades: ${apartments.length} recebidas, ${criadas} criadas, ` +
      `${existentes} já existiam, ${erros} com erro.`
  );

  return res.status(200).json({
    totalRecebidas: apartments.length,
    criadas,
    existentes,
    erros,
    detalheErros,
  });
};
