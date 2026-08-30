/**
 * Admin Controller — All2gether
 *
 * Endpoints do Painel de Administração.
 *
 * Autenticação (v1.10.0): o `empresa_id` é lido do JWT (injetado pelo
 * middleware `auth` em `req.user.empresa_id`). O fallback legacy
 * `x-empresa-id` foi REMOVIDO — todos os pedidos têm de trazer token válido.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Tarefa = require('../models/Tarefa');
const Ausencia = require('../models/Ausencia');
const Auditoria = require('../models/Auditoria');
const WebhookLog = require('../models/WebhookLog');
const { obterCoordenadas } = require('../utils/geocoding');
const { registarAuditoria } = require('../utils/auditoria');

/* ------------------------------------------------------------------ */
/* Helper — obter empresa_id do JWT (req.user)                        */
/* ------------------------------------------------------------------ */

/**
 * Lê o `empresa_id` do JWT (injetado pelo middleware `auth` em `req.user`).
 *
 * v1.10.0: o fallback legacy `x-empresa-id` foi REMOVIDO. O middleware
 * `auth` já garante que `req.user` existe (caso contrário devolve 401 antes
 * de chegar aqui). Esta função apenas valida que o `empresa_id` está presente
 * e é um ObjectId válido.
 *
 * Devolve { ok, empresaId } — se `ok` for false, a resposta de erro já foi
 * enviada e o handler deve terminar imediatamente.
 */
function obterEmpresaId(req, res) {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId) {
    res.status(400).json({ erro: 'empresa_id em falta no token.' });
    return { ok: false };
  }
  if (!mongoose.isValidObjectId(empresaId)) {
    res.status(400).json({ erro: 'empresa_id do token inválido.' });
    return { ok: false };
  }
  return { ok: true, empresaId };
}

// Exporta para reutilização noutros controllers (ex: tarefaController).
exports.obterEmpresaId = obterEmpresaId;

/* ------------------------------------------------------------------ */
/* Propriedades                                                         */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/dashboard
 * Devolve estatísticas em tempo real para o dashboard do admin.
 *
 * Resposta 200: {
 *   totalPropriedades, propriedadesAtivas,
 *   membrosEquipaAtivos, tarefasHoje, tarefasPorAtribuir,
 *   tarefasConcluidasHoje, tarefasPorStaff: [{ nome, tarefas, carga_minutos }],
 *   checkinsEmRisco: { total: number, tarefas: [{ _id, data, propriedade_nome, estado }] }
 * }
 */
exports.getDashboard = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // Datas de hoje (UTC).
    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const amanhaInicio = new Date(hojeInicio.getTime() + 24 * 60 * 60 * 1000);
    // Janela de risco: próximas 48h a partir de agora.
    const limiteRisco48h = new Date(agora.getTime() + 48 * 60 * 60 * 1000);

    // Contagens em paralelo.
    const [
      totalPropriedades,
      propriedadesAtivas,
      membrosEquipaAtivos,
      tarefasHoje,
      tarefasPorAtribuir,
      tarefasConcluidasHoje,
    ] = await Promise.all([
      Propriedade.countDocuments({ empresa_id: empresaId }),
      Propriedade.countDocuments({ empresa_id: empresaId, ativo: true }),
      Utilizador.countDocuments({
        empresa_id: empresaId,
        role: { $in: ['staff', 'gestor'] },
        ativo: true,
        eliminado_em: null,
      }),
      Tarefa.countDocuments({
        empresa_id: empresaId,
        data: { $gte: hojeInicio, $lt: amanhaInicio },
        estado: { $ne: 'cancelada' },
      }),
      Tarefa.countDocuments({
        empresa_id: empresaId,
        data: { $gte: hojeInicio, $lt: amanhaInicio },
        estado: 'por_atribuir',
      }),
      Tarefa.countDocuments({
        empresa_id: empresaId,
        data: { $gte: hojeInicio, $lt: amanhaInicio },
        estado: 'concluida',
      }),
    ]);

    // Carga por staff (aggregate).
    const cargasPorStaff = await Tarefa.aggregate([
      {
        $match: {
          empresa_id: new mongoose.Types.ObjectId(empresaId),
          data: { $gte: hojeInicio, $lt: amanhaInicio },
          estado: { $nin: ['cancelada', 'concluida'] },
          utilizador_id: { $ne: null },
        },
      },
      {
        $group: {
          _id: '$utilizador_id',
          tarefas: { $sum: 1 },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
    ]);

    // Popula nomes dos staff.
    const staffIds = cargasPorStaff.map((c) => c._id);
    const staffInfo = await Utilizador.find({ _id: { $in: staffIds } })
      .select('nome')
      .lean();
    const staffMap = new Map(staffInfo.map((s) => [String(s._id), s.nome]));

    const tarefasPorStaff = cargasPorStaff.map((c) => ({
      utilizador_id: String(c._id),
      nome: staffMap.get(String(c._id)) ?? '?',
      tarefas: c.tarefas,
      carga_minutos: c.carga_minutos,
    }));

    // ----------------------------------------------------------------
    // v1.54.0 (Prompt 76) — Radar de Risco: check-ins sem limpeza
    // atribuída nas próximas 48h. Tarefas 'por_atribuir' (sem staff)
    // que podem comprometer check-ins. Devolve contagem + detalhes.
    // ----------------------------------------------------------------
    const tarefasRiscoRaw = await Tarefa.find({
      empresa_id: empresaId,
      data: { $gte: agora, $lte: limiteRisco48h },
      estado: 'por_atribuir',
    })
      .populate({ path: 'propriedade_id', select: 'nome' })
      .select('data estado propriedade_id tempo_limpeza_minutos')
      .sort({ data: 1 })
      .lean();

    const checkinsEmRisco = {
      total: tarefasRiscoRaw.length,
      tarefas: tarefasRiscoRaw.map((t) => ({
        _id: String(t._id),
        data: t.data,
        estado: t.estado,
        tempo_limpeza_minutos: t.tempo_limpeza_minutos,
        propriedade_nome: t.propriedade_id?.nome ?? '—',
      })),
    };

    return res.status(200).json({
      totalPropriedades,
      propriedadesAtivas,
      membrosEquipaAtivos,
      tarefasHoje,
      tarefasPorAtribuir,
      tarefasConcluidasHoje,
      tarefasPorStaff,
      checkinsEmRisco,
    });
  } catch (err) {
    console.error('❌ getDashboard:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/admin/propriedades
 * Devolve as propriedades dessa empresa.
 */
exports.getPropriedades = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // FIX (parceiro associado relacional) — Popula parceiro_id com o nome do
    // parceiro para o frontend mostrar no Badge sem precisar de extrair das
    // observações (lógica legacy improvisada).
    const propriedades = await Propriedade.find({ empresa_id: empresaId })
      .populate({ path: 'parceiro_id', select: 'nome email role' })
      .sort({ nome: 1 });

    return res.status(200).json({ propriedades });
  } catch (err) {
    console.error('❌ getPropriedades:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/gestor/propriedades
 * Cria uma propriedade/sala para essa empresa.
 * Valida: nome (obrigatório), morada (obrigatório),
 * tempo_limpeza_minutos (opcional, default 45).
 *
 * F0: smoobu_id removido (integração Smoobu eliminada).
 *
 * Body esperado:
 *   { nome, morada, tempo_limpeza_minutos? }
 */
exports.criarPropriedade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { nome, morada, tempo_limpeza_minutos, parceiro_id, staff_necessario, dias_fixos_limpeza, nome_responsavel, contacto, frequencia_limpeza, horario_limpeza, observacoes, morada_estruturada, equipa_preferencial } = req.body || {};

    // Validações de presença.
    // FIX (morada estruturada) — Aceita morada OU morada_estruturada (pelo menos
    // o campo rua). Retrocompatível com as 46 propriedades legadas que usam `morada`.
    const temMoradaStr = morada && String(morada).trim();
    const temMoradaEstruturada = morada_estruturada && morada_estruturada.rua && String(morada_estruturada.rua).trim();
    if (!nome || (!temMoradaStr && !temMoradaEstruturada)) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: nome e morada (ou morada_estruturada.rua).',
      });
    }

    // F0 — Validação de unicidade do smoobu_id removida.

    // Validação de tempo_limpeza_minutos (se vier, tem de ser número >= 0).
    let tempo = 45;
    if (tempo_limpeza_minutos !== undefined && tempo_limpeza_minutos !== null) {
      const n = Number(tempo_limpeza_minutos);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({
          erro: 'tempo_limpeza_minutos deve ser um número maior ou igual a 0.',
        });
      }
      tempo = n;
    }

    // Geocoding: converte a morada em coordenadas (lat, lng).
    // Prompt 114 — Se o Nominatim devolver vazio (morada complexa) ou falhar,
    // faz CATCH silenciosamente. A propriedade é criada com coordenadas null
    // (não bloqueia). Devolve flag `geocoding_falhou` para o frontend mostrar
    // um Toast de warning aconselhando a simplificar a morada.
    // FIX (morada estruturada) — Se vier morada_estruturada, usa a concatenação
    // dos 3 campos para geocoding. Senão, fallback para morada (string única).
    // FIX (sync morada) — Sincroniza o campo `morada` (string) com a
    // concatenação da morada estruturada, para que a listagem que usa `morada`
    // como fallback continue a funcionar.
    let moradaParaGeocode = '';
    let moradaEstruturadaFinal = null;
    let moradaFinalStr = ''; // valor final para o campo `morada` (string)
    if (temMoradaEstruturada) {
      const me = morada_estruturada;
      moradaEstruturadaFinal = {
        rua: String(me.rua || '').trim(),
        codigo_postal: String(me.codigo_postal || '').trim(),
        cidade: String(me.cidade || '').trim(),
      };
      moradaParaGeocode = [moradaEstruturadaFinal.rua, moradaEstruturadaFinal.codigo_postal, moradaEstruturadaFinal.cidade]
        .filter((s) => s)
        .join(', ');
      // Sincroniza `morada` (string) com a concatenação.
      moradaFinalStr = moradaParaGeocode;
    } else {
      moradaParaGeocode = String(morada).trim();
      moradaFinalStr = moradaParaGeocode;
    }
    const moradaTrim = moradaParaGeocode; // alias para manter compatibilidade com o código abaixo
    let coordenadas = { lat: null, lng: null };
    let geocodingFalhou = false;
    try {
      const coords = await obterCoordenadas(moradaTrim);
      if (coords) {
        coordenadas = coords;
      } else {
        geocodingFalhou = true;
      }
    } catch (err) {
      geocodingFalhou = true;
      console.error('⚠️  Geocoding falhou (propriedade criada sem coordenadas):', err.message);
    }

    const nova = await Propriedade.create({
      nome: String(nome).trim(),
      morada: moradaFinalStr, // FIX (sync morada) — sempre sincronizada com morada_estruturada
      ...(moradaEstruturadaFinal ? { morada_estruturada: moradaEstruturadaFinal } : {}),
      coordenadas,
      empresa_id: empresaId,
      tempo_limpeza_minutos: tempo,
      origem: 'manual', // HF17 — propriedade manual (não do Smoobu)
      ...(parceiro_id && mongoose.isValidObjectId(parceiro_id)
        ? { parceiro_id: String(parceiro_id).trim() }
        : {}),
      staff_necessario: Math.max(1, Math.min(10, Number(staff_necessario) || 1)), // HF21
      ...(Array.isArray(dias_fixos_limpeza)
        ? { dias_fixos_limpeza: dias_fixos_limpeza.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) }
        : {}), // HF22
      nome_responsavel: nome_responsavel ? String(nome_responsavel).trim().slice(0, 200) : '', // HF23
      contacto: contacto ? String(contacto).trim().slice(0, 50) : '', // HF23
      frequencia_limpeza: ['semanal', 'quinzenal', 'mensal'].includes(frequencia_limpeza) ? frequencia_limpeza : 'semanal', // HF23
      horario_limpeza: horario_limpeza ? String(horario_limpeza).trim().slice(0, 100) : '', // HF23
      // FIX (parceiro associado) — Observações livres (notas internas do gestor).
      observacoes: observacoes ? String(observacoes).trim().slice(0, 2000) : '',
      // FIX (equipas preferenciais) — Array de IDs de staff preferenciais.
      ...(Array.isArray(equipa_preferencial)
        ? { equipa_preferencial: equipa_preferencial.filter((id) => mongoose.isValidObjectId(id)) }
        : {}),
      checklist: Array.isArray(req.body?.checklist)
        ? req.body.checklist.filter((s) => typeof s === 'string' && s.trim())
        : [],
    });

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'criar',
      recurso: 'propriedade',
      recurso_id: nova._id,
      descricao: `Propriedade "${nova.nome}" criada`,
      detalhes: { morada: nova.morada },
    });

    const respostaCriar = { propriedade: nova };
    if (geocodingFalhou) {
      respostaCriar.warning = 'Não foi possível georreferenciar a morada (coordenadas ficam vazias). Tenta simplificar a morada para ativar o cálculo de distâncias.';
    }
    return res.status(201).json(respostaCriar);
  } catch (err) {
    console.error('❌ criarPropriedade:', err.message);

    // Erro de validação do Mongoose (campo obrigatório, etc.)
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }

    // Erro de chave duplicada (índice único)
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Violação de unicidade.',
        detalhe: err.keyValue,
      });
    }

    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Tarefas (Calendário Geral de Operações)                             */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/tarefas
 * Lista todas as Tarefas da empresa, com populate de propriedade e utilizador.
 *
 * Query params opcionais:
 *   ?inicio=YYYY-MM-DD  — data de início do filtro (inclusive)
 *   ?fim=YYYY-MM-DD     — data de fim do filtro (inclusive)
 *
 * Sem filtro de datas: devolve todas as tarefas (pode ser pesado — recomenda-se
 * sempre passar inicio/fim no frontend).
 *
 * Resposta 200: { tarefas: [...] }
 */
