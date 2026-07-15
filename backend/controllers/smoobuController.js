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
const Empresa = require('../models/Empresa');
// v1.60.0 (Prompt 83) — Geocoding automático de moradas importadas do Smoobu.
const { obterCoordenadas } = require('../utils/geocoding');

/**
 * Prompt 111 — Obtém a API Key do Smoobu para a empresa do utilizador.
 *
 * Prioridade:
 *   1. Empresa.smoobu_api_key (multi-tenant SaaS — cada empresa tem a sua)
 *   2. process.env.SMOOBU_API_KEY (fallback global para retrocompatibilidade)
 *
 * @param {string} empresaId
 * @returns {Promise<string|null>} — a API key ou null se não configurada
 */
async function obterApiKeySmoobu(empresaId) {
  // 1. Tenta ler a API key da empresa (multi-tenant).
  if (empresaId) {
    try {
      const empresa = await Empresa.findById(empresaId).select('smoobu_api_key').lean();
      if (empresa && empresa.smoobu_api_key && empresa.smoobu_api_key.trim()) {
        return empresa.smoobu_api_key.trim();
      }
    } catch {
      // Se falhar a leitura da empresa, continua para o fallback.
    }
  }
  // 2. Fallback: variável de ambiente global.
  const envKey = process.env.SMOOBU_API_KEY;
  return envKey && envKey.trim() ? envKey.trim() : null;
}

// Exporta para reutilização noutros controladores.
exports._obterApiKeySmoobu = obterApiKeySmoobu;

/**
 * Extrai a morada de um apartamento do Smoobu, cobrindo várias estruturas
 * possíveis da resposta do endpoint /api/apartments:
 *   - apt.location.{street, zip, city}  (documentada)
 *   - apt.address (string)
 *   - apt.address.{street, zipcode, city}
 *   - apt.{street, zip, city}
 *   - apt.city + apt.country
 * Devolve 'A definir' se não encontrar nada.
 */
function extrairMoradaSmoobu(apt) {
  // 1) apt.location (estrutura documentada do Smoobu)
  if (apt.location) {
    const partes = [apt.location.street, apt.location.zip, apt.location.city]
      .filter(Boolean);
    if (partes.length > 0) return partes.join(', ');
  }

  // 2) apt.address como string
  if (typeof apt.address === 'string' && apt.address.trim()) {
    return apt.address.trim();
  }

  // 3) apt.address como objeto
  if (apt.address && typeof apt.address === 'object') {
    const partes = [apt.address.street, apt.address.zipcode, apt.address.city]
      .filter(Boolean);
    if (partes.length > 0) return partes.join(', ');
  }

  // 4) Campos achatados no próprio apt
  const partesChat = [apt.street, apt.zip, apt.zipcode, apt.city].filter(Boolean);
  if (partesChat.length > 0) return partesChat.join(', ');

  // 5) apt.full_address
  if (typeof apt.full_address === 'string' && apt.full_address.trim()) {
    return apt.full_address.trim();
  }

  return 'A definir';
}

