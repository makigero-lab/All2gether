/**
 * Parceiro Controller — All2gether (Fase 3 / HF17)
 *
 * Controller para o Portal de Parceiros B2B. Permite que utilizadores
 * externos (role 'parceiro') criem as suas próprias propriedades manuais
 * e agendem limpezas espontâneas sem depender do Smoobu.
 *
 * Rotas (montadas em /api/parceiro):
 *   POST /propriedades — criar casa manual
 *   POST /tarefas      — criar limpeza manual/espontânea
 *   GET  /propriedades — listar as suas propriedades
 *   GET  /tarefas      — listar as suas tarefas
 *
 * Segurança: todas as rotas são protegidas por auth + isParceiro.
 * O parceiro só pode ver/gerir propriedades e tarefas que ele criou
 * (filtro por parceiro_id = req.user.id).
 */

const mongoose = require('mongoose');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { obterCoordenadas } = require('../utils/geocoding');

/**
 * POST /api/parceiro/propriedades
 *
 * Cria uma propriedade manual associada ao parceiro autenticado.
 *
 * Body:
 *   nome: String (obrigatório)
 *   morada: String (obrigatório)
 *   tempo_limpeza_minutos: Number (opcional, default 45)
 *   capacidade_hospedes: Number (opcional)
 *
 * A propriedade é criada com:
 *   - origem: 'manual'
 *   - smoobu_id: null (não vem do Smoobu)
 *   - parceiro_id: req.user.id (o parceiro que a criou)
 *   - empresa_id: req.user.empresa_id (a empresa do parceiro)
 *   - coordenadas: geocoding automático via Nominatim (best-effort)
 */
async function criarPropriedade(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { nome, morada, tempo_limpeza_minutos, capacidade_hospedes } = req.body || {};

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'nome é obrigatório.' });
    }
    if (!morada || !String(morada).trim()) {
      return res.status(400).json({ erro: 'morada é obrigatória.' });
    }

    // Geocoding best-effort (não bloqueia se falhar).
    let coordenadas = { lat: null, lng: null };
    try {
      const result = await obterCoordenadas(String(morada).trim());
      if (result) coordenadas = result;
    } catch (e) {
      console.warn('⚠️  [Parceiro] geocoding falhou (continua sem coordenadas):', e.message);
    }

    const novaPropriedade = await Propriedade.create({
      nome: String(nome).trim(),
      morada: String(morada).trim(),
      coordenadas,
      empresa_id: empresaId,
      tempo_limpeza_minutos: Number(tempo_limpeza_minutos) || 45,
      capacidade_hospedes: capacidade_hospedes != null ? Number(capacidade_hospedes) : null,
      origem: 'manual',
      smoobu_id: null,
      parceiro_id: parceiroId,
      ativo: true,
    });

    console.log(
      `🏠 [Parceiro] propriedade "${novaPropriedade.nome}" criada por parceiro ${parceiroId}.`
    );

    return res.status(201).json({ propriedade: novaPropriedade });
  } catch (err) {
    console.error('❌ parceiroController.criarPropriedade:', err.message);
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
}

/**
 * GET /api/parceiro/propriedades
 *
 * Lista as propriedades criadas pelo parceiro autenticado.
 */