exports.getTarefas = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const filtro = { empresa_id: empresaId, estado: { $ne: 'cancelada' } };

    // Filtro por intervalo de datas (opcional).
    // Sempre filtra a partir de hoje (não mostra tarefas passadas).
    const { inicio, fim } = req.query;
    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    if (inicio || fim) {
      const dataFiltro = {};
      if (inicio) {
        const d = new Date(inicio);
        if (!isNaN(d.getTime())) {
          const inicioReq = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
          );
          // Não permite ver datas anteriores a hoje.
          dataFiltro.$gte = inicioReq < hojeInicio ? hojeInicio : inicioReq;
        }
      } else {
        // Se só tem fim, aplica $gte = hoje.
        dataFiltro.$gte = hojeInicio;
      }
      if (fim) {
        const d = new Date(fim);
        if (!isNaN(d.getTime())) {
          // Inclui o dia inteiro (até meia-noite do dia seguinte).
          dataFiltro.$lt = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
              24 * 60 * 60 * 1000
          );
        }
      }
      if (Object.keys(dataFiltro).length > 0) {
        filtro.data = dataFiltro;
      }
    } else {
      // Sem filtros de data → data >= hoje (não devolve tarefas do passado).
      filtro.data = { $gte: hojeInicio };
    }

    const tarefas = await Tarefa.find(filtro)
      // Prompt 114 — Inclui capacidade_hospedes para destaque no detalhe.
      // Prompt 139 — Inclui coordenadas para cálculo on-the-fly de tempo_viagem.
      .populate({ path: 'propriedade_id', select: 'nome capacidade_hospedes coordenadas' })
      // FIX (fantasmas de inativos) — match: { ativo: true, eliminado_em: null }
      // garante que tarefas atribuídas a staff entretanto desativado NÃO
      // populam o nome do staff — utilizador_id fica null no resultado,
      // e o frontend trata a tarefa como 'Por Atribuir'.
      .populate({ path: 'utilizador_id', select: 'nome', match: { ativo: true, eliminado_em: null } })
      .sort({ data: 1 })
      .lean();

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos (best-effort).
    const { calcularTempoViagem } = require('../utils/scheduler');
    // FIX (estado fantasma) — Após populate com match: { ativo: true }, se o
    // utilizador_id ficou null mas o estado é 'atribuida' ou 'em_curso',
    // trata como 'por_atribuir' no DTO devolvido ao frontend (não altera a BD).
    const tarefasComViagem = tarefas.map((t) => {
      // FIX (estado fantasma) — Se utilizador_id é null mas estado é 'atribuida',
      // o staff foi desativado. Devolve como 'por_atribuir' para o frontend.
      if (!t.utilizador_id && (t.estado === 'atribuida' || t.estado === 'em_curso')) {
        t.estado = 'por_atribuir';
      }
      if (t.tempo_viagem_minutos && Number(t.tempo_viagem_minutos) > 0) {
        return t;
      }
      if (!t.utilizador_id || !t.propriedade_id) {
        return { ...t, tempo_viagem_minutos: 0 };
      }
      const diaTarefa = new Date(t.data);
      const diaStr = diaTarefa.toISOString().slice(0, 10);
      const tarefaAnterior = tarefas.find((outra) => {
        if (String(outra._id) === String(t._id)) return false;
        if (!outra.utilizador_id || !outra.propriedade_id) return false;
        if (String(outra.utilizador_id._id) !== String(t.utilizador_id._id)) return false;
        const diaOutra = new Date(outra.data).toISOString().slice(0, 10);
        return diaOutra === diaStr && new Date(outra.data).getTime() < diaTarefa.getTime();
      });
      if (tarefaAnterior && tarefaAnterior.propriedade_id?.coordenadas && t.propriedade_id?.coordenadas) {
        const viagem = calcularTempoViagem(
          tarefaAnterior.propriedade_id.coordenadas,
          t.propriedade_id.coordenadas
        );
        return { ...t, tempo_viagem_minutos: viagem };
      }
      return { ...t, tempo_viagem_minutos: 0 };
    });

    return res.status(200).json({ tarefas: tarefasComViagem });
  } catch (err) {
    console.error('❌ getTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/admin/calendario/dados
 *
 * Endpoint unificado para alimentar a página de Calendário Visual Avançado.
 * Devolve as tarefas da empresa num intervalo de datas, com filtros
 * opcionais e populate de propriedade (nome + morada) e utilizador (nome).
 *
 * Query params:
 *   - inicio        (yyyy-mm-dd | ISO) — início do período (obrigatório na prática)
 *   - fim           (yyyy-mm-dd | ISO) — fim do período (inclusive)
 *   - propriedadeId (ObjectId)         — filtra por propriedade (opcional)
 *   - utilizadorId  (ObjectId)         — filtra por funcionário (opcional)
 *   - estado        (string)           — filtra por estado (opcional):
 *                                        por_atribuir | atribuida | em_curso |
 *                                        concluida | cancelada
 *
 * Notas:
 *   - Diferente do getTarefas, NÃO exclui canceladas por defeito (o calendário
 *     pode querer mostrá-las a tracejado). O utilizador pode excluí-las com
 *     ?estado=atribuida (ou outro).
 *   - Populate inclui `morada` (para tooltip/info no calendário) e `coordenadas`
 *     (para futuro mapa de rotas).
 *
 * Resposta 200: { tarefas: [...] }
 */
exports.getDadosCalendario = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { inicio, fim, propriedadeId, utilizadorId, estado, incluir_canceladas } = req.query;

    // Filtro base: empresa do utilizador autenticado.
    const filtro = { empresa_id: empresaId };

    // Filtro por intervalo de datas [inicio, fim] (fim inclusive).
    if (inicio || fim) {
      const dataFiltro = {};
      if (inicio) {
        const d = new Date(inicio);
        if (!isNaN(d.getTime())) {
          dataFiltro.$gte = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
          );
        }
      }
      if (fim) {
        const d = new Date(fim);
        if (!isNaN(d.getTime())) {
          // Inclui o dia inteiro (até meia-noite do dia seguinte).
          dataFiltro.$lt = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
              24 * 60 * 60 * 1000
          );
        }
      }
      if (Object.keys(dataFiltro).length > 0) {
        filtro.data = dataFiltro;
      }
    }

    // Filtro opcional por propriedade.
    if (propriedadeId && mongoose.isValidObjectId(propriedadeId)) {
      filtro.propriedade_id = propriedadeId;
    }

    // Filtro opcional por utilizador (funcionário).
    // Nota: utilizadorId pode ser 'null' (string) para filtrar tarefas por atribuir.
    if (utilizadorId !== undefined && utilizadorId !== null && utilizadorId !== '') {
      if (utilizadorId === 'null' || utilizadorId === 'sem_atribuicao') {
        filtro.utilizador_id = null;
      } else if (mongoose.isValidObjectId(utilizadorId)) {
        filtro.utilizador_id = utilizadorId;
      }
    }

    // Filtro opcional por estado.
    const ESTADOS_VALIDOS = [
      'por_atribuir',
      'atribuida',
      'em_curso',
      'concluida',
      'cancelada',
    ];
    if (estado && ESTADOS_VALIDOS.includes(estado)) {
      filtro.estado = estado;
    } else if (!estado && incluir_canceladas !== 'true') {
      // Prompt 103 — Se nenhum filtro de estado for especificado E não veio
      // incluir_canceladas=true, exclui canceladas (não aparecem no calendário
      // visual nem na agenda do staff). O Excel passa incluir_canceladas=true
      // para receber também as canceladas (histórico para relatório).
      filtro.estado = { $ne: 'cancelada' };
    }

    const tarefas = await Tarefa.find(filtro)
      // Prompt 114 — Inclui capacidade_hospedes para destaque no detalhe.
      .populate({ path: 'propriedade_id', select: 'nome morada coordenadas capacidade_hospedes' })
      // FIX (fantasmas de inativos) — match: { ativo: true, eliminado_em: null }
      .populate({ path: 'utilizador_id', select: 'nome', match: { ativo: true, eliminado_em: null } })
      .sort({ data: 1 })
      .lean();

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos para tarefas
    // antigas que não têm o campo preenchido (criadas antes do Prompt 138).
    // Agrupa por utilizador + dia, ordena por data, e calcula a viagem entre
    // tarefas consecutivas usando Haversine (capped 60min, fallback 30min).
    // Isto é best-effort: se não houver coordenadas, fica 0.
    const { calcularTempoViagem } = require('../utils/scheduler');
    const tarefasComViagem = tarefas.map((t) => {
      // FIX (estado fantasma) — Se utilizador_id é null mas estado é 'atribuida',
      // o staff foi desativado. Devolve como 'por_atribuir' para o frontend.
      if (!t.utilizador_id && (t.estado === 'atribuida' || t.estado === 'em_curso')) {
        t.estado = 'por_atribuir';
      }
      // Já tem tempo_viagem_minutos > 0? Mantém.
      if (t.tempo_viagem_minutos && Number(t.tempo_viagem_minutos) > 0) {
        return t;
      }
      // Tarefa sem utilizador atribuído → sem viagem.
      if (!t.utilizador_id || !t.propriedade_id) {
        return { ...t, tempo_viagem_minutos: 0 };
      }
      // Procura a tarefa ANTERIOR do mesmo staff no mesmo dia.
      const diaTarefa = new Date(t.data);
      const diaStr = diaTarefa.toISOString().slice(0, 10);
      const tarefaAnterior = tarefas.find((outra) => {
        if (String(outra._id) === String(t._id)) return false;
        if (!outra.utilizador_id || !outra.propriedade_id) return false;
        if (String(outra.utilizador_id._id) !== String(t.utilizador_id._id)) return false;
        const diaOutra = new Date(outra.data).toISOString().slice(0, 10);
        return diaOutra === diaStr && new Date(outra.data).getTime() < diaTarefa.getTime();
      });
      // Se há tarefa anterior, calcula a viagem entre as coordenadas.
      if (tarefaAnterior && tarefaAnterior.propriedade_id?.coordenadas && t.propriedade_id?.coordenadas) {
        const viagem = calcularTempoViagem(
          tarefaAnterior.propriedade_id.coordenadas,
          t.propriedade_id.coordenadas
        );
        return { ...t, tempo_viagem_minutos: viagem };
      }
      // Sem tarefa anterior → sem viagem (primeira tarefa do dia).
      return { ...t, tempo_viagem_minutos: 0 };
    });

    // v1.42.0 — Injeta folgas fixas semanais (dias_folga) como objetos virtuais
    // no array de tarefas, para o calendário as mostrar dinamicamente.
    // Só injeta se houver um intervalo de datas definido.
    if (filtro.data && (filtro.data.$gte || filtro.data.$lt)) {
      const dataInicio = filtro.data.$gte || new Date(Date.now() - 365 * 86400000);
      const dataFim = filtro.data.$lt || new Date(Date.now() + 365 * 86400000);

      // Busca todos os staff/gestor da empresa com dias_folga configurados.
      const staffComFolgas = await Utilizador.find({
        empresa_id: empresaId,
        role: { $in: ['staff', 'gestor'] },
        eliminado_em: null,
        dias_folga: { $exists: true, $ne: [] },
      })
        .select('nome dias_folga')
        .lean();

      // Se o filtro utilizadorId for específico, filtra só esse staff.
      const staffFiltrados = (filtro.utilizador_id && filtro.utilizador_id !== null)
        ? staffComFolgas.filter((s) => String(s._id) === String(filtro.utilizador_id))
        : staffComFolgas;

      // Gera objetos virtuais de folga para cada dia do intervalo.
      const diasFolga = [];
      const diaAtual = new Date(dataInicio);

      while (diaAtual < dataFim) {
        // FIX (bug dias de folga) — Usa getUTCDay() em vez de getDay() porque
        // as datas (dataInicio/dataFim e diaAtual) estão a meia-noite UTC
        // (o frontend envia YYYY-MM-DD e o Ausencia schema normaliza para UTC).
        // getDay() aplica o offset do fuso do servidor, o que desloca o dia da
        // semana e faz com que as folgas apareçam no dia errado (ex.: falsos
        // positivos a cair no Sábado). getUTCDay() garante que o dia renderizado
        // bate com o dia definido no perfil.
        const diaSemana = diaAtual.getUTCDay(); // 0=Dom, 1=Seg, ..., 6=Sáb

        for (const staff of staffFiltrados) {
          if (Array.isArray(staff.dias_folga) && staff.dias_folga.includes(diaSemana)) {
            diasFolga.push({
              _id: `folga_${staff._id}_${diaAtual.toISOString().slice(0, 10)}`,
              tipo: 'folga_fixa',
              data: new Date(diaAtual),
              utilizador_id: { _id: String(staff._id), nome: staff.nome },
              estado: 'concluida', // folga fixa não é uma tarefa ativa
              tempo_limpeza_minutos: 0,
              propriedade_id: null,
            });
          }
        }

        diaAtual.setUTCDate(diaAtual.getUTCDate() + 1);
      }

      // ----------------------------------------------------------------
      // v1.57.0 (Prompt 79) — Injeta ausências APROVADAS (férias/doença)
      // como eventos virtuais no calendário, para o gestor ver quem está
      // indisponível em cada dia.
      //
      // HF25 — Injeta também ausências PENDENTES / pendente_emergencia como
      // eventos distintos (tipo 'ausencia_pendente'). Isto resolve o bug em
      // que o gestor via staff com tarefas atribuídas durante um período de
      // férias que "não aparecia no calendário" — a causa era a ausência
      // estar pendente (não aprovada). O LB continua a só bloquear
      // 'aprovada' (comportamento correto), mas agora o gestor VÊ o pedido
      // pendente no calendário e sabe que tem de o aprovar.
      // ----------------------------------------------------------------
      const filtroAusencias = {
        empresa_id: empresaId,
        estado: 'aprovada',
        // Sobreposição de intervalos: a ausência cobre o período se
        // data_inicio < fimDoPeriodo E data_fim >= inicioDoPeriodo.
        data_inicio: { $lt: dataFim },
        data_fim: { $gte: dataInicio },
      };
      // Se o filtro utilizadorId for específico, filtra só esse staff.
      if (filtro.utilizador_id && filtro.utilizador_id !== null) {
        filtroAusencias.utilizador_id = filtro.utilizador_id;
      }

      const ausenciasAprovadas = await Ausencia.find(filtroAusencias)
        .populate({ path: 'utilizador_id', select: 'nome eliminado_em' })
        .select('data_inicio data_fim tipo utilizador_id notas')
        .lean();

      // HF25 — Busca também ausências pendentes (mesmo período, mesmo staff).
      // Mostra-as como eventos distintos para o gestor poder aprovar a tempo.
      const filtroAusenciasPendentes = {
        ...filtroAusencias,
        estado: { $in: ['pendente', 'pendente_emergencia'] },
      };

      const ausenciasPendentes = await Ausencia.find(filtroAusenciasPendentes)
        .populate({ path: 'utilizador_id', select: 'nome eliminado_em' })
        .select('data_inicio data_fim tipo utilizador_id notas justificacao')
        .lean();

      // Filtra ausências cujo utilizador foi eliminado (soft delete) —
      // não devem aparecer no calendário.
      const ausenciasFiltradas = ausenciasAprovadas.filter(
        (a) => a.utilizador_id && !a.utilizador_id.eliminado_em
      );
      const ausenciasPendentesFiltradas = ausenciasPendentes.filter(
        (a) => a.utilizador_id && !a.utilizador_id.eliminado_em
      );

      // Converte cada ausência APROVADA num evento virtual tipo 'ausencia'.
      // FullCalendar com allDay espera que `end` seja EXCLUSIVE (o dia
      // seguinte ao último dia de férias) para cobrir o bloco inteiro.
      const eventosAusencias = ausenciasFiltradas.map((a) => {
        const endExclusive = new Date(a.data_fim);
        endExclusive.setDate(endExclusive.getDate() + 1); // +1 dia

        const tituloPorTipo =
          a.tipo === 'ferias' ? '🌴 Férias'
          : a.tipo === 'doenca' ? '🤒 Doença'
          : '📅 Ausência';

        return {
          _id: `ausencia_${a._id}`,
          tipo: 'ausencia',
          // Para compatibilidade com o frontend (que lê `data` como Date):
          // usamos data_inicio como `data` (início do bloco).
          data: new Date(a.data_inicio),
          // Campos extras para o FullCalendar (eventos allDay multi-dia).
          start: new Date(a.data_inicio),
          end: endExclusive,
          allDay: true,
          title: `${tituloPorTipo}: ${a.utilizador_id?.nome ?? 'Staff'}`,
          utilizador_id: a.utilizador_id
            ? { _id: String(a.utilizador_id._id), nome: a.utilizador_id.nome }
            : null,
          estado: 'concluida', // ausência não é uma tarefa ativa
          estado_ausencia: 'aprovada',
          tempo_limpeza_minutos: 0,
          propriedade_id: null,
          notas: a.notas || '',
        };
      });

      // HF25 — Converte ausências PENDENTES em eventos 'ausencia_pendente'.
      // Estilo visual distinto (âmbar/listrado) + sufixo "(Pendente)" para
      // o gestor perceber imediatamente que precisa de aprovar.
      const eventosAusenciasPendentes = ausenciasPendentesFiltradas.map((a) => {
        const endExclusive = new Date(a.data_fim);
        endExclusive.setDate(endExclusive.getDate() + 1); // +1 dia

        const tituloPorTipo =
          a.tipo === 'ferias' ? '🌴 Férias'
          : a.tipo === 'doenca' ? '🤒 Doença'
          : '📅 Ausência';
        const sufixoEmergencia =
          a.estado === 'pendente_emergencia' ? ' (Emergência)' : '';

        return {
          _id: `ausencia_pendente_${a._id}`,
          tipo: 'ausencia_pendente',
          data: new Date(a.data_inicio),
          start: new Date(a.data_inicio),
          end: endExclusive,
          allDay: true,
          title: `${tituloPorTipo}${sufixoEmergencia} (Pendente): ${a.utilizador_id?.nome ?? 'Staff'}`,
          utilizador_id: a.utilizador_id
            ? { _id: String(a.utilizador_id._id), nome: a.utilizador_id.nome }
            : null,
          estado: 'concluida',
          estado_ausencia: a.estado, // 'pendente' | 'pendente_emergencia'
          tempo_limpeza_minutos: 0,
          propriedade_id: null,
          notas: a.notas || '',
          justificacao: a.justificacao || '',
        };
      });

      // HF26 — Deteta tarefas órfãs: tarefas atribuídas a staff que tem
      // ausência APROVADA que cobre o dia da tarefa. Isto acontece quando:
      //   (a) o webhook criou a tarefa depois da aprovação e o LB falhou
      //       em filtrar (bug de empresa_id / utilizador_id / timezone);
      //   (b) a desatribuição inicial da aprovação falhou;
      //   (c) o gestor atribuiu manualmente ignorando o aviso.
      // Marca a tarefa com `alerta_orfao: true` para o calendário mostrar
      // um aviso visual vermelho e o gestor poder corrigir (Reaplicar).
      if (ausenciasFiltradas.length > 0) {
        // Constrói mapa: utilizador_id → lista de [data_inicio, data_fim].
        const mapaAusencias = new Map();
        for (const a of ausenciasFiltradas) {
          const uid = String(a.utilizador_id._id);
          if (!mapaAusencias.has(uid)) mapaAusencias.set(uid, []);
          mapaAusencias.get(uid).push({
            inicio: new Date(a.data_inicio).getTime(),
            fim: new Date(a.data_fim).getTime() + 24 * 60 * 60 * 1000, // +1 dia (inclusive)
          });
        }
        // Marca tarefas atribuídas cujo staff está de férias nesse dia.
        for (const t of tarefasComViagem) {
          if (!t.utilizador_id || !t.utilizador_id._id) continue;
          const uid = String(t.utilizador_id._id);
          const intervalos = mapaAusencias.get(uid);
          if (!intervalos || intervalos.length === 0) continue;
          const instante = new Date(t.data).getTime();
          const estaAusente = intervalos.some(
            (iv) => instante >= iv.inicio && instante < iv.fim
          );
          if (estaAusente) {
            t.alerta_orfao = true;
            t.alerta_mensagem = 'Staff de férias nesta data — tarefa órfã';
          }
        }
      }

      // Junta tarefas + folgas fixas + ausências (aprovadas + pendentes) e
      // ordena por data. Prompt 139 — usa tarefasComViagem.
      const resultado = [
        ...tarefasComViagem,
        ...diasFolga,
        ...eventosAusencias,
        ...eventosAusenciasPendentes,
      ].sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());

      return res.status(200).json({ tarefas: resultado });
    }

    // Prompt 139 — sem filtro de datas, devolve tarefasComViagem directamente.
    return res.status(200).json({ tarefas: tarefasComViagem });
  } catch (err) {
    console.error('❌ getDadosCalendario:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Equipa (Utilizadores)                                               */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/admin/propriedades/:id/estado
 * Alterna o campo `ativo` da propriedade (true ↔ false).
 * Propriedades inativas são ignoradas pelo load balancer de atribuição.
 *
 * Prompt 97 — "Desligar a Histeria Automática": quando uma propriedade é
 * DESATIVADA (ativo=false), as tarefas FUTURAS (a partir de hoje) dessa
 * propriedade que ainda não foram executadas (estado ∉
 * ['concluida','cancelada']) deixam de ser APAGADAS — passam a
 * utilizador_id = null + estado = 'por_atribuir'. O recálculo/atribuição
 * fica a cargo do Gestor (manual, via "Auto-Atribuir Pendentes") ou do
 * Fail-Safe noturno. (Anteriormente, v1.35.0/Prompt 73, eram apagadas.)
 *
 * Resposta 200: { propriedade: { ... }, ativo: boolean, tarefasDesatribuidas: number }
 */
exports.alternarEstadoPropriedade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de propriedade inválido.' });
    }

    // Primeiro busca para validar pertença à empresa e saber o estado atual.
    const propriedade = await Propriedade.findOne({
      _id: id,
      empresa_id: empresaId,
    }).lean();
    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a esta empresa).',
      });
    }

    // Se vier `ativo` no body, usa-o; senão alterna.
    const novoEstado =
      typeof req.body?.ativo === 'boolean' ? req.body.ativo : !propriedade.ativo;

    // Usa findOneAndUpdate com $set em vez de save() para NÃO re-validar o
    // documento inteiro. Isto evita 500s em propriedades legacy que possam
    // faltar campos que entretanto se tornaram obrigatórios (ex: morada).
    const atualizada = await Propriedade.findOneAndUpdate(
      { _id: id, empresa_id: empresaId },
      { $set: { ativo: novoEstado } },
      { new: true }
    ).lean();

    // ----------------------------------------------------------------
    // Prompt 97 — Ao DESATIVAR propriedade, desatribui (não apaga) as
    // tarefas FUTURAS (data >= hoje 00:00 UTC) que ainda não foram
    // concluídas nem canceladas: passam a utilizador_id = null +
    // estado = 'por_atribuir'. O recálculo fica para o Gestor/Fail-Safe.
    // ----------------------------------------------------------------
    let tarefasDesatribuidas = 0;
    if (!novoEstado) {
      const agora = new Date();
      const hojeInicio = new Date(
        Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
      );

      const resultado = await Tarefa.updateMany(
        {
          propriedade_id: id,
          empresa_id: empresaId,
          data: { $gte: hojeInicio },
          estado: { $nin: ['concluida', 'cancelada'] },
        },
        { $set: { utilizador_id: null, estado: 'por_atribuir' } }
      );

      tarefasDesatribuidas = resultado?.modifiedCount || 0;
      if (tarefasDesatribuidas > 0) {
        console.log(
          `📤 Propriedade "${propriedade.nome || id}" desativada — ${tarefasDesatribuidas} tarefa(s) futura(s) desatribuída(s) (por atribuir).`
        );
      }
    }

    return res.status(200).json({
      propriedade: atualizada,
      ativo: novoEstado,
      tarefasDesatribuidas,
    });
  } catch (err) {
    console.error('❌ alternarEstadoPropriedade:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * DELETE /api/gestor/propriedades/:id?hard=true
 * FIX (hard-delete para admin) — Elimina uma propriedade.
 *
 * Comportamento:
 *   - Sem ?hard=true (soft-delete padrão): marca `ativo = false` (preserva dados
 *     para auditoria). É o comportamento padrão para gestores.
 *   - Com ?hard=true (HARD DELETE): remove fisicamente o documento da BD
 *     (findByIdAndDelete). Exclusivo para admin — o middleware isGestor já
 *     permite admin, mas a verificação extra `req.user.role === 'admin'` é
 *     feita aqui para garantir que só admin pode hard-delete.
 *
 * Em ambos os casos, desatribui as tarefas futuras associadas (passam a
 * 'por_atribuir' se soft-delete, ou são apagadas se hard-delete — mas como
 * as tarefas têm referência propriedade_id, o hard-delete da propriedade deixa
 * as tarefas órfãs; por isso, no hard-delete, APAGAMOS também as tarefas
 * futuras dessa propriedade para evitar inconsistência).
 *
 * Resposta 200: { mensagem, propriedade_id, hard_delete: boolean }
 */
exports.eliminarPropriedade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de propriedade inválido.' });
    }

    const propriedade = await Propriedade.findOne({ _id: id, empresa_id: empresaId });
    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a esta empresa).',
      });
    }

    const hardDelete = req.query.hard === 'true';

    // FIX (hard-delete para admin) — Só admin pode hard-delete.
    if (hardDelete && req.user && req.user.role !== 'admin') {
      return res.status(403).json({
        erro: 'Apenas o Super Admin pode eliminar propriedades definitivamente (hard-delete).',
      });
    }

    if (hardDelete) {
      // HARD DELETE: apaga a propriedade E as tarefas futuras associadas
      // (para evitar tarefas órfãs com propriedade_id inexistente).
      const hojeInicio = new Date();
      hojeInicio.setUTCHours(0, 0, 0, 0);

      const tarefasApagadas = await Tarefa.deleteMany({
        propriedade_id: id,
        empresa_id: empresaId,
        data: { $gte: hojeInicio },
        estado: { $nin: ['concluida', 'cancelada'] },
      });

      await Propriedade.deleteOne({ _id: id, empresa_id: empresaId });

      registarAuditoria({
        utilizador_id: req.user.id,
        utilizador_nome: req.user.nome || 'Admin',
        empresa_id: empresaId,
        acao: 'eliminar',
        recurso: 'propriedade',
        recurso_id: id,
        descricao: `Propriedade "${propriedade.nome}" eliminada DEFINITIVAMENTE (hard-delete) + ${tarefasApagadas.deletedCount} tarefa(s) futura(s) apagada(s).`,
      });

      console.log(
        `🗑️ [eliminarPropriedade] HARD DELETE: "${propriedade.nome}" (${id}) ` +
          `+ ${tarefasApagadas.deletedCount} tarefa(s) futura(s) apagada(s).`
      );

      return res.status(200).json({
        mensagem: `Propriedade "${propriedade.nome}" eliminada definitivamente. ${tarefasApagadas.deletedCount} tarefa(s) futura(s) apagada(s).`,
        propriedade_id: id,
        hard_delete: true,
        tarefas_apagadas: tarefasApagadas.deletedCount,
      });
    }

    // SOFT DELETE (padrão): marca inativo.
    propriedade.ativo = false;
    await propriedade.save();

    // Desatribui tarefas futuras (igual ao alternarEstadoPropriedade).
    const hojeInicio = new Date();
    hojeInicio.setUTCHours(0, 0, 0, 0);
    const resultadoTarefas = await Tarefa.updateMany(
      {
        propriedade_id: id,
        empresa_id: empresaId,
        data: { $gte: hojeInicio },
        estado: { $in: ['atribuida', 'em_curso'] },
      },
      { $set: { utilizador_id: null, estado: 'por_atribuir' } }
    );

    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'desativar',
      recurso: 'propriedade',
      recurso_id: id,
      descricao: `Propriedade "${propriedade.nome}" desativada (soft-delete) + ${resultadoTarefas.modifiedCount} tarefa(s) desatribuída(s).`,
    });

    return res.status(200).json({
      mensagem: `Propriedade "${propriedade.nome}" desativada. ${resultadoTarefas.modifiedCount} tarefa(s) futura(s) desatribuída(s).`,
      propriedade_id: id,
      hard_delete: false,
      tarefas_desatribuidas: resultadoTarefas.modifiedCount,
    });
  } catch (err) {
    console.error('❌ eliminarPropriedade:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PUT /api/gestor/propriedades/:id
 * Atualiza os dados de uma propriedade/sala (nome, morada,
 * tempo_limpeza_minutos). Se a morada mudar, re-faz geocoding para
 * atualizar as coordenadas (usadas no load balancer Haversine).
 *
 * F0: smoobu_id removido (integração Smoobu eliminada).
 *
 * Body (todos opcionais, mas pelo menos um tem de vir):
 *   { nome?, morada?, tempo_limpeza_minutos? }
 *
 * Regras:
 *   - Valida pertença à empresa (404 se não pertencer).
 *   - Se a morada mudar, re-faz geocoding (best-effort: se falhar, mantém
 *     as coordenadas antigas — não bloqueia a edição).
 *
 * Resposta 200: { propriedade }
 */
exports.atualizarPropriedade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de propriedade inválido.' });
    }

    const propriedade = await Propriedade.findOne({
      _id: id,
      empresa_id: empresaId,
    });
    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a esta empresa).',
      });
    }

    const { nome, morada, tempo_limpeza_minutos, funcionario_preferencial_id, modelo_checklist_id, observacoes, morada_estruturada, parceiro_id, equipa_preferencial } = req.body || {};

    // Tem de haver pelo menos um campo para atualizar.
    if (
      nome === undefined &&
      morada === undefined &&
      tempo_limpeza_minutos === undefined &&
      funcionario_preferencial_id === undefined &&
      modelo_checklist_id === undefined &&
      observacoes === undefined &&
      morada_estruturada === undefined &&
      req.body?.checklist === undefined
    ) {
      return res.status(400).json({
        erro: 'Nenhum campo para atualizar. Envie nome, morada, tempo_limpeza_minutos, checklist, funcionario_preferencial_id, modelo_checklist_id, observacoes ou morada_estruturada.',
      });
    }

    // Validações de formato (se vierem).
    if (nome !== undefined && !String(nome).trim()) {
      return res.status(400).json({ erro: 'nome não pode ser vazio.' });
    }
    // F0 — Validação de smoobu_id removida.
    if (morada !== undefined && !String(morada).trim()) {
      return res.status(400).json({ erro: 'morada não pode ser vazia.' });
    }
    if (tempo_limpeza_minutos !== undefined && tempo_limpeza_minutos !== null) {
      const n = Number(tempo_limpeza_minutos);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({
          erro: 'tempo_limpeza_minutos deve ser um número maior ou igual a 0.',
        });
      }
    }

    // F0 — Validação de unicidade do smoobu_id removida.

    // Nome.
    if (nome !== undefined) {
      propriedade.nome = String(nome).trim();
    }

    // Tempo de limpeza.
    if (tempo_limpeza_minutos !== undefined && tempo_limpeza_minutos !== null) {
      propriedade.tempo_limpeza_minutos = Number(tempo_limpeza_minutos);
    }

    // Morada — se mudou, re-faz geocoding (best-effort).
    // Prompt 114 — Se geocoding falhar/devolver vazio, mantém coordenadas
    // antigas e devolve flag `geocoding_falhou` para o frontend avisar.
    // FIX (morada estruturada) — Se vier morada_estruturada, atualiza os 3 campos
    // e usa a concatenação para geocoding. Senão, usa morada (string única).
    // FIX (sync morada) — Ao guardar morada_estruturada, sincroniza também o
    // campo `morada` (string) com a concatenação, para que a listagem que usa
    // `morada` como fallback continue a funcionar. Isto resolve o bug onde a
    // tabela mostrava "A definir" quando o utilizador preenchia apenas a
    // morada estruturada (o `morada` ficava vazio/antigo).
    let geocodingFalhou = false;
    if (morada_estruturada !== undefined) {
      const me = morada_estruturada || {};
      const novaRua = String(me.rua || '').trim();
      const novoCp = String(me.codigo_postal || '').trim();
      const novaCidade = String(me.cidade || '').trim();
      propriedade.morada_estruturada = { rua: novaRua, codigo_postal: novoCp, cidade: novaCidade };
      // Sincroniza `morada` (string) com a concatenação da morada estruturada.
      if (novaRua) {
        const moradaConcatenada = [novaRua, novoCp, novaCidade].filter((s) => s).join(', ');
        propriedade.morada = moradaConcatenada;
        // Re-faz geocoding com a concatenação.
        try {
          const coords = await obterCoordenadas(moradaConcatenada);
          if (coords) {
            propriedade.coordenadas = coords;
          } else {
            geocodingFalhou = true;
          }
        } catch (err) {
          geocodingFalhou = true;
          console.error('⚠️  Geocoding falhou na edição (coordenadas mantidas):', err.message);
        }
      }
    }
    if (morada !== undefined) {
      const novaMorada = String(morada).trim();
      if (novaMorada !== propriedade.morada) {
        propriedade.morada = novaMorada;
        // Só re-faz geocoding se morada_estruturada NÃO foi fornecida (evita duplo geocode).
        if (morada_estruturada === undefined && novaMorada) {
          try {
            const coords = await obterCoordenadas(novaMorada);
            if (coords) {
              propriedade.coordenadas = coords;
            } else {
              geocodingFalhou = true;
            }
          } catch (err) {
            // Geocoding falhou → mantém coordenadas antigas (não bloqueia).
            geocodingFalhou = true;
            console.error(
              '⚠️  Geocoding falhou na edição (coordenadas mantidas):',
              err.message
            );
          }
        }
      }
    }

    // FIX (parceiro associado) — Observações livres (notas internas do gestor).
    // Aceita string vazia para limpar o campo.
    if (observacoes !== undefined) {
      propriedade.observacoes = String(observacoes).trim().slice(0, 2000);
    }

    // FIX (parceiro associado relacional) — Associa/desassocia parceiro B2B.
    // Aceita null/string vazia para remover; caso contrário valida que é um
    // utilizador com role 'parceiro' da mesma empresa.
    if (parceiro_id !== undefined) {
      const valor = parceiro_id === null || parceiro_id === ''
        ? null
        : String(parceiro_id).trim();
      if (valor !== null) {
        if (!mongoose.isValidObjectId(valor)) {
          return res.status(400).json({ erro: 'parceiro_id inválido.' });
        }
        const parceiro = await Utilizador.findOne({
          _id: valor,
          empresa_id: empresaId,
          role: 'parceiro',
          eliminado_em: null,
        }).lean();
        if (!parceiro) {
          return res.status(400).json({
            erro: 'Parceiro não encontrado (não é um utilizador com role "parceiro" desta empresa).',
          });
        }
      }
      propriedade.parceiro_id = valor;
    }

    // FIX (equipas preferenciais) — Atualiza o array de equipa_preferencial.
    // Aceita array vazio para limpar. Valida que cada ID é um ObjectId válido.
    // FIX (alocação bidirecional) — Sincroniza propriedades_alocadas nos
    // utilizadores: adiciona esta propriedade aos novos membros e remove dos
    // que foram desmarcados.
    if (equipa_preferencial !== undefined) {
      const novaEquipa = Array.isArray(equipa_preferencial)
        ? equipa_preferencial.filter((id) => mongoose.isValidObjectId(id)).map(String)
        : [];
      const antigaEquipa = (propriedade.equipa_preferencial || []).map(String);

      // Staff a ADICICIONAR (estão nos novos mas não nos antigos).
      const paraAdicionar = novaEquipa.filter((sid) => !antigaEquipa.includes(sid));
      // Staff a REMOVER (estão nos antigos mas não nos novos).
      const paraRemover = antigaEquipa.filter((sid) => !novaEquipa.includes(sid));

      propriedade.equipa_preferencial = novaEquipa;

      // Sincroniza propriedades_alocadas nos utilizadores (after save).
      if (paraAdicionar.length > 0) {
        await Utilizador.updateMany(
          { _id: { $in: paraAdicionar }, empresa_id: empresaId },
          { $addToSet: { propriedades_alocadas: propriedade._id } }
        );
      }
      if (paraRemover.length > 0) {
        await Utilizador.updateMany(
          { _id: { $in: paraRemover }, empresa_id: empresaId },
          { $pull: { propriedades_alocadas: propriedade._id } }
        );
      }
    }

    // v1.34.0: atualiza checklist (array de strings).
    if (req.body?.checklist !== undefined) {
      propriedade.checklist = Array.isArray(req.body.checklist)
        ? req.body.checklist.filter((s) => typeof s === 'string' && s.trim())
        : [];
    }

    // Prompt 95 (Fase 1.5) — Funcionário preferencial (Algoritmo VIP).
    // HF11 — Sistema HÍBRIDO: um staff PODE ser o preferencial de MÚLTIPLAS
    // propriedades (X, Y, Z). A desassociação automática da HF9 foi REMOVIDA.
    // Aceita null/empty para remover; caso contrário valida que é um staff
    // ativo da mesma empresa.
    if (funcionario_preferencial_id !== undefined) {
      const valor = funcionario_preferencial_id === null || funcionario_preferencial_id === ''
        ? null
        : String(funcionario_preferencial_id).trim();
      if (valor !== null) {
        if (!mongoose.isValidObjectId(valor)) {
          return res.status(400).json({ erro: 'funcionario_preferencial_id inválido.' });
        }
        const staffPref = await Utilizador.findOne({
          _id: valor,
          empresa_id: empresaId,
          role: 'staff',
          ativo: true,
          eliminado_em: null,
        }).lean();
        if (!staffPref) {
          return res.status(400).json({
            erro: 'Funcionário preferencial não encontrado (não é staff ativo desta empresa).',
          });
        }
      }
      propriedade.funcionario_preferencial_id = valor;
    }

    // Prompt 133/134 — Modelo de Checklist associado à propriedade.
    // Aceita null/empty para remover; caso contrário valida que é um
    // ModeloChecklist da mesma empresa.
    if (modelo_checklist_id !== undefined) {
      const valor = modelo_checklist_id === null || modelo_checklist_id === ''
        ? null
        : String(modelo_checklist_id).trim();
      if (valor !== null) {
        if (!mongoose.isValidObjectId(valor)) {
          return res.status(400).json({ erro: 'modelo_checklist_id inválido.' });
        }
        const ModeloChecklist = require('../models/ModeloChecklist');
        const modelo = await ModeloChecklist.findOne({
          _id: valor,
          empresa_id: empresaId,
        }).lean();
        if (!modelo) {
          return res.status(400).json({
            erro: 'Modelo de checklist não encontrado (não pertence a esta empresa).',
          });
        }
      }
      propriedade.modelo_checklist_id = valor;
    }

    await propriedade.save();

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'atualizar',
      recurso: 'propriedade',
      recurso_id: propriedade._id,
      descricao: `Propriedade "${propriedade.nome}" atualizada`,
      detalhes: { morada: propriedade.morada },
    });

    return res.status(200).json({
      propriedade,
      ...(geocodingFalhou
        ? { warning: 'Não foi possível georreferenciar a nova morada. Coordenadas antigas mantidas. Tenta simplificar a morada.' }
        : {}),
    });
  } catch (err) {
    console.error('❌ atualizarPropriedade:', err.message);

    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Violação de unicidade.',
        detalhe: err.keyValue,
      });
    }

    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/admin/equipa
 * Lista todos os utilizadores da empresa (qualquer role).
 * O `empresa_id` vem do JWT (via obterEmpresaId, que lê `req.user.empresa_id`).
 *
 * Resposta 200: { utilizadores: [...] } (sem password_hash).
 */