/**
 * POST /api/admin/smoobu/sincronizar
 *
 * Vai buscar todas as reservas futuras (a partir de hoje) ao Smoobu via REST API
 * e cria as tarefas correspondentes usando a mesma lógica do webhook.
 *
 * Fluxo:
 *   1. Valida que SMOOBU_API_KEY está configurada.
 *   2. Calcula a data de hoje (YYYY-MM-DD) para não importar o passado.
 *   3. Faz fetch a https://login.smoobu.com/api/reservations?arrivalFrom=YYYY-MM-DD
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
  const empresaId = req.user && req.user.empresa_id;
  const apiKey = await obterApiKeySmoobu(empresaId);
  if (!apiKey) {
    return res.status(400).json({
      erro: 'API Key do Smoobu não configurada. Define-a nas Configurações da empresa ou na variável SMOOBU_API_KEY.',
    });
  }

  // Data de hoje em YYYY-MM-DD (UTC) — não importamos o passado.
  const agora = new Date();
  const from = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);

  // v1.47.0 — Fetch ao Smoobu com paginação.
  // O parâmetro oficial é arrivalFrom (case-sensitive, 'F' maiúsculo).
  // O array vem em body.bookings (oficial) ou body.reservations (variantes).
  // A API pode paginar — lê todas as páginas com o loop while.
  let currentPage = 1;
  let totalPages = 1;
  let todasReservas = [];

  try {
    while (currentPage <= totalPages) {
      const url = `https://login.smoobu.com/api/reservations?arrivalFrom=${from}&page=${currentPage}`;
      const respostaSmoobu = await fetch(url, {
        method: 'GET',
        headers: {
          'Api-Key': apiKey.trim(),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!respostaSmoobu.ok) {
        const texto = await respostaSmoobu.text().catch(() => '');
        throw new Error(`Smoobu devolveu erro ${respostaSmoobu.status}: ${texto.slice(0, 200) || respostaSmoobu.statusText}`);
      }

      const body = await respostaSmoobu.json();

      const reservasPagina =
        body?.bookings ??
        body?.reservations ??
        body?.data?.reservations ??
        body?.data?.bookings ??
        (Array.isArray(body) ? body : []);

      todasReservas = todasReservas.concat(reservasPagina);

      // Atualiza o total de páginas (se o Smoobu não enviar page_count, para no 1).
      totalPages = body?.page_count || 1;
      currentPage++;
    }
  } catch (err) {
    console.error('❌ sincronizarReservas: fetch falhou:', err.message);
    return res.status(502).json({
      erro: 'Não foi possível ligar ao Smoobu.',
      detalhe: err.message,
    });
  }

  const reservas = todasReservas;

  console.log('Total recebido do Smoobu:', reservas.length);

  if (!Array.isArray(reservas)) {
    return res.status(502).json({
      erro: 'Resposta do Smoobu não contém array "bookings" ou "reservations".',
      detalhe: 'Verifica a resposta da API do Smoobu.',
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
      // O processador espera: { action, data: { id, arrival, departure,
      // apartment: { id, name }, guests, guestName, ... } }
      //
      // Prompt 139b — Cobertura exaustiva do nome do hóspede no formato REST
      // API do Smoobu. O Smoobu pode devolver: guestName, guest_name,
      // guest-name (kebab-case), guest.name, guest.firstName + guest.lastName,
      // firstName + lastName, customerName, customer.name, bookedForName, name.
      // Se não extrairmos o nome aqui, o processarReservaSmoobu vai fazer um
      // fetch extra por reserva para enriquecer (lento e desnecessário).
      const hospedeNomeSmoobu =
        reserva.guestName ?? reserva.guest_name ?? reserva['guest-name'] ??
        reserva.guest?.name ??
        (reserva.guest?.firstName || reserva.guest?.lastName
          ? [reserva.guest?.firstName, reserva.guest?.lastName].filter(Boolean).join(' ')
          : null) ??
        (reserva.firstName || reserva.lastName
          ? [reserva.firstName, reserva.lastName].filter(Boolean).join(' ')
          : null) ??
        reserva.customerName ??
        reserva.customer?.name ??
        reserva.bookedForName ??
        reserva.name ??
        null;

      const payloadWebhook = {
        action: 'newReservation',
        data: {
          id: reserva.id,
          arrival: reserva.arrival ?? reserva.start_date ?? reserva.startDate,
          departure: reserva.departure ?? reserva.end_date ?? reserva.endDate,
          apartment: {
            id: reserva.apartment?.id ?? reserva.apartment_id ?? reserva.apartmentId,
            name: reserva.apartment?.name ?? reserva.apartment_name,
          },
          // Campos extras para detalhes_reserva (check-in/out + hóspedes).
          guests: reserva.guests ?? reserva.numPeople ?? reserva.numberOfGuests ?? undefined,
          adults: reserva.adults,
          children: reserva.children,
          guestName: hospedeNomeSmoobu ?? undefined,
          firstName: reserva.firstName ?? reserva.first_name ?? undefined,
          lastName: reserva.lastName ?? reserva.last_name ?? undefined,
        },
      };

      // Prompt 102 — Se a reserva estiver cancelada no Smoobu (status =
      // 'cancelled' ou variante), dispara o gatilho de cancelamento em
      // vez de criar uma tarefa fantasma.
      const statusReserva = String(
        reserva.status ?? reserva.bookingStatus ?? ''
      ).toLowerCase();
      if (['cancelled', 'canceled', 'cancelada'].includes(statusReserva)) {
        const { cancelarTarefaPorReserva } = require('./webhookController');
        await cancelarTarefaPorReserva(reservaId);
        // Conta como "existente" (não cria nova, não conta como erro).
        existentes++;
        continue;
      }

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
  const empresaId = req.user && req.user.empresa_id;
  const apiKey = await obterApiKeySmoobu(empresaId);
  if (!apiKey) {
    return res.status(400).json({
      erro: 'API Key do Smoobu não configurada. Define-a nas Configurações da empresa.',
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
 *
 * Comportamento (Prompt 92 / Fase 1.5):
 *   - Propriedades NOVAS → são criadas com nome, morada, coordenadas
 *     (geocoding), capacidade_hospedes e tempo_limpeza_minutos (45 por defeito).
 *   - Propriedades JÁ EXISTENTES → atualiza SEMPRE a `morada` e a
 *     `capacidade_hospedes` quando o Smoobu as trouxer no payload (a fonte
 *     de verdade destes dois campos passa a ser o Smoobu). Refaz o geocoding
 *     sempre que a morada for atualizada. Os restantes campos (nome,
 *     tempo_limpeza_minutos, ativo, checklist, funcionario_preferencial_id)
 *     continuam a ser preservados, mantendo as edições manuais do gestor.
 *
 * Isto é útil tanto na configuração inicial como para manter as moradas e
 * capacidades sincronizadas com o Smoobu ao longo do tempo.
 *
 * Requer: variável de ambiente SMOOBU_API_KEY.
 *
 * Resposta 200:
 *   {
 *     totalRecebidas: number,
 *     criadas: number,        // novas (inseridas)
 *     atualizadas: number,    // já existiam e foram atualizadas (morada/capacidade)
 *     existentes: number,     // já existiam e o Smoobu não trouxe morada/capacidade
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
  // empresa_id vem do JWT (injetado pelo middleware auth).
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    return res.status(400).json({ erro: 'empresa_id em falta no token.' });
  }

  const apiKey = await obterApiKeySmoobu(empresaId);
  if (!apiKey) {
    return res.status(400).json({
      erro: 'API Key do Smoobu não configurada. Define-a nas Configurações da empresa.',
    });
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

  // v1.61.0 (Prompt 84) — Upsert inteligente: cria novas propriedades com
  // morada + geocoding + capacidade, e ATUALIZA propriedades existentes se
  // a morada for 'A definir' ou se faltar a capacidade_hospedes.
  let criadas = 0;
  let existentes = 0;
  let atualizadas = 0;
  let erros = 0;
  const detalheErros = [];

  for (const apt of apartments) {
    const smoobuId = apt?.id != null ? String(apt.id) : null;
    try {
      if (!smoobuId) {
        throw new Error('Apartamento sem id.');
      }

      // Extrair capacidade de hóspedes (Smoobu usa rooms.maxOccupancy ou maxOccupancy).
      const capacidade = apt.rooms?.maxOccupancy || apt.maxOccupancy || null;

      // Constrói morada usando o helper partilhado (cobre várias estruturas).
      let moradaTexto = extrairMoradaSmoobu(apt);

      const existente = await Propriedade.findOne({ smoobu_id: smoobuId });

      if (!existente) {
        // É NOVA: Faz geocoding e cria.
        let coords = { lat: null, lng: null };
        if (moradaTexto !== 'A definir') {
          try {
            const result = await obterCoordenadas(moradaTexto);
            if (result) coords = result;
          } catch (e) {
            console.warn('Geocoding falhou no sincronizar (nova):', e.message);
          }
        }
        await Propriedade.create({
          smoobu_id: smoobuId,
          nome: apt.name || `Propriedade ${smoobuId}`,
          morada: moradaTexto,
          coordenadas: coords,
          empresa_id: empresaId,
          tempo_limpeza_minutos: 45,
          capacidade_hospedes: capacidade,
        });
        criadas++;
      } else {
        // Prompt 104 — JÁ EXISTE: a morada só é preenchida pelo Smoobu se o
        // nosso campo estiver vazio/'A definir'. Se o gestor já preencheu a
        // morada manualmente, NÃO sobrescreve (a edição manual tem prioridade).
        // A capacidade_hospedes continua a ser atualizada sempre (o Smoobu é
        // a fonte de verdade para capacidade). Os restantes campos (nome,
        // tempo_limpeza_minutos, ativo, checklist, funcionario_preferencial_id)
        // continuam preservados.
        let mudou = false;

        // Morada: só preenche se o nosso campo estiver vazio/'A definir'.
        if (
          moradaTexto !== 'A definir' &&
          (!existente.morada || existente.morada === 'A definir')
        ) {
          existente.morada = moradaTexto;
          try {
            const coords = await obterCoordenadas(moradaTexto);
            if (coords) existente.coordenadas = coords;
          } catch (e) {
            console.warn('Geocoding falhou no sincronizar (update morada):', e.message);
          }
          mudou = true;
        }

        // Capacidade: atualiza SEMPRE que o Smoobu trouxer um valor.
        if (capacidade) {
          existente.capacidade_hospedes = capacidade;
          mudou = true;
        }

        if (mudou) {
          await existente.save();
          atualizadas++;
        } else {
          existentes++;
        }
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
      `${atualizadas} atualizadas, ${existentes} já existiam, ${erros} com erro.`
  );

  return res.status(200).json({
    totalRecebidas: apartments.length,
    criadas,
    atualizadas,
    existentes,
    erros,
    detalheErros,
  });
};

/* ------------------------------------------------------------------ */
/* POST /api/gestor/smoobu/propriedades — importar (v1.41.0)          */
/* ------------------------------------------------------------------ */