async function listarPropriedades(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    if (!parceiroId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const propriedades = await Propriedade.find({
      parceiro_id: parceiroId,
      ativo: true,
    })
      .select('nome morada coordenadas tempo_limpeza_minutos capacidade_hospedes origem')
      .lean();

    return res.status(200).json({ propriedades });
  } catch (err) {
    console.error('❌ parceiroController.listarPropriedades:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

/**
 * POST /api/parceiro/tarefas
 *
 * Cria uma tarefa de limpeza manual/espontânea associada a uma propriedade
 * do parceiro. A tarefa fica com estado 'por_atribuir' — o gestor da empresa
 * é responsável por atribuir a um staff (ou o load balancer pode ser
 * invocado posteriormente).
 *
 * Body:
 *   propriedade_id: String (obrigatório — tem de pertencer ao parceiro)
 *   data: String "YYYY-MM-DD" (obrigatório)
 *   observacoes: String (opcional)
 *   tempo_limpeza_minutos: Number (opcional, usa o da propriedade se não vier)
 */
async function criarTarefa(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { propriedade_id, data, observacoes, tempo_limpeza_minutos } = req.body || {};

    if (!propriedade_id || !mongoose.isValidObjectId(propriedade_id)) {
      return res.status(400).json({ erro: 'propriedade_id é obrigatório e deve ser um ID válido.' });
    }
    if (!data) {
      return res.status(400).json({ erro: 'data é obrigatória (formato YYYY-MM-DD).' });
    }

    // Valida que a propriedade pertence ao parceiro.
    const propriedade = await Propriedade.findOne({
      _id: propriedade_id,
      parceiro_id: parceiroId,
      ativo: true,
    }).lean();

    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a este parceiro).',
      });
    }

    // Valida a data.
    const dataTarefa = new Date(data);
    if (isNaN(dataTarefa.getTime())) {
      return res.status(400).json({ erro: 'data inválida.' });
    }

    // Cria a tarefa manual.
    const novaTarefa = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: propriedade._id,
      smoobu_reserva_id: null, // tarefa manual — sem reserva Smoobu
      origem: 'manual',
      utilizador_id: null, // por atribuir — o gestor ou LB decide
      data: dataTarefa,
      tempo_limpeza_minutos: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
      observacoes: observacoes ? String(observacoes).trim() : '',
      checklist: propriedade.checklist || [],
    });

    console.log(
      `🧹 [Parceiro] tarefa manual ${novaTarefa._id} criada por parceiro ${parceiroId} ` +
        `para propriedade "${propriedade.nome}" em ${dataTarefa.toISOString().slice(0, 10)}.`
    );

    return res.status(201).json({ tarefa: novaTarefa });
  } catch (err) {
    console.error('❌ parceiroController.criarTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
}

/**
 * GET /api/parceiro/tarefas
 *
 * Lista as tarefas criadas pelo parceiro (via propriedades que lhe pertencem).
 */
async function listarTarefas(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    if (!parceiroId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    // Busca os IDs das propriedades do parceiro.
    const propriedadesIds = await Propriedade.find({
      parceiro_id: parceiroId,
    })
      .select('_id')
      .lean();

    if (propriedadesIds.length === 0) {
      return res.status(200).json({ tarefas: [] });
    }

    const tarefas = await Tarefa.find({
      propriedade_id: { $in: propriedadesIds.map((p) => p._id) },
      origem: 'manual',
    })
      .populate('propriedade_id', 'nome morada')
      // FIX (portal lavandaria) — Inclui hospedes (bug latente: não era enviado)
      // e os novos campos de roupa para o portal do fornecedor.
      .select('data estado tipo observacoes hospedes tempo_limpeza_minutos origem roupa_entregue sacos_roupa_suja')
      .sort({ data: -1 })
      .lean();

    return res.status(200).json({ tarefas });
  } catch (err) {
    console.error('❌ parceiroController.listarTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

module.exports = {
  criarPropriedade,
  listarPropriedades,
  criarTarefa,
  listarTarefas,
};

/* ================================================================== */
/* HF23 — Reservas Manuais (Portal do Parceiro)                       */
/* ================================================================== */

const ReservaManual = require('../models/ReservaManual');

/**
 * POST /api/parceiro/reservas
 *
 * Cria uma reserva manual. Se hospedes não for preenchido, usa a capacidade
 * da propriedade. Gera automaticamente uma Tarefa de Limpeza para o dia de
 * check-out (origem: 'manual', estado: 'por_atribuir').
 *
 * Body:
 *   propriedade_id: String (obrigatório — tem de pertencer ao parceiro)
 *   check_in: String "YYYY-MM-DD" (obrigatório)
 *   check_out: String "YYYY-MM-DD" (obrigatório)
 *   hospedes: Number (opcional — usa capacidade da propriedade se vazio)
 *   observacoes: String (opcional)
 */
async function criarReserva(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const { propriedade_id, check_in, check_out, hospedes, observacoes } = req.body || {};

    if (!propriedade_id || !mongoose.isValidObjectId(propriedade_id)) {
      return res.status(400).json({ erro: 'propriedade_id é obrigatório.' });
    }
    if (!check_in || !check_out) {
      return res.status(400).json({ erro: 'check_in e check_out são obrigatórios.' });
    }

    // Valida que a propriedade pertence ao parceiro.
    const propriedade = await Propriedade.findOne({
      _id: propriedade_id,
      parceiro_id: parceiroId,
      ativo: true,
    }).lean();

    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a este parceiro).',
      });
    }

    // Hospedes: usa o valor enviado ou a capacidade da propriedade.
    const numHospedes = hospedes != null ? Number(hospedes) : (propriedade.capacidade_hospedes ?? null);

    // Cria a reserva.
    const novaReserva = await ReservaManual.create({
      propriedade_id: propriedade._id,
      parceiro_id: parceiroId,
      empresa_id: empresaId,
      check_in: new Date(check_in),
      check_out: new Date(check_out),
      hospedes: numHospedes,
      observacoes: observacoes ? String(observacoes).trim() : '',
    });

    // Gera a Tarefa de Limpeza para o dia de check-out.
    const dataCheckOut = new Date(check_out);
    // Normaliza para meia-noite UTC.
    const dataTarefa = new Date(
      Date.UTC(dataCheckOut.getUTCFullYear(), dataCheckOut.getUTCMonth(), dataCheckOut.getUTCDate())
    );
    dataTarefa.setUTCHours(10, 0, 0, 0); // 10:00 UTC default

    const novaTarefa = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id: propriedade._id,
      smoobu_reserva_id: null,
      origem: 'manual',
      utilizador_id: null,
      equipa_atribuida: [],
      data: dataTarefa,
      tempo_limpeza_minutos: propriedade.tempo_limpeza_minutos || 45,
      tipo: 'limpeza',
      estado: 'por_atribuir',
      observacoes: observacoes ? String(observacoes).trim() : '',
      hospedes: numHospedes, // HF23
      checklist: propriedade.checklist || [],
      detalhes_reserva: {
        checkin: String(check_in),
        checkout: String(check_out),
        pax: numHospedes,
      },
    });

    // Associa a tarefa à reserva.
    novaReserva.tarefa_gerada_id = novaTarefa._id;
    await novaReserva.save();

    console.log(
      `📅 [Parceiro] reserva criada por parceiro ${parceiroId} para "${propriedade.nome}" ` +
        `(check-out: ${dataTarefa.toISOString().slice(0, 10)}, hospedes: ${numHospedes}). ` +
        `Tarefa ${novaTarefa._id} gerada.`
    );

    return res.status(201).json({ reserva: novaReserva, tarefa: novaTarefa });
  } catch (err) {
    console.error('❌ parceiroController.criarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
}

/**
 * GET /api/parceiro/reservas
 *
 * Lista as reservas do parceiro autenticado.
 */
async function listarReservas(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    if (!parceiroId) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const reservas = await ReservaManual.find({ parceiro_id: parceiroId })
      .populate('propriedade_id', 'nome morada')
      .populate('tarefa_gerada_id', 'estado data')
      .sort({ check_out: -1 })
      .lean();

    return res.status(200).json({ reservas });
  } catch (err) {
    console.error('❌ parceiroController.listarReservas:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

module.exports = {
  criarPropriedade,
  listarPropriedades,
  criarTarefa,
  listarTarefas,
  criarReserva,
  listarReservas,
};