exports.getEquipa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // Prompt 116 — Filtro rigoroso da equipa:
    //   - só utilizadores ativos (ativo: true)
    //   - exclui ESTritamente o Super Admin (role: 'admin') — nunca pode
    //     aparecer nas listas do Gestor
    //   - exclui eliminados (soft delete)
    // FIX (gestão de parceiros) — exclui parceiros (role: 'parceiro') da
    // listagem da Equipa. Parceiros são geridos na página dedicada
    // /gestor/parceiros. Apenas staff e gestor aparecem aqui.
    // FIX (soft-delete com desatribuição) — Mostra tanto ativos como inativos
    // (removido o filtro ativo: true) para o gestor poder ver e reativar
    // utilizadores inativos. O soft-delete (eliminado_em) continua a excluir.
    const utilizadores = await Utilizador.find({
      empresa_id: empresaId,
      eliminado_em: null,
      role: { $nin: ['admin', 'parceiro'] },
    })
      .select('-password_hash') // nunca expor a hash
      .populate({ path: 'responsavel_id', select: 'nome email role' })
      .sort({ nome: 1 })
      .lean();

    // Transforma responsavel_id (objeto populated) num campo `responsavel` limpo
    // e mantém responsavel_id como string (ou null) para o frontend.
    const transformados = utilizadores.map((u) => {
      const resp = u.responsavel_id;
      return {
        ...u,
        responsavel_id: resp ? String(resp._id) : null,
        responsavel: resp
          ? { _id: String(resp._id), nome: resp.nome, email: resp.email, role: resp.role }
          : null,
      };
    });

    return res.status(200).json({ utilizadores: transformados });
  } catch (err) {
    console.error('❌ getEquipa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/gestor/parceiros
 * FIX (gestão de parceiros) — Lista apenas utilizadores com role 'parceiro'.
 * Página dedicada /gestor/parceiros. Mostra tanto ativos como inativos
 * (ao contrário do getEquipa que só mostra ativos) — parceiros inativos
 * continuam visíveis para reativação. Exclui eliminados (soft delete).
 *
 * Resposta 200: { utilizadores: [...] } (sem password_hash).
 */
exports.getParceiros = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const utilizadores = await Utilizador.find({
      empresa_id: empresaId,
      eliminado_em: null,
      role: 'parceiro',
    })
      .select('-password_hash')
      .sort({ nome: 1 })
      .lean();

    return res.status(200).json({ utilizadores });
  } catch (err) {
    console.error('❌ getParceiros:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/admin/equipa
 * Cria um novo membro de equipa (Utilizador) para a empresa.
 *
 * Body: { nome, email, password, role }
 *   - nome      (obrigatório)
 *   - email     (obrigatório, único global)
 *   - password  (obrigatória, em claro — é guardada como hash bcrypt)
 *   - role      (opcional, default 'staff'; enum ['admin','gestor','staff'])
 *
 * Resposta 201: { utilizador: { ... } } (sem password_hash).
 * Erros: 400 campos em falta / role inválido; 409 email duplicado; 500 erro.
 */
exports.criarMembroEquipa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { nome, email, password, role, responsavel_id, dias_folga, telefone, nif, observacoes, exclusivo_preferenciais, propriedades_alocadas } = req.body || {};

    // Validações de presença.
    if (!nome || !email || !password) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: nome, email e password.',
      });
    }

    // Validação da password (mínimo 6 caracteres).
    if (String(password).length < 6) {
      return res.status(400).json({
        erro: 'A password deve ter pelo menos 6 caracteres.',
      });
    }

    // Validação do role (se vier, tem de ser um dos permitidos).
    // HF27 — adicionado 'parceiro' (B2B externo que cria reservas manuais).
    const roleFinal = role || 'staff';
    if (!['admin', 'gestor', 'staff', 'parceiro'].includes(roleFinal)) {
      return res.status(400).json({
        erro: 'Role inválido. Valores permitidos: admin, gestor, staff, parceiro.',
      });
    }

    // SEGURANÇA: Não é possível criar utilizadores com role 'admin'.
    // O admin é criado apenas via /api/admin/setup (bootstrap) ou processo separado.
    if (roleFinal === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível criar utilizadores com role "admin".',
      });
    }

    // HF27 — Parceiros (B2B) são externos à equipa de limpezas:
    //   - Não têm folgas semanais (dias_folga) — não são funcionários.
    //   - Não têm responsável hierárquico (responsavel_id) — reportam à empresa.
    //   - Forçamos estes campos a null/[] para evitar inconsistências.
    const isParceiro = roleFinal === 'parceiro';

    // Validação de unicidade do email (único global).
    const emailNormalizado = String(email).toLowerCase().trim();
    const existente = await Utilizador.findOne({ email: emailNormalizado });
    if (existente) {
      return res.status(409).json({
        erro: `Já existe um utilizador com o email "${emailNormalizado}".`,
      });
    }

    // SEGURANÇA: Valida responsavel_id se vier — tem de ser admin/gestor
    // da mesma empresa.
    // HF27 — Parceiros não têm responsável hierárquico (ignora o campo).
    let responsavelValidado = null;
    if (responsavel_id && !isParceiro) {
      if (!mongoose.isValidObjectId(responsavel_id)) {
        return res.status(400).json({ erro: 'responsavel_id inválido.' });
      }
      const resp = await Utilizador.findOne({
        _id: responsavel_id,
        empresa_id: empresaId,
        role: { $in: ['admin', 'gestor'] },
      });
      if (!resp) {
        return res.status(400).json({
          erro: 'Responsável não encontrado (ou não é admin/gestor da empresa).',
        });
      }
      responsavelValidado = resp._id;
    }

    // Valida dias_folga se vier (array de inteiros 0-6).
    // HF27 — Parceiros não têm folgas semanais (ignora o campo, força []).
    let diasFolgaFinal = [];
    if (dias_folga !== undefined && dias_folga !== null && !isParceiro) {
      if (!Array.isArray(dias_folga)) {
        return res.status(400).json({ erro: 'dias_folga deve ser um array de inteiros (0-6).' });
      }
      diasFolgaFinal = dias_folga.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    }

    // Hash da password com bcrypt.
    const password_hash = await bcrypt.hash(String(password), 10);

    const novo = await Utilizador.create({
      nome: String(nome).trim(),
      email: emailNormalizado,
      password_hash,
      empresa_id: empresaId,
      role: roleFinal,
      responsavel_id: responsavelValidado,
      dias_folga: diasFolgaFinal,
      telefone: telefone ? String(telefone).trim() : '',
      // FIX (gestão de parceiros) — NIF e observações livres.
      nif: nif ? String(nif).trim().slice(0, 20) : '',
      observacoes: observacoes ? String(observacoes).trim().slice(0, 2000) : '',
      // FIX (equipas preferenciais) — Toggle de exclusividade.
      exclusivo_preferenciais: Boolean(exclusivo_preferenciais),
      // FIX (alocação bidirecional) — Propriedades alocadas ao staff.
      ...(Array.isArray(propriedades_alocadas)
        ? { propriedades_alocadas: propriedades_alocadas.filter((id) => mongoose.isValidObjectId(id)) }
        : {}),
      ativo: true,
    });

    // FIX (alocação bidirecional) — Sincroniza equipa_preferencial nas
    // propriedades: adiciona o ID deste staff às propriedades selecionadas.
    if (novo.propriedades_alocadas && novo.propriedades_alocadas.length > 0) {
      await Propriedade.updateMany(
        { _id: { $in: novo.propriedades_alocadas }, empresa_id: empresaId },
        { $addToSet: { equipa_preferencial: novo._id } }
      );
    }

    // Resposta sem password_hash.
    const utilizador = novo.toObject();
    delete utilizador.password_hash;

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'criar',
      recurso: 'utilizador',
      recurso_id: utilizador._id,
      descricao: `Utilizador "${utilizador.nome}" criado`,
      detalhes: { email: utilizador.email, role: utilizador.role },
    });

    return res.status(201).json({ utilizador });
  } catch (err) {
    console.error('❌ criarMembroEquipa:', err.message);

    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Violação de unicidade.',
        detalhe: err.keyValue,
      });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PUT /api/admin/equipa/:id
 * Atualiza Nome, Email e/ou Role de um utilizador, e opcionalmente a password.
 *
 * Body (todos opcionais, mas pelo menos um deve vir):
 *   { nome?, email?, role?, password? }
 *   - password: se vier, é guardada como NOVA hash bcrypt (mín. 6 chars).
 *               Se não vier, a password atual é mantida.
 *
 * Regras de segurança:
 *   - O utilizador tem de pertencer à mesma empresa do JWT.
 *   - Não é possível desativar via este endpoint (usar PATCH /:id/estado).
 *   - Se o email mudar, tem de continuar único.
 *
 * Resposta 200: { utilizador: { ... } } (sem password_hash).
 */
