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
// FIX (sync parceiros) — Load balancer + scheduler para auto-atribuir a tarefa
// gerada pela reserva do parceiro (igual ao webhook do Smoobu).
const { determinarUtilizadorAtribuido, determinarEquipaAtribuida } = require('../utils/loadBalancer');
const { calcularInicioTarefaUtilizador } = require('../utils/scheduler');

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
    return res.status(500).json({ erro: 'Erro interno.' });
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
        erro: 'Propriedade não encontrada (ou não pertence a este proprietário).',
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
    return res.status(500).json({ erro: 'Erro interno.' });
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

/** Lê e limpa os campos opcionais extra da reserva (texto curto ou null). */
function lerCamposExtra(body) {
  const b = body || {};
  const t = (v, max) => {
    if (v === undefined) return undefined;
    const x = v === null ? '' : String(v).trim().slice(0, max);
    return x === '' ? null : x;
  };
  const out = {
    nome_hospede: t(b.nome_hospede, 120),
    plataforma: t(b.plataforma, 40),
    hora_checkin: t(b.hora_checkin, 60),
    horario_preferido: t(b.horario_preferido, 60),
  };
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

/** Campos da reserva que se refletem em tarefa.detalhes_reserva. */
function detalhesDaReserva(extras) {
  const d = {};
  if (extras.nome_hospede !== undefined) d.nome_hospede = extras.nome_hospede;
  if (extras.hora_checkin !== undefined) d.hora_checkin = extras.hora_checkin;
  if (extras.horario_preferido !== undefined) d.horario_preferido = extras.horario_preferido;
  return d;
}

/** Valida as datas (formato e check-out >= check-in). Devolve texto de erro ou null. */
function validarDatas(check_in, check_out) {
  const ci = new Date(check_in);
  const co = new Date(check_out);
  if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return 'Datas inválidas.';
  if (co < ci) return 'O check-out não pode ser anterior ao check-in.';
  return null;
}

/**
 * Gera a Tarefa de Limpeza (com auto-atribuição) para o check-out de uma reserva.
 * Partilhado por criarReserva e atualizarReserva (quando as datas mudam).
 * `detalhesExtra` é fundido em tarefa.detalhes_reserva (nome, hora, preferência…).
 */
async function gerarTarefaLimpezaReserva({
  propriedade, empresaId, check_in, check_out, numHospedes, observacoes, detalhesExtra = {},
}) {
  // Gera a Tarefa de Limpeza para o dia de check-out.
  const dataCheckOut = new Date(check_out);
  // Normaliza para meia-noite UTC.
  const dataTarefa = new Date(
    Date.UTC(dataCheckOut.getUTCFullYear(), dataCheckOut.getUTCMonth(), dataCheckOut.getUTCDate())
  );
  dataTarefa.setUTCHours(10, 0, 0, 0); // 10:00 UTC default

  // FIX (auto-atribuição) — Tenta alocar a tarefa a um funcionário via load
  // balancer (igual ao webhook do Smoobu). Se não encontrar staff disponível,
  // a tarefa fica 'por_atribuir' para o gestor resolver.
  const tempoNovaTarefa = propriedade.tempo_limpeza_minutos || 45;
  const staffNecessario = Math.max(1, Number(propriedade.staff_necessario) || 1);

  // Range do dia (meia-noite UTC a meia-noite do dia seguinte).
  const rangeStart = new Date(
    Date.UTC(dataCheckOut.getUTCFullYear(), dataCheckOut.getUTCMonth(), dataCheckOut.getUTCDate())
  );
  const rangeEnd = new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);
  const range = { start: rangeStart, end: rangeEnd };

  let utilizadorAtribuido = null;
  let equipaIds = [];
  let dataAgendada = dataTarefa;
  let tempoViagemFinal = 0;
  let estadoInicial = 'por_atribuir';
  let motivoNaoAtribuicao = null;

  try {
    if (staffNecessario > 1) {
      const resultadoEquipa = await determinarEquipaAtribuida(
        empresaId, range, propriedade.coordenadas, tempoNovaTarefa, propriedade._id, staffNecessario
      );
      if (resultadoEquipa && resultadoEquipa.equipa && resultadoEquipa.equipa.length > 0) {
        equipaIds = resultadoEquipa.equipa.map((m) => m.utilizadorId);
        utilizadorAtribuido = equipaIds[0]; // vencedor #1
      }
    } else {
      const resultadoLB = await determinarUtilizadorAtribuido(
        empresaId, range, propriedade.coordenadas, tempoNovaTarefa, propriedade._id
      );
      utilizadorAtribuido = resultadoLB?.utilizadorId ?? null;
      tempoViagemFinal = Number(resultadoLB?.tempoViagem) || 0;
    }

    if (utilizadorAtribuido) {
      // Scheduler sequencial: recalcula a hora de início com base nas
      // tarefas existentes do staff + tempo de viagem + almoço 13h-14h.
      try {
        const resultadoScheduler = await calcularInicioTarefaUtilizador(
          utilizadorAtribuido, rangeStart, propriedade.coordenadas, tempoNovaTarefa
        );
        if (resultadoScheduler?.data) {
          dataAgendada = resultadoScheduler.data;
        }
        if (resultadoScheduler?.tempoViagem) {
          tempoViagemFinal = Number(resultadoScheduler.tempoViagem) || tempoViagemFinal;
        }
      } catch (errScheduler) {
        console.warn('⚠️  [Parceiro] scheduler falhou (mantém 10:00 UTC):', errScheduler.message);
      }
      estadoInicial = 'atribuida';
    } else {
      // LB não encontrou ninguém — distingue SLA excedido vs sem staff ativo.
      motivoNaoAtribuicao = 'Sem equipa disponível (folga/férias ou lotação excedida)';
    }
  } catch (errAtribuicao) {
    console.warn('⚠️  [Parceiro] auto-atribuição falhou (tarefa fica por atribuir):', errAtribuicao.message);
    motivoNaoAtribuicao = 'Erro na auto-atribuição';
  }

  return Tarefa.create({
    empresa_id: empresaId,
    propriedade_id: propriedade._id,
    smoobu_reserva_id: null,
    origem: 'manual',
    utilizador_id: utilizadorAtribuido,
    equipa_atribuida: equipaIds.length > 0 ? equipaIds : undefined,
    data: dataAgendada,
    tempo_limpeza_minutos: tempoNovaTarefa,
    tempo_viagem_minutos: tempoViagemFinal,
    tipo: 'limpeza',
    estado: estadoInicial,
    motivo_nao_atribuicao: motivoNaoAtribuicao,
    observacoes: observacoes ? String(observacoes).trim() : '',
    hospedes: numHospedes, // FIX (fallback estrito) — pax ou capacidade_hospedes
    // FIX (sync parceiros) — Marca a tarefa como originária de uma reserva
    // de parceiro (para destaque visual e filtro "Apenas Parceiros").
    origem_parceiro: true,
    checklist: propriedade.checklist || [],
    detalhes_reserva: {
      checkin: String(check_in),
      checkout: String(check_out),
      pax: numHospedes,
      ...detalhesExtra,
    },
  });
}

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
    const extras = lerCamposExtra(req.body);

    if (!propriedade_id || !mongoose.isValidObjectId(propriedade_id)) {
      return res.status(400).json({ erro: 'propriedade_id é obrigatório.' });
    }
    if (!check_in || !check_out) {
      return res.status(400).json({ erro: 'check_in e check_out são obrigatórios.' });
    }
    const erroDatas = validarDatas(check_in, check_out);
    if (erroDatas) return res.status(400).json({ erro: erroDatas });

    // Valida que a propriedade pertence ao parceiro.
    const propriedade = await Propriedade.findOne({
      _id: propriedade_id,
      parceiro_id: parceiroId,
      ativo: true,
    }).lean();

    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a este proprietário).',
      });
    }

    // FIX (fallback hospedes estrito) — Se hospedes for null, 0 ou undefined,
    // usa a capacidade_hospedes da propriedade (lotação máxima da casa).
    // Antes só cobria null; agora cobre também 0 (falsy mas != null).
    let numHospedes = hospedes != null ? Number(hospedes) : null;
    if (numHospedes === null || numHospedes === 0 || Number.isNaN(numHospedes)) {
      numHospedes = propriedade.capacidade_hospedes ?? null;
    }

    // Cria a reserva.
    const novaReserva = await ReservaManual.create({
      propriedade_id: propriedade._id,
      parceiro_id: parceiroId,
      empresa_id: empresaId,
      check_in: new Date(check_in),
      check_out: new Date(check_out),
      hospedes: numHospedes,
      observacoes: observacoes ? String(observacoes).trim() : '',
      ...extras,
    });

    const detalhesTarefa = detalhesDaReserva(extras);
    const novaTarefa = await gerarTarefaLimpezaReserva({
      propriedade,
      empresaId,
      check_in,
      check_out,
      numHospedes,
      observacoes,
      detalhesExtra: detalhesTarefa,
    });

    // Associa a tarefa à reserva.
    novaReserva.tarefa_gerada_id = novaTarefa._id;
    await novaReserva.save();

    console.log(
      `📅 [Parceiro] reserva criada por parceiro ${parceiroId} para "${propriedade.nome}" ` +
        `(check-out: ${new Date(check_out).toISOString().slice(0, 10)}, hospedes: ${numHospedes}). ` +
        `Tarefa ${novaTarefa._id} gerada.`
    );

    return res.status(201).json({ reserva: novaReserva, tarefa: novaTarefa });
  } catch (err) {
    console.error('❌ parceiroController.criarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
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

/** Estados em que a limpeza já não pode ser alterada/cancelada pelo parceiro. */
const ESTADOS_BLOQUEADOS = ['em_curso', 'concluida'];

/**
 * PUT /api/parceiro/reservas/:id
 *
 * Edita uma reserva do parceiro. Se a limpeza já começou ou foi concluída,
 * recusa (409). Se o check-out mudou, a tarefa antiga é cancelada e é gerada
 * uma nova (com nova auto-atribuição); caso contrário atualiza a tarefa.
 */
async function atualizarReserva(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    const { id } = req.params;
    if (!parceiroId) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID inválido.' });

    const reserva = await ReservaManual.findOne({ _id: id, parceiro_id: parceiroId });
    if (!reserva) return res.status(404).json({ erro: 'Reserva não encontrada.' });

    const tarefa = reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id) : null;
    if (tarefa && ESTADOS_BLOQUEADOS.includes(tarefa.estado)) {
      return res.status(409).json({
        erro: 'A limpeza desta reserva já começou ou foi concluída. Contacta o gestor para alterações.',
      });
    }

    const body = req.body || {};
    const extras = lerCamposExtra(body);
    const novoCheckIn = body.check_in ?? reserva.check_in;
    const novoCheckOut = body.check_out ?? reserva.check_out;
    const erroDatas = validarDatas(novoCheckIn, novoCheckOut);
    if (erroDatas) return res.status(400).json({ erro: erroDatas });

    const dia = (d) => new Date(d).toISOString().slice(0, 10);
    const checkOutMudou = dia(novoCheckOut) !== dia(reserva.check_out);

    let numHospedes = reserva.hospedes;
    if (body.hospedes !== undefined) {
      const n = body.hospedes === null || body.hospedes === '' ? null : Number(body.hospedes);
      if (n !== null && (Number.isNaN(n) || n < 0)) {
        return res.status(400).json({ erro: 'Número de hóspedes inválido.' });
      }
      numHospedes = n;
    }
    if (numHospedes === null || numHospedes === 0) {
      const prop = await Propriedade.findById(reserva.propriedade_id).lean();
      numHospedes = prop?.capacidade_hospedes ?? null;
    }

    reserva.check_in = new Date(novoCheckIn);
    reserva.check_out = new Date(novoCheckOut);
    reserva.hospedes = numHospedes;
    if (body.observacoes !== undefined) reserva.observacoes = String(body.observacoes ?? '').trim();
    Object.assign(reserva, extras);

    const detalhesExtra = detalhesDaReserva(extras);
    if (tarefa && checkOutMudou) {
      const propriedade = await Propriedade.findById(reserva.propriedade_id).lean();
      tarefa.estado = 'cancelada';
      await tarefa.save();
      const nova = await gerarTarefaLimpezaReserva({
        propriedade,
        empresaId: reserva.empresa_id,
        check_in: dia(reserva.check_in),
        check_out: dia(reserva.check_out),
        numHospedes,
        observacoes: reserva.observacoes,
        detalhesExtra: {
          nome_hospede: reserva.nome_hospede,
          hora_checkin: reserva.hora_checkin,
          horario_preferido: reserva.horario_preferido,
        },
      });
      reserva.tarefa_gerada_id = nova._id;
    } else if (tarefa) {
      tarefa.hospedes = numHospedes;
      tarefa.observacoes = reserva.observacoes;
      tarefa.detalhes_reserva = {
        ...(tarefa.detalhes_reserva?.toObject?.() ?? tarefa.detalhes_reserva ?? {}),
        checkin: dia(reserva.check_in),
        checkout: dia(reserva.check_out),
        pax: numHospedes,
        ...detalhesExtra,
      };
      await tarefa.save();
    }
    await reserva.save();

    const atualizada = await ReservaManual.findById(reserva._id)
      .populate('propriedade_id', 'nome morada')
      .populate('tarefa_gerada_id', 'estado data')
      .lean();
    return res.status(200).json({ reserva: atualizada });
  } catch (err) {
    console.error('❌ parceiroController.atualizarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

/**
 * DELETE /api/parceiro/reservas/:id
 *
 * Elimina a reserva e cancela a tarefa de limpeza associada (mantém o
 * histórico da tarefa como 'cancelada'). Recusa se a limpeza já começou.
 */
async function eliminarReserva(req, res) {
  try {
    const parceiroId = req.user && req.user.id;
    const { id } = req.params;
    if (!parceiroId) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID inválido.' });

    const reserva = await ReservaManual.findOne({ _id: id, parceiro_id: parceiroId });
    if (!reserva) return res.status(404).json({ erro: 'Reserva não encontrada.' });

    const tarefa = reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id) : null;
    if (tarefa && ESTADOS_BLOQUEADOS.includes(tarefa.estado)) {
      return res.status(409).json({
        erro: 'A limpeza desta reserva já começou ou foi concluída. Contacta o gestor.',
      });
    }
    if (tarefa && tarefa.estado !== 'cancelada') {
      tarefa.estado = 'cancelada';
      await tarefa.save();
    }
    await reserva.deleteOne();
    return res.status(200).json({ mensagem: 'Reserva eliminada.' });
  } catch (err) {
    console.error('❌ parceiroController.eliminarReserva:', err.message);
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
  atualizarReserva,
  eliminarReserva,
};