/**
 * Importa propriedades do Smoobu para a empresa do gestor.
 *
 * Diferença para sincronizarPropriedades:
 *   - Verifica se já existe uma Propriedade com aquele smoobu_id QUE
 *     PERTENÇA à empresa_id do gestor (não global).
 *   - Cria com morada: 'A definir' (para o gestor preencher depois).
 *   - Não usa upsert global (respeita o multi-tenant).
 *
 * Resposta 200: { totalRecebidas, criadas, existentes, erros, detalheErros }
 */
exports.importarPropriedades = async (req, res) => {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    return res.status(400).json({ erro: 'empresa_id em falta no token.' });
  }

  const apiKey = await obterApiKeySmoobu(empresaId);
  if (!apiKey) {
    return res.status(400).json({
      erro: 'API Key do Smoobu não configurada. Define-a nas Configurações da empresa.',
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
    console.error('❌ importarPropriedades: fetch falhou:', err.message);
    return res.status(502).json({
      erro: 'Não foi possível ligar ao Smoobu.',
      detalhe: err.message,
    });
  }

  if (!respostaSmoobu.ok) {
    const texto = await respostaSmoobu.text().catch(() => '');
    return res.status(502).json({
      erro: `Smoobu devolveu erro ${respostaSmoobu.status}.`,
      detalhe: texto.slice(0, 500) || respostaSmoobu.statusText,
    });
  }

  let body;
  try {
    body = await respostaSmoobu.json();
  } catch (err) {
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

  let criadas = 0;
  let existentes = 0;
  let atualizadas = 0;
  let erros = 0;
  const detalheErros = [];

  for (const apt of apartments) {
    const smoobuId = apt?.id != null ? String(apt.id) : null;
    try {
      if (!smoobuId) {
        throw new Error('Apartamento sem id.');
      }

      // Extrai capacidade e morada do Smoobu (usados tanto para criar como
      // para atualizar propriedades existentes).
      const capacidade = apt.rooms?.maxOccupancy || apt.maxOccupancy || null;
      let moradaTexto = extrairMoradaSmoobu(apt);

      // Log de debug (uma linha por apartamento) para ajudar a perceber a
      // estrutura do payload quando as moradas não são preenchidas.
      if (moradaTexto === 'A definir') {
        console.log(
          `⚠️  [importarPropriedades] apt ${smoobuId} ("${apt.name}") sem morada — ` +
            `location=${JSON.stringify(apt.location ?? null)}, ` +
            `address=${JSON.stringify(apt.address ?? null)}, ` +
            `keys=${Object.keys(apt).join(',')}`
        );
      }

      // Verifica se JÁ EXISTE uma propriedade com este smoobu_id QUE PERTENÇA
      // a esta empresa (multi-tenant).
      const existente = await Propriedade.findOne({
        smoobu_id: smoobuId,
        empresa_id: empresaId,
      });

      if (existente) {
        // Prompt 104 — A morada só é preenchida pelo Smoobu se o nosso campo
        // estiver vazio/'A definir'. Se o gestor já preencheu a morada
        // manualmente, NÃO sobrescreve (a edição manual tem prioridade).
        // A capacidade_hospedes continua a ser atualizada sempre.
        let mudou = false;

        // Morada: só preenche se o nosso campo estiver vazio/'A definir'.
        if (
          moradaTexto !== 'A definir' &&
          (!existente.morada || existente.morada === 'A definir')
        ) {
          existente.morada = moradaTexto;
          try {
            const coords = await obterCoordenadas(moradaTexto);
            if (coords) existente.coordenadas = coords;
          } catch (e) {
            console.warn('Geocoding falhou no import (update morada):', e.message);
          }
          mudou = true;
        }

        // Capacidade: atualiza SEMPRE que o Smoobu trouxer um valor.
        if (capacidade) {
          existente.capacidade_hospedes = capacidade;
          mudou = true;
        }

        if (mudou) {
          await existente.save();
          atualizadas++;
        } else {
          existentes++;
        }
        continue;
      }

      // Geocoding: se temos morada real, obter coordenadas (lat, lng).
      let coords = { lat: null, lng: null };
      if (moradaTexto !== 'A definir') {
        try {
          const result = await obterCoordenadas(moradaTexto);
          if (result) coords = result;
        } catch (e) {
          console.warn('Geocoding falhou no import:', e.message);
        }
      }

      // Cria nova propriedade para esta empresa com morada + coordenadas + capacidade.
      await Propriedade.create({
        smoobu_id: smoobuId,
        nome: apt.name || `Propriedade ${smoobuId}`,
        morada: moradaTexto,
        coordenadas: coords,
        empresa_id: empresaId,
        tempo_limpeza_minutos: 45,
        capacidade_hospedes: capacidade,
      });
      criadas++;
    } catch (err) {
      erros++;
      detalheErros.push({ smoobuId, erro: err.message });
      console.error(`⚠️  importarPropriedades: apartamento ${smoobuId} falhou:`, err.message);
    }
  }

  console.log(
    `✅ importarPropriedades: ${apartments.length} recebidas, ${criadas} criadas, ` +
      `${atualizadas} atualizadas, ${existentes} já existiam, ${erros} com erro.`
  );

  return res.status(200).json({
    totalRecebidas: apartments.length,
    criadas,
    atualizadas,
    existentes,
    erros,
    detalheErros,
  });
};