exports.atualizarMembroEquipa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    const { nome, email, role, password, responsavel_id, dias_folga, telefone, folgas_rotativas, nif, observacoes, exclusivo_preferenciais, propriedades_alocadas } = req.body || {};
    if (
      nome === undefined &&
      email === undefined &&
      role === undefined &&
      password === undefined &&
      responsavel_id === undefined &&
      dias_folga === undefined &&
      telefone === undefined &&
      folgas_rotativas === undefined &&
      nif === undefined &&
      observacoes === undefined
    ) {
      return res.status(400).json({
        erro: 'Nada para atualizar. Envie nome, email, role, password, responsavel_id, dias_folga, folgas_rotativas, telefone, nif e/ou observacoes.',
      });
    }

    // SEGURANÇA: Não é possível definir role 'admin' via edição.
    if (role !== undefined && role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível atribuir o role "admin" via edição.',
      });
    }

    // Procura o utilizador e garante que pertence à empresa do JWT.
    const utilizador = await Utilizador.findOne({ _id: id, empresa_id: empresaId });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }

    // SEGURANÇA: Não é possível modificar um administrador.
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível modificar um administrador.',
      });
    }

    // --- Nome ---
    if (nome !== undefined) {
      const n = String(nome).trim();
      if (!n) {
        return res.status(400).json({ erro: 'nome não pode ser vazio.' });
      }
      utilizador.nome = n;
    }

    // --- Email (com verificação de unicidade se mudou) ---
    if (email !== undefined) {
      const emailNormalizado = String(email).toLowerCase().trim();
      if (!emailNormalizado) {
        return res.status(400).json({ erro: 'email não pode ser vazio.' });
      }
      if (emailNormalizado !== utilizador.email) {
        const existente = await Utilizador.findOne({ email: emailNormalizado });
        if (existente) {
          return res.status(409).json({
            erro: `Já existe um utilizador com o email "${emailNormalizado}".`,
          });
        }
        utilizador.email = emailNormalizado;
      }
    }

    // --- Role ---
    // HF27 — adicionado 'parceiro' (B2B externo).
    if (role !== undefined) {
      if (!['gestor', 'staff', 'parceiro'].includes(role)) {
        return res.status(400).json({
          erro: 'Role inválido. Valores permitidos via edição: gestor, staff, parceiro.',
        });
      }
      utilizador.role = role;
    }

    // HF27 — Determina se o utilizador é (ou vai ficar) parceiro, para
    // ignorar campos irrelevantes (responsavel_id, dias_folga, folgas_rotativas).
    const isParceiroFinal = utilizador.role === 'parceiro';

    // --- Responsável (opcional: null = sem responsável) ---
    // HF27 — Parceiros não têm responsável hierárquico (ignora o campo).
    if (responsavel_id !== undefined && !isParceiroFinal) {
      if (responsavel_id === null || responsavel_id === '') {
        utilizador.responsavel_id = null;
      } else {
        if (!mongoose.isValidObjectId(responsavel_id)) {
          return res.status(400).json({ erro: 'responsavel_id inválido.' });
        }
        const resp = await Utilizador.findOne({
          _id: responsavel_id,
          empresa_id: empresaId,
          role: { $in: ['admin', 'gestor'] },
        });
        if (!resp) {
          return res.status(400).json({
            erro: 'Responsável não encontrado (ou não é admin/gestor da empresa).',
          });
        }
        // Não permitir atribuir o utilizador como responsável de si próprio.
        if (String(resp._id) === String(utilizador._id)) {
          return res.status(400).json({
            erro: 'Um utilizador não pode ser responsável de si próprio.',
          });
        }
        utilizador.responsavel_id = resp._id;
      }
    }

    // --- dias_folga (opcional: array de inteiros 0-6) ---
    // HF27 — Parceiros não têm folgas semanais (ignora o campo, força []).
    if (dias_folga !== undefined) {
      if (isParceiroFinal) {
        utilizador.dias_folga = [];
      } else {
        if (!Array.isArray(dias_folga)) {
          return res.status(400).json({ erro: 'dias_folga deve ser um array de inteiros (0-6).' });
        }
        utilizador.dias_folga = dias_folga.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      }
    }

    // --- folgas_rotativas (opcional: array de { data, motivo }) ---
    // HF10 — Datas específicas de folga (além das fixas semanais).
    // O frontend envia o array completo (substituição total, não append).
    // Cada entrada: { data: "YYYY-MM-DD" | Date, motivo: string }.
    // Validação: data deve ser válida; motivo é string (pode ser vazia).
    // HF27 — Parceiros não têm folgas rotativas (força []).
    if (folgas_rotativas !== undefined) {
      if (isParceiroFinal) {
        utilizador.folgas_rotativas = [];
      } else if (!Array.isArray(folgas_rotativas)) {
        return res.status(400).json({ erro: 'folgas_rotativas deve ser um array.' });
      } else {
        const folgasNormalizadas = [];
        for (const fr of folgas_rotativas) {
          if (!fr || typeof fr !== 'object') continue;
          const dataObj = fr.data instanceof Date ? fr.data : new Date(fr.data);
          if (isNaN(dataObj.getTime())) {
            return res.status(400).json({
              erro: 'folgas_rotativas: data inválida.',
              detalhe: `Valor recebido: ${JSON.stringify(fr.data)}`,
            });
          }
          folgasNormalizadas.push({
            data: dataObj,
            motivo: typeof fr.motivo === 'string' ? fr.motivo.trim().slice(0, 200) : '',
          });
        }
        // Ordena por data (ascendente) para consistência.
        folgasNormalizadas.sort((a, b) => a.data.getTime() - b.data.getTime());
        utilizador.folgas_rotativas = folgasNormalizadas;
      }
    }

    // --- telefone (opcional) ---
    if (telefone !== undefined) {
      utilizador.telefone = String(telefone).trim();
    }

    // FIX (gestão de parceiros) — nif e observacoes (opcional)
    // --- nif (opcional) ---
    if (nif !== undefined) {
      utilizador.nif = String(nif).trim().slice(0, 20);
    }

    // --- observacoes (opcional) ---
    if (observacoes !== undefined) {
      utilizador.observacoes = String(observacoes).trim().slice(0, 2000);
    }

    // FIX (equipas preferenciais) — exclusivo_preferenciais (toggle booleano).
    if (exclusivo_preferenciais !== undefined) {
      utilizador.exclusivo_preferenciais = Boolean(exclusivo_preferenciais);
    }

    // FIX (alocação bidirecional) — Atualiza propriedades_alocadas e sincroniza
    // o equipa_preferencial das propriedades (adicionar/remover o ID do staff).
    if (propriedades_alocadas !== undefined) {
      const novasAlocadas = Array.isArray(propriedades_alocadas)
        ? propriedades_alocadas.filter((pid) => mongoose.isValidObjectId(pid)).map(String)
        : [];
      const antigasAlocadas = (utilizador.propriedades_alocadas || []).map(String);

      // Propriedades a ADICICIONAR (estão nas novas mas não nas antigas).
      const paraAdicionar = novasAlocadas.filter((pid) => !antigasAlocadas.includes(pid));
      // Propriedades a REMOVER (estão nas antigas mas não nas novas).
      const paraRemover = antigasAlocadas.filter((pid) => !novasAlocadas.includes(pid));

      utilizador.propriedades_alocadas = novasAlocadas;

      // Sincroniza equipa_preferencial nas propriedades (depois do save).
      if (paraAdicionar.length > 0) {
        await Propriedade.updateMany(
          { _id: { $in: paraAdicionar }, empresa_id: empresaId },
          { $addToSet: { equipa_preferencial: utilizador._id } }
        );
      }
      if (paraRemover.length > 0) {
        await Propriedade.updateMany(
          { _id: { $in: paraRemover }, empresa_id: empresaId },
          { $pull: { equipa_preferencial: utilizador._id } }
        );
      }
    }

    // --- Password (opcional: só se vier, faz hash nova) ---
    if (password !== undefined && password !== null && String(password) !== '') {
      if (String(password).length < 6) {
        return res.status(400).json({
          erro: 'A password deve ter pelo menos 6 caracteres.',
        });
      }
      utilizador.password_hash = await bcrypt.hash(String(password), 10);
    }

    await utilizador.save();

    // Resposta sem password_hash.
    const resp = utilizador.toObject();
    delete resp.password_hash;
    return res.status(200).json({ utilizador: resp });
  } catch (err) {
    console.error('❌ atualizarMembroEquipa:', err.message);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Violação de unicidade.',
        detalhe: err.keyValue,
      });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/admin/equipa/:id/estado
 * Alterna o estado `ativo` do utilizador (ativa ↔ desativa).
 *
 * Um utilizador desativado NÃO consegue fazer login (ver authController.login).
 *
 * Body (opcional): { ativo: boolean } — se não vier, alterna o estado atual.
 *
 * Resposta 200: { utilizador: { ... }, ativo: boolean } (sem password_hash).
 */
