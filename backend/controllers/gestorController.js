/**
 * Admin Controller — Autocell
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

    const propriedades = await Propriedade.find({ empresa_id: empresaId }).sort(
      { nome: 1 }
    );

    return res.status(200).json({ propriedades });
  } catch (err) {
    console.error('❌ getPropriedades:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/admin/propriedades
 * Cria uma propriedade para essa empresa.
 * Valida: smoobu_id (obrigatório + único), nome (obrigatório),
 * tempo_limpeza_minutos (opcional, default 45).
 *
 * Body esperado:
 *   { smoobu_id, nome, tempo_limpeza_minutos? }
 */
exports.criarPropriedade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { smoobu_id, nome, morada, tempo_limpeza_minutos } = req.body || {};

    // Validações de presença.
    if (!smoobu_id || !nome || !morada) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: smoobu_id, nome e morada.',
      });
    }

    // Validação de unicidade do smoobu_id (global, não por empresa — é o ID
    // do apartment no Smoobu, pelo que não pode repetir-se entre empresas).
    const existente = await Propriedade.findOne({ smoobu_id: String(smoobu_id) });
    if (existente) {
      return res.status(409).json({
        erro: `Já existe uma propriedade com smoobu_id "${smoobu_id}".`,
      });
    }

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
    const moradaTrim = String(morada).trim();
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
      smoobu_id: String(smoobu_id),
      nome: String(nome).trim(),
      morada: moradaTrim,
      coordenadas,
      empresa_id: empresaId,
      tempo_limpeza_minutos: tempo,
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
      detalhes: { smoobu_id: nova.smoobu_id, morada: nova.morada },
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
      .populate({ path: 'utilizador_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos (best-effort).
    const { calcularTempoViagem } = require('../utils/scheduler');
    const tarefasComViagem = tarefas.map((t) => {
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
      .populate({ path: 'utilizador_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    // Prompt 139 — Cálculo on-the-fly de tempo_viagem_minutos para tarefas
    // antigas que não têm o campo preenchido (criadas antes do Prompt 138).
    // Agrupa por utilizador + dia, ordena por data, e calcula a viagem entre
    // tarefas consecutivas usando Haversine (capped 60min, fallback 30min).
    // Isto é best-effort: se não houver coordenadas, fica 0.
    const { calcularTempoViagem } = require('../utils/scheduler');
    const tarefasComViagem = tarefas.map((t) => {
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
        const diaSemana = diaAtual.getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb

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

        diaAtual.setDate(diaAtual.getDate() + 1);
      }

      // ----------------------------------------------------------------
      // v1.57.0 (Prompt 79) — Injeta ausências APROVADAS (férias/doença)
      // como eventos virtuais no calendário, para o gestor ver quem está
      // indisponível em cada dia. Só ausências 'aprovada' (pendentes/
      // rejeitadas não contam — não são garantidas).
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

      // Filtra ausências cujo utilizador foi eliminado (soft delete) —
      // não devem aparecer no calendário.
      const ausenciasFiltradas = ausenciasAprovadas.filter(
        (a) => a.utilizador_id && !a.utilizador_id.eliminado_em
      );

      // Converte cada ausência num evento virtual tipo 'ausencia'.
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
          tempo_limpeza_minutos: 0,
          propriedade_id: null,
          notas: a.notas || '',
        };
      });

      // Junta tarefas + folgas fixas + ausências e ordena por data.
      // Prompt 139 — usa tarefasComViagem (com tempo_viagem_minutos calculado).
      const resultado = [...tarefasComViagem, ...diasFolga, ...eventosAusencias].sort(
        (a, b) => new Date(a.data).getTime() - new Date(b.data).getTime()
      );

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
 * Propriedades inativas são ignoradas pelo webhook do Smoobu.
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
 * PUT /api/admin/propriedades/:id
 * Atualiza os dados de uma propriedade (nome, smoobu_id, morada,
 * tempo_limpeza_minutos). Se a morada mudar, re-faz geocoding para
 * atualizar as coordenadas (usadas no load balancer Haversine).
 *
 * Body (todos opcionais, mas pelo menos um tem de vir):
 *   { nome?, smoobu_id?, morada?, tempo_limpeza_minutos? }
 *
 * Regras:
 *   - Valida pertença à empresa (404 se não pertencer).
 *   - smoobu_id é globalmente único → se mudar, valida que não há conflito
 *     com outra propriedade (409 se houver).
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

    const { nome, smoobu_id, morada, tempo_limpeza_minutos, funcionario_preferencial_id, modelo_checklist_id } = req.body || {};

    // Tem de haver pelo menos um campo para atualizar.
    if (
      nome === undefined &&
      smoobu_id === undefined &&
      morada === undefined &&
      tempo_limpeza_minutos === undefined &&
      funcionario_preferencial_id === undefined &&
      modelo_checklist_id === undefined &&
      req.body?.checklist === undefined
    ) {
      return res.status(400).json({
        erro: 'Nenhum campo para atualizar. Envie nome, smoobu_id, morada, tempo_limpeza_minutos, checklist, funcionario_preferencial_id ou modelo_checklist_id.',
      });
    }

    // Validações de formato (se vierem).
    if (nome !== undefined && !String(nome).trim()) {
      return res.status(400).json({ erro: 'nome não pode ser vazio.' });
    }
    if (smoobu_id !== undefined && !String(smoobu_id).trim()) {
      return res.status(400).json({ erro: 'smoobu_id não pode ser vazio.' });
    }
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

    // smoobu_id único (global) — se mudou, verificar conflito com outra propriedade.
    const novoSmoobuId =
      smoobu_id !== undefined ? String(smoobu_id).trim() : propriedade.smoobu_id;
    if (novoSmoobuId !== propriedade.smoobu_id) {
      const conflito = await Propriedade.findOne({ smoobu_id: novoSmoobuId });
      if (conflito && String(conflito._id) !== String(propriedade._id)) {
        return res.status(409).json({
          erro: `Já existe outra propriedade com smoobu_id "${novoSmoobuId}".`,
        });
      }
      propriedade.smoobu_id = novoSmoobuId;
    }

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
    let geocodingFalhou = false;
    if (morada !== undefined) {
      const novaMorada = String(morada).trim();
      if (novaMorada !== propriedade.morada) {
        propriedade.morada = novaMorada;
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

    // v1.34.0: atualiza checklist (array de strings).
    if (req.body?.checklist !== undefined) {
      propriedade.checklist = Array.isArray(req.body.checklist)
        ? req.body.checklist.filter((s) => typeof s === 'string' && s.trim())
        : [];
    }

    // Prompt 95 (Fase 1.5) — Funcionário preferencial (Algoritmo VIP).
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
      detalhes: { smoobu_id: propriedade.smoobu_id, morada: propriedade.morada },
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
    const utilizadores = await Utilizador.find({
      empresa_id: empresaId,
      eliminado_em: null,
      ativo: true,
      role: { $ne: 'admin' },
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

    const { nome, email, password, role, responsavel_id, dias_folga, telefone } = req.body || {};

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
    const roleFinal = role || 'staff';
    if (!['admin', 'gestor', 'staff'].includes(roleFinal)) {
      return res.status(400).json({
        erro: 'Role inválido. Valores permitidos: admin, gestor, staff.',
      });
    }

    // SEGURANÇA: Não é possível criar utilizadores com role 'admin'.
    // O admin é criado apenas via /api/admin/setup (bootstrap) ou processo separado.
    if (roleFinal === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível criar utilizadores com role "admin".',
      });
    }

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
    let responsavelValidado = null;
    if (responsavel_id) {
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
    let diasFolgaFinal = [];
    if (dias_folga !== undefined && dias_folga !== null) {
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
      ativo: true,
    });

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

    const { nome, email, role, password, responsavel_id, dias_folga, telefone } = req.body || {};
    if (
      nome === undefined &&
      email === undefined &&
      role === undefined &&
      password === undefined &&
      responsavel_id === undefined &&
      dias_folga === undefined &&
      telefone === undefined
    ) {
      return res.status(400).json({
        erro: 'Nada para atualizar. Envie nome, email, role, password, responsavel_id, dias_folga e/ou telefone.',
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
    if (role !== undefined) {
      if (!['gestor', 'staff'].includes(role)) {
        return res.status(400).json({
          erro: 'Role inválido. Valores permitidos via edição: gestor, staff.',
        });
      }
      utilizador.role = role;
    }

    // --- Responsável (opcional: null = sem responsável) ---
    if (responsavel_id !== undefined) {
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
    if (dias_folga !== undefined) {
      if (!Array.isArray(dias_folga)) {
        return res.status(400).json({ erro: 'dias_folga deve ser um array de inteiros (0-6).' });
      }
      utilizador.dias_folga = dias_folga.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    }

    // --- telefone (opcional) ---
    if (telefone !== undefined) {
      utilizador.telefone = String(telefone).trim();
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

    const resp = utilizador.toObject();
    delete resp.password_hash;
    return res.status(200).json({ utilizador: resp, ativo: novoEstado });
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
 * GET /api/admin/setup
 *
 * Cria o "Cliente Zero" — dados iniciais para testes:
 *   - 1 Empresa: "O Meu Alojamento Local"
 *   - 1 Utilizador Staff: "João Limpezas"
 *   - 1 Propriedade: "Casa Teste" (smoobu_id: "99999")
 *
 * Idempotente: antes de criar, verifica se a empresa já existe (por nome).
 * Se já existir, reutiliza-a e cria apenas o que faltar.
 *
 * Devolve o `empresa_id` gerado/reutilizado no JSON de resposta.
 */
exports.setupClienteZero = async (req, res) => {
  try {
    const NOME_EMPRESA = 'O Meu Alojamento Local';
    const NOME_PROPRIEDADE = 'Casa Teste';
    const SMOOBU_ID_TESTE = '99999';
    // Password comum de teste do Cliente Zero (em produção, cada utilizador
    // deve alterar a sua password após o primeiro login).
    const PASSWORD_TESTE = 'autocell123';

    // Utilizadores a garantir (admin + gestor + staff).
    const UTILIZADORES_TESTE = [
      {
        nome: 'Gestor Autocell', // admin — para ti (dono da conta)
        email: 'admin@autocell.pt',
        role: 'admin',
      },
      {
        nome: 'Responsável Limpezas', // gestor — gere a equipa de staff
        email: 'gestor@autocell.pt',
        role: 'gestor',
      },
      {
        nome: 'João Limpezas', // staff — executante de limpezas
        email: 'joao.limpezas@autocell.pt',
        role: 'staff',
      },
    ];

    // 1) Empresa — não duplicar (procura por nome).
    let empresa = await Empresa.findOne({ nome: NOME_EMPRESA });
    let empresaCriada = false;
    if (!empresa) {
      empresa = await Empresa.create({
        nome: NOME_EMPRESA,
        plano_ativo: true,
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

    // 3) Propriedade — não duplicar (procura por smoobu_id único).
    let propriedade = await Propriedade.findOne({ smoobu_id: SMOOBU_ID_TESTE });
    let propriedadeCriada = false;
    if (!propriedade) {
      propriedade = await Propriedade.create({
        smoobu_id: SMOOBU_ID_TESTE,
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
        plano_ativo: empresa.plano_ativo,
        criada: empresaCriada,
      },
      // 3 utilizadores: admin (dono), gestor (responsável limpezas), staff (executante).
      utilizadores,
      propriedade: {
        id: propriedade._id,
        nome: propriedade.nome,
        smoobu_id: propriedade.smoobu_id,
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
/* Webhooks — Logs do Smoobu                                          */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/webhooks
 * Lista os WebhookLogs recebidos do Smoobu (ordenados por data desc).
 *
 * Útil para o Admin confirmar que os webhooks estão a chegar e ver o estado
 * de processamento (recebido / processado / erro) + o payload bruto + a
 * mensagem de erro (se houver).
 *
 * Query params:
 *   - status (opcional): filtra por estado ('recebido' | 'processado' | 'erro')
 *   - limit (opcional, default 50, máx 200)
 *
 * Resposta 200: { webhooks: [...], total }
 *
 * NOTA: o WebhookLog é global (não tem empresa_id) porque o webhook é um
 * endpoint público do Smoobu. Em ambientes multi-tenant futuros, será
 * adicionada filtragem por empresa.
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
 * POST /api/admin/webhooks/:id/reprocessar
 * Reproccessa um WebhookLog que tenha ficado com status 'erro' (ou até
 * 'processado', se o Admin quiser forçar). Volta a chamar a lógica de
 * processamento com o payload original guardado no log.
 *
 * Útil quando um webhook falhou por um motivo transitório (ex: BD em baixo,
 * geocoding indisponível, propriedade ainda não criada) e o Admin já
 * corrigiu a causa raiz.
 *
 * Resposta 200: { status: 'processado' | 'erro', erro_msg: string | null }
 */
exports.reprocessarWebhook = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de webhook inválido.' });
    }

    const log = await WebhookLog.findById(id);
    if (!log) {
      return res.status(404).json({ erro: 'Webhook não encontrado.' });
    }

    // Reutiliza a função de processamento do webhookController.
    // A idempotência (verificação de smoobu_reserva_id duplicado) garante
    // que reproccessar um webhook já processado não cria tarefa duplicada.
    const { _processarReservaSmoobu } = require('../controllers/webhookController');

    try {
      await _processarReservaSmoobu(log.payload);
      log.status = 'processado';
      log.erro_msg = null;
      await log.save();
      return res.status(200).json({ status: 'processado', erro_msg: null });
    } catch (e) {
      log.status = 'erro';
      log.erro_msg = e.message;
      await log.save();
      return res.status(200).json({ status: 'erro', erro_msg: e.message });
    }
  } catch (err) {
    console.error('❌ reprocessarWebhook:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