exports.alternarEstadoMembro = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    const utilizador = await Utilizador.findOne({ _id: id, empresa_id: empresaId });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }

    // SEGURANÇA: Não é possível desativar/ativar um administrador.
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível modificar o estado de um administrador.',
      });
    }

    // Se vier `ativo` no body, usa-o; senão alterna.
    const novoEstado =
      typeof req.body?.ativo === 'boolean' ? req.body.ativo : !utilizador.ativo;

    utilizador.ativo = novoEstado;
    await utilizador.save();

    // FIX (soft-delete com desatribuição) — Ao INATIVAR um funcionário de
    // limpeza (role staff ou gestor), o sistema desatribui automaticamente
    // TODAS as tarefas futuras (ou não concluídas) atribuídas a esse
    // funcionário, colocando-as de volta no estado 'por_atribuir'. Isto
    // garante que limpezas não ficam órfãs atribuídas a alguém que já não
    // trabalha na empresa. Reutiliza o helper desatribuirTarefasPeriodo
    // do ausenciaController (modelo testado pelo fluxo de férias/baixa).
    let tarefasDesatribuidas = 0;
    if (!novoEstado) {
      // Só desatribui para staff e gestor (parceiros não têm tarefas atribuídas).
      if (utilizador.role === 'staff' || utilizador.role === 'gestor') {
        try {
          const { desatribuirTarefasPeriodo } = require('./ausenciaController');
          const hoje = new Date();
          const inicio = new Date(
            Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
          );
          // Desatribui tarefas desde hoje até 1 ano no futuro (cobre todas
          // as tarefas futuras — o helper filtra por estado 'atribuida'/'em_curso').
          const futuro = new Date(inicio.getTime() + 365 * 24 * 60 * 60 * 1000);
          const resultado = await desatribuirTarefasPeriodo(
            utilizador._id,
            inicio,
            futuro
          );
          tarefasDesatribuidas = resultado.desatribuidas;
        } catch (err) {
          // Não bloqueia a inativação se a desatribuição falhar — loga e continua.
          console.error(
            '⚠️  Erro ao desatribuir tarefas futuras do utilizador inativado:',
            err.message
          );
        }
      }
    }

    const resp = utilizador.toObject();
    delete resp.password_hash;
    return res.status(200).json({
      utilizador: resp,
      ativo: novoEstado,
      // FIX (soft-delete com desatribuição) — devolve contagem de tarefas
      // desatribuídas para o frontend mostrar feedback ao gestor.
      tarefas_desatribuidas: tarefasDesatribuidas,
    });
  } catch (err) {
    console.error('❌ alternarEstadoMembro:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * DELETE /api/admin/equipa/:id
 * Remove permanentemente o utilizador da base de dados.
 *
 * Regras de segurança:
 *   - O utilizador tem de pertencer à mesma empresa do JWT.
 *   - Não é possível eliminar-se a si próprio (req.user.id) — evita
 *     o admin ficar sem acesso à conta.
 *
 * Resposta 200: { mensagem, utilizador_id }.
 */
exports.eliminarMembroEquipa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    // Proteção: não permitir eliminar-se a si próprio.
    if (req.user && req.user.id && String(req.user.id) === String(id)) {
      return res.status(400).json({
        erro: 'Não podes eliminar a tua própria conta.',
      });
    }

    const utilizador = await Utilizador.findOne({ _id: id, empresa_id: empresaId });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }

    // SEGURANÇA: Não é possível eliminar um administrador.
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível eliminar um administrador.',
      });
    }

    const nomeEliminado = utilizador.nome;
    // Soft delete: marca eliminado_em em vez de remover fisicamente.
    // Isto protege as Tarefas antigas de ficarem com utilizador_id órfão
    // (o histórico de tarefas continua a referenciar o utilizador).
    utilizador.eliminado_em = new Date();
    utilizador.ativo = false; // garante que não consegue fazer login
    await utilizador.save();

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'eliminar',
      recurso: 'utilizador',
      recurso_id: id,
      descricao: `Utilizador "${nomeEliminado}" eliminado (soft delete)`,
    });

    return res.status(200).json({
      mensagem: `Utilizador "${nomeEliminado}" eliminado com sucesso.`,
      utilizador_id: id,
    });
  } catch (err) {
    console.error('❌ eliminarMembroEquipa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Falta Súbita — Reatribuição de Emergência                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/equipa/:id/falta-subita
 *
 * Regista uma ausência de hoje para o utilizador e desatribui as suas
 * tarefas de hoje (passam a 'por_atribuir').
 *
 * Lógica (Prompt 97 — "Desligar a Histeria Automática"):
 *   1. Valida utilizador (pertence à empresa, não é admin, não é si próprio).
 *   2. Regista Ausencia para hoje (ignora duplicado).
 *   3. Desatribui as tarefas de hoje do utilizador (utilizador_id = null +
 *      estado = 'por_atribuir') — NÃO chama o load balancer. O recálculo
 *      fica a cargo do Gestor (manual) ou do Fail-Safe noturno.
 *
 * Resposta 200: { desatribuidas, total, detalhes: [...] }
 */
exports.reportarFaltaSubita = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    // Valida utilizador.
    const utilizador = await Utilizador.findOne({
      _id: id,
      empresa_id: empresaId,
      eliminado_em: null,
    });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível reportar falta de um administrador.',
      });
    }

    // 1) Calcula o intervalo de hoje (UTC meia-noite).
    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const amanhaInicio = new Date(hojeInicio.getTime() + 24 * 60 * 60 * 1000);

    // 2) Registra Ausencia para hoje (ignora erro de duplicado).
    // v1.24.0: falta súbita é uma ação do admin → estado 'aprovada'.
    try {
      await Ausencia.create({
        utilizador_id: id,
        empresa_id: empresaId,
        data_inicio: hojeInicio,
        data_fim: hojeInicio,
        tipo: 'outro',
        estado: 'aprovada',
        notas: 'Falta súbita reportada pelo admin',
      });
    } catch (err) {
      if (err.code !== 11000) {
        console.error('⚠️  Erro ao criar ausência de falta súbita:', err.message);
      }
      // Se duplicado, não é problema — o utilizador já tem ausência hoje.
    }

    // 3) Procura tarefas de hoje do utilizador (atribuida ou por_atribuir).
    const tarefas = await Tarefa.find({
      utilizador_id: id,
      data: { $gte: hojeInicio, $lt: amanhaInicio },
      estado: { $in: ['atribuida', 'por_atribuir'] },
    }).populate({ path: 'propriedade_id', select: 'nome' });

    if (tarefas.length === 0) {
      return res.status(200).json({
        mensagem: 'Sem tarefas para desatribuir hoje.',
        desatribuidas: 0,
        total: 0,
        detalhes: [],
      });
    }

    // 4) Desatribui cada tarefa (SEM load balancer — Prompt 97).
    let desatribuidas = 0;
    const detalhes = [];

    for (const tarefa of tarefas) {
      tarefa.utilizador_id = null;
      tarefa.estado = 'por_atribuir';
      await tarefa.save();
      desatribuidas++;
      detalhes.push({
        tarefa_id: String(tarefa._id),
        propriedade: tarefa.propriedade_id?.nome ?? '?',
        novo_utilizador_id: null,
        reatribuida: false,
      });
    }

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'falta_subita',
      recurso: 'utilizador',
      recurso_id: id,
      descricao: `Falta súbita reportada para "${utilizador.nome}": ${desatribuidas} tarefa(s) desatribuída(s)`,
      detalhes: { desatribuidas, total: tarefas.length },
    });

    return res.status(200).json({
      mensagem: `Falta súbita processada: ${desatribuidas} tarefa(s) desatribuída(s) (por atribuir).`,
      desatribuidas,
      total: tarefas.length,
      detalhes,
    });
  } catch (err) {
    console.error('❌ reportarFaltaSubita:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Baixa Prolongada / Férias — Redistribuição de tarefas futuras      */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/equipa/:id/baixa
 *
 * Regista uma ausência prolongada (baixa/férias) e desatribui TODAS as
 * tarefas futuras do utilizador nesse período (passam a 'por_atribuir').
 *
 * Body: { data_inicio, data_fim, tipo?, notas? }
 *
 * Lógica (Prompt 97 — "Desligar a Histeria Automática"):
 *   1. Valida utilizador (empresa, não admin, não eliminado).
 *   2. Cria Ausencia (ignora duplicado).
 *   3. Desatribui as tarefas atribuídas no período [data_inicio, data_fim]
 *      (utilizador_id = null + estado = 'por_atribuir') — NÃO chama o load
 *      balancer. O recálculo fica a cargo do Gestor (manual) ou do
 *      Fail-Safe noturno.
 *
 * Resposta 200: { desatribuidas, total, detalhes: [...] }
 */
exports.registarBaixaProlongada = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    const { data_inicio, data_fim, tipo, notas } = req.body || {};
    if (!data_inicio || !data_fim) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: data_inicio e data_fim.',
      });
    }

    // Valida utilizador.
    const utilizador = await Utilizador.findOne({
      _id: id,
      empresa_id: empresaId,
      eliminado_em: null,
    });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível registar baixa de um administrador.',
      });
    }

    // Normaliza datas para meia-noite UTC.
    const dInicio = new Date(data_inicio);
    const inicio = new Date(
      Date.UTC(dInicio.getUTCFullYear(), dInicio.getUTCMonth(), dInicio.getUTCDate())
    );
    const dFim = new Date(data_fim);
    const fim = new Date(
      Date.UTC(dFim.getUTCFullYear(), dFim.getUTCMonth(), dFim.getUTCDate())
    );
    // fim do dia = meia-noite do dia seguinte (para query <).
    const fimDia = new Date(fim.getTime() + 24 * 60 * 60 * 1000);

    if (fim < inicio) {
      return res.status(400).json({
        erro: 'data_fim não pode ser anterior a data_inicio.',
      });
    }

    // 1) Cria a Ausencia (ignora duplicado).
    // v1.24.0: baixa prolongada é uma ação do admin → estado 'aprovada'.
    try {
      await Ausencia.create({
        utilizador_id: id,
        empresa_id: empresaId,
        data_inicio: inicio,
        data_fim: fim,
        tipo: tipo || 'ferias',
        estado: 'aprovada',
        notas: notas ? String(notas).trim() : '',
      });
    } catch (err) {
      if (err.code !== 11000) {
        console.error('⚠️  Erro ao criar ausência de baixa:', err.message);
      }
      // Se duplicado, não é problema.
    }

    // 2) Procura tarefas atribuídas no período.
    const tarefas = await Tarefa.find({
      utilizador_id: id,
      data: { $gte: inicio, $lt: fimDia },
      estado: 'atribuida',
    }).populate({ path: 'propriedade_id', select: 'nome' });

    if (tarefas.length === 0) {
      return res.status(200).json({
        mensagem: 'Sem tarefas para desatribuir no período.',
        desatribuidas: 0,
        total: 0,
        detalhes: [],
      });
    }

    // 3) Desatribui cada tarefa (SEM load balancer — Prompt 97).
    let desatribuidas = 0;
    const detalhes = [];

    for (const tarefa of tarefas) {
      tarefa.utilizador_id = null;
      tarefa.estado = 'por_atribuir';
      await tarefa.save();
      desatribuidas++;
      detalhes.push({
        tarefa_id: String(tarefa._id),
        data: tarefa.data,
        propriedade: tarefa.propriedade_id?.nome ?? '?',
        novo_utilizador_id: null,
        reatribuida: false,
      });
    }

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Admin',
      empresa_id: empresaId,
      acao: 'baixa_prolongada',
      recurso: 'utilizador',
      recurso_id: id,
      descricao: `Baixa/férias registadas para "${utilizador.nome}": ${desatribuidas} tarefa(s) desatribuída(s)`,
      detalhes: { data_inicio: inicio, data_fim: fim, desatribuidas, total: tarefas.length },
    });

    return res.status(200).json({
      mensagem: `Baixa processada: ${desatribuidas} tarefa(s) desatribuída(s) (por atribuir).`,
      desatribuidas,
      total: tarefas.length,
      detalhes,
    });
  } catch (err) {
    console.error('❌ registarBaixaProlongada:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Exportação CSV                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/tarefas/export?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
 * Exporta tarefas em formato CSV (para Excel/Sheets).
 *
 * Resposta 200: text/csv (download direto)
 */
exports.exportarTarefasCSV = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { inicio, fim } = req.query;
    const filtro = { empresa_id: empresaId, estado: { $ne: 'cancelada' } };
    if (inicio || fim) {
      const dataFiltro = {};
      if (inicio) {
        const d = new Date(inicio);
        if (!isNaN(d.getTime())) dataFiltro.$gte = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }
      if (fim) {
        const d = new Date(fim);
        if (!isNaN(d.getTime())) dataFiltro.$lt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 86400000);
      }
      if (Object.keys(dataFiltro).length > 0) filtro.data = dataFiltro;
    }

    const tarefas = await Tarefa.find(filtro)
      .populate({ path: 'propriedade_id', select: 'nome' })
      .populate({ path: 'utilizador_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    // Cabeçalho CSV.
    const header = 'Data,Propriedade,Funcionario,Tipo,Estado,Tempo Limpeza (min),Observacoes\n';
    const linhas = tarefas.map((t) => {
      const data = new Date(t.data).toLocaleDateString('pt-PT');
      const prop = (t.propriedade_id?.nome || '').replace(/,/g, ';');
      const func = (t.utilizador_id?.nome || 'Por atribuir').replace(/,/g, ';');
      const obs = (t.observacoes || '').replace(/[\n\r,]/g, ' ');
      return `${data},${prop},${func},${t.tipo},${t.estado},${t.tempo_limpeza_minutos},${obs}`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tarefas.csv"');
    return res.status(200).send(header + linhas);
  } catch (err) {
    console.error('❌ exportarTarefasCSV:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Auditoria                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/auditoria
 * Lista os registos de auditoria da empresa (ordenados por data desc).
 *
 * Query params: ?limit=50 (default 50, máx 200)
 *
 * Resposta 200: { auditoria: [...] }
 */
exports.getAuditoria = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const limit = Math.min(Number(req.query?.limit) || 50, 200);

    const auditoria = await Auditoria.find({ empresa_id: empresaId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({ auditoria });
  } catch (err) {
    console.error('❌ getAuditoria:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Setup do "Cliente Zero" (bootstrap do ambiente de testes)          */
/* ------------------------------------------------------------------ */

/**
 * GET /api/gestor/setup
 *
 * Cria o "Cliente Zero" — dados iniciais para testes:
 *   - 1 Empresa: "All2gether Teste"
 *   - 1 Utilizador Staff: "João Staff"
 *   - 1 Propriedade: "Apartamento Teste"
 *
 * F0: Removido smoobu_id (integração Smoobu eliminada).
 *
 * Idempotente: antes de criar, verifica se a empresa já existe (por nome).
 * Se já existir, reutiliza-a e cria apenas o que faltar.
 *
 * Devolve o `empresa_id` gerado/reutilizado no JSON de resposta.
 */
exports.setupClienteZero = async (req, res) => {
  try {
    const NOME_EMPRESA = 'All2gether Teste';
    const NOME_PROPRIEDADE = 'Apartamento Teste';
    // F0 — SMOOBU_ID_TESTE removido.
    // Password comum de teste do Cliente Zero (em produção, cada utilizador
    // deve alterar a sua password após o primeiro login).
    const PASSWORD_TESTE = 'all2gether123';

    // Utilizadores a garantir (admin + gestor + staff).
    const UTILIZADORES_TESTE = [
      {
        nome: 'Diretor All2gether', // admin — para ti (dono da conta)
        email: 'admin@all2gether.pt',
        role: 'admin',
      },
      {
        nome: 'Gestor de Operações', // gestor — gere a equipa
        email: 'gestor@all2gether.pt',
        role: 'gestor',
      },
      {
        nome: 'João Staff', // staff — executante
        email: 'joao.staff@all2gether.pt',
        role: 'staff',
      },
    ];

    // 1) Empresa — não duplicar (procura por nome).
    let empresa = await Empresa.findOne({ nome: NOME_EMPRESA });
    let empresaCriada = false;
    if (!empresa) {
      empresa = await Empresa.create({
        nome: NOME_EMPRESA,
      });
      empresaCriada = true;
    }

    // 2) Utilizadores (admin + gestor + staff) — não duplicar (email único).
    //    Para cada um: cria se não existir, ou define password se existir sem.
    const utilizadores = [];
    for (const u of UTILIZADORES_TESTE) {
      let user = await Utilizador.findOne({ email: u.email });
      let criado = false;
      let passwordDefinida = false;

      if (!user) {
        const password_hash = await bcrypt.hash(PASSWORD_TESTE, 10);
        user = await Utilizador.create({
          nome: u.nome,
          email: u.email,
          password_hash,
          empresa_id: empresa._id,
          role: u.role,
          ativo: true,
        });
        criado = true;
        passwordDefinida = true;
      } else if (!user.password_hash) {
        // Retrocompatibilidade: utilizador criado antes do auth, sem password.
        const password_hash = await bcrypt.hash(PASSWORD_TESTE, 10);
        user.empresa_id = user.empresa_id || empresa._id;
        user.password_hash = password_hash;
        // Garante que o role está correto (caso tenha sido criado com role antigo).
        user.role = u.role;
        await user.save();
        passwordDefinida = true;
      }

      utilizadores.push({
        id: user._id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        criado,
        password_definida: passwordDefinida,
        credenciais_teste: {
          email: u.email,
          password: PASSWORD_TESTE,
        },
      });
    }

    // 3) Propriedade — não duplicar (procura por nome + empresa).
    // F0 — procura por nome em vez de smoobu_id (campo removido).
    let propriedade = await Propriedade.findOne({ nome: NOME_PROPRIEDADE, empresa_id: empresa._id });
    let propriedadeCriada = false;
    if (!propriedade) {
      propriedade = await Propriedade.create({
        nome: NOME_PROPRIEDADE,
        empresa_id: empresa._id,
        tempo_limpeza_minutos: 45,
      });
      propriedadeCriada = true;
    }

    const algoCriado =
      empresaCriada ||
      utilizadores.some((u) => u.criado) ||
      propriedadeCriada;

    return res.status(200).json({
      mensagem: algoCriado
        ? 'Cliente Zero criado com sucesso.'
        : 'Cliente Zero já existia (nada foi alterado).',
      empresa_id: empresa._id,
      empresa: {
        id: empresa._id,
        nome: empresa.nome,
        criada: empresaCriada,
      },
      // 3 utilizadores: admin (dono), gestor (responsável clínico), staff (executante).
      utilizadores,
      propriedade: {
        id: propriedade._id,
        nome: propriedade.nome,
        criada: propriedadeCriada,
      },
    });
  } catch (err) {
    console.error('❌ setupClienteZero:', err.message);

    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Conflito de dados duplicados.',
        detalhe: err.keyValue,
      });
    }

    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Webhooks — Logs de integrações externas                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/gestor/webhooks
 * Lista os WebhookLogs recebidos (ordenados por data desc).
 *
 * F0 — A integração Smoobu foi removida, mas o modelo WebhookLog é
 * genérico e mantém-se para futuras integrações (saúde, faturação, etc.).
 *
 * Query params:
 *   - status (opcional): filtra por estado ('recebido' | 'processado' | 'erro')
 *   - limit (opcional, default 50, máx 200)
 *
 * Resposta 200: { webhooks: [...], total }
 */
exports.getWebhooks = async (req, res) => {
  try {
    // Não usamos obterEmpresaId aqui porque o WebhookLog é global — não tem
    // empresa_id. A auth continua a ser exigida (rota protegida) para que só
    // admins autenticados vejam os logs.
    const { status } = req.query;
    const limit = Math.min(Number(req.query?.limit) || 50, 200);

    const filtro = {};
    if (status && ['recebido', 'processado', 'erro'].includes(status)) {
      filtro.status = status;
    }

    const [webhooks, total] = await Promise.all([
      WebhookLog.find(filtro)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      WebhookLog.countDocuments(filtro),
    ]);

    return res.status(200).json({ webhooks, total });
  } catch (err) {
    console.error('❌ getWebhooks:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/gestor/webhooks/:id/reprocessar
 * F0 — Endpoint DESATIVADO. A integração Smoobu foi removida na F0.
 * Mantido como stub 410 Gone para não quebrar clientes antigos.
 * Será removido completamente quando o frontend for atualizado.
 */
exports.reprocessarWebhook = async (req, res) => {
  return res.status(410).json({
    erro: 'Reprocessamento de webhooks foi desativado (integração Smoobu removida na F0).',
  });
};
