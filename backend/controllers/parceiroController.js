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
const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
const { idsEquipa } = require('../utils/equipaTarefa');
const { agregarNotificacao } = require('../utils/notificarAgregado');
const { avisarGestores } = require('../utils/notificar');
const { temProgresso, planearAtribuicao: planearMotor, cabeNaAgendaNaHora } = require('../utils/atribuicaoAutomatica');
const {
  normalizarTipo, tipoDe, eSaida, tempoDoTipo, checklistDoTipo, temChecklistPropria, resolverDiaLimpeza, ROTULOS_TIPO,
} = require('../utils/tipoLimpeza');

const fmtDia = (d) => new Date(d).toISOString().slice(0, 10).split('-').reverse().join('/');

/** Avisa (agregado por pessoa) cada membro da equipa de uma limpeza nova. */
function avisarEquipaNova(tarefa, propriedade) {
  for (const id of idsEquipa(tarefa)) {
    agregarNotificacao(id, 'tarefa_atribuida', '🧹 Nova limpeza', `${propriedade.nome} em ${fmtDia(tarefa.data)}`, '/staff');
  }
}

/** Avisa quem saiu de uma limpeza cancelada/mudada de dia. */
function avisarEquipaSaiu(idsAntes, propriedade, dataAntiga, motivo) {
  for (const id of idsAntes) {
    agregarNotificacao(id, 'tarefa_cancelada', '❌ Limpeza cancelada', `${propriedade.nome} de ${fmtDia(dataAntiga)} ${motivo}`, '/staff');
  }
}

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
      // Manutenções (avarias reportadas pelo staff) são internas: o parceiro não as vê.
      tipo: { $ne: 'manutencao' },
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

const MAX_NOITES_RESERVA = 365;
const ANOS_PASSADO_MAX = 2;
const ANOS_FUTURO_MAX = 3;

/**
 * Valida as datas (formato e check-out >= check-in). Com `limites` (por omissão),
 * exige também que ambas fiquem entre 2 anos atrás e 3 à frente e que a estadia
 * não passe de 365 noites (0001-01-01 e 9999-12-31 deixam de passar).
 * Devolve texto de erro ou null.
 */
function validarDatas(check_in, check_out, { limites = true, agora = new Date() } = {}) {
  const ci = new Date(check_in);
  const co = new Date(check_out);
  if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return 'Datas inválidas.';
  if (co < ci) return 'O check-out não pode ser anterior ao check-in.';
  if (!limites) return null;
  // Só nos testes: a bateria antiga usa datas muito afastadas (2030-2064) de propósito.
  if (process.env.NODE_ENV === 'test' && process.env.DATAS_SEM_LIMITES === '1') return null;
  const min = Date.UTC(agora.getUTCFullYear() - ANOS_PASSADO_MAX, agora.getUTCMonth(), agora.getUTCDate());
  const max = Date.UTC(agora.getUTCFullYear() + ANOS_FUTURO_MAX, agora.getUTCMonth(), agora.getUTCDate());
  for (const d of [ci, co]) {
    if (d.getTime() < min || d.getTime() > max) {
      return `As datas têm de estar entre ${ANOS_PASSADO_MAX} anos atrás e ${ANOS_FUTURO_MAX} anos à frente.`;
    }
  }
  if ((co.getTime() - ci.getTime()) / 86400000 > MAX_NOITES_RESERVA) {
    return `A estadia não pode ter mais de ${MAX_NOITES_RESERVA} noites.`;
  }
  return null;
}

/**
 * Limpezas (não canceladas) de uma casa num dia de check-out, separadas entre as
 * de reservas do parceiro (ReservaManual) e as de outra origem (rotina, Smoobu,
 * tarefa manual do gestor). `excluirTarefaId` deixa de fora a própria tarefa.
 */
async function limpezasDoDia({ empresaId, propriedadeId, inicioDia, tipoLimpeza = 'normal', excluirTarefaId = null }) {
  // «Saída» (normal/profunda, sem o campo = normal) compara com outras saídas do dia; uma
  // intermédia ou de preparação só conflitua com outra do MESMO tipo nesse dia.
  const filtroTipo = eSaida(tipoLimpeza)
    ? { tipo_limpeza: { $nin: ['intermedia', 'preparacao'] } }
    : { tipo_limpeza: tipoLimpeza };
  const filtro = {
    empresa_id: empresaId,
    propriedade_id: propriedadeId,
    tipo: 'limpeza',
    estado: { $ne: 'cancelada' },
    data: { $gte: inicioDia, $lt: new Date(inicioDia.getTime() + 86400000) },
    ...filtroTipo,
  };
  if (excluirTarefaId) filtro._id = { $ne: excluirTarefaId };
  const tarefas = await Tarefa.find(filtro).select('_id').lean();
  if (tarefas.length === 0) return { doParceiro: false, deOutraOrigem: false };
  const ids = tarefas.map((t) => t._id);
  const doParceiroIds = new Set(
    (await ReservaManual.find({ tarefa_gerada_id: { $in: ids } }).select('tarefa_gerada_id').lean())
      .map((r) => String(r.tarefa_gerada_id))
  );
  return {
    doParceiro: doParceiroIds.size > 0,
    deOutraOrigem: ids.some((id) => !doParceiroIds.has(String(id))),
  };
}

/** Texto do dia duplicado conforme o tipo. */
function textoDuplicada(tipo, dia) {
  return eSaida(tipo)
    ? `com check-out a ${fmtDia(dia)}`
    : `${ROTULOS_TIPO[tipo].toLowerCase()} a ${fmtDia(dia)}`;
}

/** Gestor decide: há outra limpeza (outra origem) no mesmo dia e casa. */
function avisarGestorDuasLimpezas(empresaId, propriedade, inicioDia) {
  return avisarGestores(
    empresaId,
    '⚠️ Duas limpezas no mesmo dia',
    `"${propriedade.nome}" tem agora duas limpezas a ${fmtDia(inicioDia)} (uma de uma reserva de proprietário e outra de outra origem). Vê se é a mesma e elimina uma.`,
    '/gestor/tarefas'
  );
}

/**
 * Gera a Tarefa de Limpeza (com auto-atribuição) para o check-out de uma reserva.
 * Partilhado por criarReserva e atualizarReserva (quando as datas mudam).
 * `detalhesExtra` é fundido em tarefa.detalhes_reserva (nome, hora, preferência…).
 */
async function gerarTarefaLimpezaReserva({
  propriedade, empresaId, check_in, check_out, numHospedes, observacoes, detalhesExtra = {},
  tipoLimpeza = 'normal', diaLimpeza = null,
}) {
  // Normal/profunda: dia do check-out. Intermédia a meio da estadia; preparação no check-in (automático).
  const dataCheckOut = new Date(diaLimpeza || check_out);
  // O tempo do tipo (ou o da casa) é o que chega ao motor, ao limite de 8h e ao scheduler.
  const tempoNovaTarefa = tempoDoTipo(propriedade, tipoLimpeza);

  // Auto-atribuição com o motor partilhado (staff_necessario, scheduler, motivo real).
  const plano = await planearAtribuicao({
    empresaId, propriedade, dia: dataCheckOut, tempoLimpeza: tempoNovaTarefa,
  });
  const utilizadorAtribuido = plano.utilizador_id;
  const equipaIds = plano.equipa_atribuida;
  const dataAgendada = plano.data;
  const tempoViagemFinal = plano.tempo_viagem_minutos;
  const estadoInicial = plano.estado;
  const motivoNaoAtribuicao = plano.motivo_nao_atribuicao;

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
    pessoas_em_falta: plano.faltam,
    observacoes: observacoes ? String(observacoes).trim() : '',
    hospedes: numHospedes, // FIX (fallback estrito) — pax ou capacidade_hospedes
    // FIX (sync parceiros) — Marca a tarefa como originária de uma reserva
    // de parceiro (para destaque visual e filtro "Apenas Parceiros").
    origem_parceiro: true,
    tipo_limpeza: tipoLimpeza,
    checklist: checklistDoTipo(propriedade, tipoLimpeza),
    checklist_do_tipo: temChecklistPropria(propriedade, tipoLimpeza),
    detalhes_reserva: {
      checkin: String(check_in),
      checkout: String(check_out),
      pax: numHospedes,
      ...detalhesExtra,
    },
  });
}

/**
 * A limpeza ficou mais longa (mesmo dia, outro tipo): se a equipa atual continua a caber
 * (dentro do horário do dia, com almoço, viagens e sem sobreposição), mantém pessoas e hora. Se não, liberta a
 * tarefa e deixa o motor escolher de novo com o tempo novo; sem ninguém, fica por atribuir
 * com o motivo real e os gestores são avisados. Grava já os campos de atribuição (updateOne):
 * o `tarefa.save()` seguinte só escreve o resto. Nunca é chamada para `em_curso`/`concluida`
 * (a regra de 409 vem antes: a limpeza em curso fica com a pessoa).
 */
async function replanearSeNaoCabe(tarefa, propriedade, tempoNovo) {
  const membros = idsEquipa(tarefa);
  let cabe = true;
  for (const id of membros) {
    // Janela do dia (09:00-18:00), almoço, viagens e sobreposições (horario.js).
    if (!(await cabeNaAgendaNaHora(id, tarefa.data, tempoNovo, tarefa._id, propriedade.coordenadas, propriedade._id))) {
      cabe = false;
      break;
    }
  }
  if (cabe) return;

  const dataAntes = tarefa.data;
  // Liberta primeiro: o motor não deve contar a carga desta tarefa com a equipa antiga.
  await Tarefa.updateOne(
    { _id: tarefa._id },
    { $set: { utilizador_id: null, equipa_atribuida: [], pessoas_em_falta: 0, estado: 'por_atribuir' } }
  );
  const plano = await planearMotor({
    empresaId: tarefa.empresa_id, propriedade, dia: tarefa.data, tempoLimpeza: tempoNovo,
  });
  if (plano.estado === 'atribuida') {
    await Tarefa.updateOne({ _id: tarefa._id }, { $set: {
      utilizador_id: plano.utilizador_id,
      equipa_atribuida: plano.equipa_atribuida,
      estado: 'atribuida',
      data: plano.data,
      tempo_viagem_minutos: plano.tempo_viagem_minutos,
      motivo_nao_atribuicao: null,
      pessoas_em_falta: plano.faltam,
    } });
    const novos = new Set(plano.equipa_atribuida.map(String));
    avisarEquipaSaiu(membros.filter((m) => !novos.has(String(m))), propriedade, dataAntes, 'foi passada a outra pessoa (a limpeza ficou mais longa).');
    avisarEquipaNova({ utilizador_id: plano.utilizador_id, equipa_atribuida: plano.equipa_atribuida, data: plano.data }, propriedade);
  } else {
    await Tarefa.updateOne({ _id: tarefa._id }, { $set: {
      estado: plano.estado,
      motivo_nao_atribuicao: plano.motivo_nao_atribuicao,
      pessoas_em_falta: 0,
    } });
    avisarEquipaSaiu(membros, propriedade, dataAntes, 'ficou por atribuir (a limpeza ficou mais longa).');
    await avisarGestores(
      tarefa.empresa_id,
      '⚠️ Limpeza por atribuir',
      `"${propriedade.nome}" (${fmtDia(dataAntes)}) passou a ${tempoNovo} min e já não cabe na agenda de ninguém: ${plano.motivo_nao_atribuicao || 'por atribuir'}.`,
      '/gestor/tarefas'
    ).catch(() => {});
  }
}

/** Resposta a um reenvio da mesma reserva (mesma chave): devolve a existente, sem criar nada. */
async function respostaReservaRepetida(res, reserva) {
  const tarefa = reserva.tarefa_gerada_id ? await Tarefa.findById(reserva.tarefa_gerada_id) : null;
  return res.status(200).json({ reserva, tarefa, repetida: true });
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
 *   tipo_limpeza: normal|intermedia|profunda|preparacao (opcional; omissão = normal)
 * O dia da limpeza é automático; `data_limpeza`, se vier, é ignorado.
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
    const tp = normalizarTipo(req.body.tipo_limpeza);
    if (!tp.ok) return res.status(400).json({ erro: 'Tipo de limpeza inválido.' });
    const tipoLimpeza = tp.tipo;
    const rd = resolverDiaLimpeza({
      tipo: tipoLimpeza, check_in, check_out, hoje: new Date().toISOString().slice(0, 10),
    });
    if (rd.erro) return res.status(400).json({ erro: rd.erro });

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

    // Idempotência (1): a mesma chave (o `tmp` da linha) já criou esta reserva?
    // Acontece quando a resposta se perdeu e a pessoa carregou Gravar outra vez.
    const chave = typeof req.body.chave_idempotencia === 'string'
      ? req.body.chave_idempotencia.trim().slice(0, 100) : '';
    if (chave) {
      const jaCriada = await ReservaManual.findOne({ parceiro_id: parceiroId, chave_idempotencia: chave });
      if (jaCriada) return respostaReservaRepetida(res, jaCriada);
    }

    // Idempotência (2), como no Excel: uma limpeza por propriedade e DIA de
    // check-out (não cancelada). Duas saídas no mesmo dia na mesma casa não
    // existem; entradas e saídas no mesmo dia são reservas diferentes (outro
    // dia de check-out) e passam. Casas diferentes no mesmo dia também.
    const inicioDiaSaida = new Date(`${rd.dia}T00:00:00Z`);
    const { doParceiro, deOutraOrigem } = await limpezasDoDia({
      empresaId, propriedadeId: propriedade._id, inicioDia: inicioDiaSaida, tipoLimpeza,
    });
    if (doParceiro) {
      return res.status(409).json({
        erro: `Já existe uma limpeza para "${propriedade.nome}" ${textoDuplicada(tipoLimpeza, inicioDiaSaida)}. Se é a mesma reserva, já está registada: tira esta linha das alterações por gravar.`,
        codigo: 'RESERVA_DUPLICADA',
      });
    }

    // FIX (fallback hospedes estrito) — Se hospedes for null, 0 ou undefined,
    // usa a capacidade_hospedes da propriedade (lotação máxima da casa).
    // Antes só cobria null; agora cobre também 0 (falsy mas != null).
    let numHospedes = hospedes != null && hospedes !== '' ? Number(hospedes) : null;
    if (numHospedes !== null && (Number.isNaN(numHospedes) || numHospedes < 0)) {
      return res.status(400).json({ erro: 'Número de hóspedes inválido.' });
    }
    if (numHospedes === null || numHospedes === 0 || Number.isNaN(numHospedes)) {
      numHospedes = propriedade.capacidade_hospedes ?? null;
    }

    // Cria a reserva. O índice único (parceiro + chave) é o "lock": dois pedidos
    // simultâneos com a mesma chave só deixam passar um.
    let novaReserva;
    try {
      novaReserva = await ReservaManual.create({
        propriedade_id: propriedade._id,
        parceiro_id: parceiroId,
        empresa_id: empresaId,
        check_in: new Date(check_in),
        check_out: new Date(check_out),
        hospedes: numHospedes,
        observacoes: observacoes ? String(observacoes).trim() : '',
        ...(chave ? { chave_idempotencia: chave } : {}),
        tipo_limpeza: tipoLimpeza,
        data_limpeza: rd.dataLimpeza,
        ...extras,
      });
    } catch (e) {
      if (e && e.code === 11000 && chave) {
        const outra = await ReservaManual.findOne({ parceiro_id: parceiroId, chave_idempotencia: chave });
        if (outra) return respostaReservaRepetida(res, outra);
      }
      throw e;
    }

    const detalhesTarefa = detalhesDaReserva(extras);
    let novaTarefa;
    try {
      novaTarefa = await gerarTarefaLimpezaReserva({
        propriedade,
        empresaId,
        check_in,
        check_out,
        numHospedes,
        observacoes,
        detalhesExtra: detalhesTarefa,
        tipoLimpeza,
        diaLimpeza: rd.dia,
      });
    } catch (e) {
      // Sem limpeza não deve ficar reserva órfã: assim o Gravar seguinte volta a tentar.
      await ReservaManual.deleteOne({ _id: novaReserva._id }).catch(() => {});
      throw e;
    }

    // Associa a tarefa à reserva.
    novaReserva.tarefa_gerada_id = novaTarefa._id;
    await novaReserva.save();

    // Avisa a equipa atribuída (uma notificação por pessoa e gravação).
    avisarEquipaNova(novaTarefa, propriedade);
    if (deOutraOrigem) await avisarGestorDuasLimpezas(empresaId, propriedade, inicioDiaSaida);

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
      .populate('tarefa_gerada_id', 'estado data tipo_limpeza tempo_limpeza_minutos hora_conclusao concluida_em')
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
    // Reservas antigas: os limites só se verificam se as datas mudarem (editar notas não bloqueia).
    const mesmoDia = (a, b) => new Date(a).getTime() === new Date(b).getTime();
    const datasMudaram = (body.check_in !== undefined && !mesmoDia(body.check_in, reserva.check_in))
      || (body.check_out !== undefined && !mesmoDia(body.check_out, reserva.check_out));
    const erroDatas = validarDatas(novoCheckIn, novoCheckOut, { limites: datasMudaram });
    if (erroDatas) return res.status(400).json({ erro: erroDatas });

    const dia = (d) => new Date(d).toISOString().slice(0, 10);

    // Tipo e dia da limpeza (normal/profunda: check-out; intermédia a meio da estadia; preparação no check-in: automático).
    const tp = body.tipo_limpeza !== undefined ? normalizarTipo(body.tipo_limpeza) : { ok: true, tipo: tipoDe(reserva) };
    if (!tp.ok) return res.status(400).json({ erro: 'Tipo de limpeza inválido.' });
    const tipoNovo = tp.tipo;
    // O «não pode ser no passado» só se aplica quando o tipo, a data da limpeza ou o check-in mudam.
    const reverPassado = tipoNovo !== tipoDe(reserva) || body.check_in !== undefined;
    // A data é automática: o que vier em data_limpeza é ignorado. A já gravada só continua a valer
    // se o tipo e a estadia não mudaram (reservas antigas e datas ajustadas pelo gestor).
    const estadiaIgual = tipoNovo === tipoDe(reserva) && dia(novoCheckIn) === dia(reserva.check_in) && dia(novoCheckOut) === dia(reserva.check_out);
    const rd = resolverDiaLimpeza({
      tipo: tipoNovo, check_in: novoCheckIn, check_out: novoCheckOut,
      data_gravada: estadiaIgual ? reserva.data_limpeza : null,
      ajustada: estadiaIgual && !!reserva.data_limpeza_ajustada,
      hoje: reverPassado ? new Date().toISOString().slice(0, 10) : undefined,
    });
    if (rd.erro) return res.status(400).json({ erro: rd.erro });
    const tipoAntes = tipoDe(reserva);
    const rdAntes = resolverDiaLimpeza({
      tipo: tipoAntes, check_in: reserva.check_in, check_out: reserva.check_out, data_gravada: reserva.data_limpeza, ajustada: !!reserva.data_limpeza_ajustada,
    });
    const diaAntes = rdAntes.erro ? dia(reserva.check_out) : rdAntes.dia;
    const tipoMudou = tipoNovo !== tipoAntes;
    // O dia da limpeza mudou: a limpeza antiga é cancelada e gera-se outra (como sempre).
    const checkOutMudou = rd.dia !== diaAntes;

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

    // Mudar o check-out para um dia que já tem outra limpeza do parceiro na mesma casa:
    // recusa (a antiga fica intacta). A própria tarefa fica de fora.
    let deOutraOrigem = false;
    let inicioNovoDia = null;
    // (também quando só muda o tipo: pode passar para uma classe/tipo que já existe nesse dia)
    if (tarefa && (checkOutMudou || tipoMudou)) {
      inicioNovoDia = new Date(`${rd.dia}T00:00:00Z`);
      const r = await limpezasDoDia({
        empresaId: reserva.empresa_id, propriedadeId: reserva.propriedade_id,
        inicioDia: inicioNovoDia, tipoLimpeza: tipoNovo, excluirTarefaId: tarefa._id,
      });
      if (r.doParceiro) {
        const p = await Propriedade.findById(reserva.propriedade_id).select('nome').lean();
        return res.status(409).json({
          erro: `Já existe outra limpeza para "${p?.nome || 'esta casa'}" ${textoDuplicada(tipoNovo, inicioNovoDia)}. Escolhe outro dia ou elimina a outra reserva primeiro.`,
          codigo: 'RESERVA_DUPLICADA',
        });
      }
      deOutraOrigem = r.deOutraOrigem;
    }

    reserva.check_in = new Date(novoCheckIn);
    reserva.check_out = new Date(novoCheckOut);
    reserva.hospedes = numHospedes;
    if (body.observacoes !== undefined) reserva.observacoes = String(body.observacoes ?? '').trim();
    Object.assign(reserva, extras);
    reserva.tipo_limpeza = tipoNovo;
    const perdeuAjuste = !!reserva.data_limpeza_ajustada && !rd.ajustada;
    reserva.data_limpeza = rd.dataLimpeza;
    reserva.data_limpeza_ajustada = !!rd.ajustada;

    const detalhesExtra = detalhesDaReserva(extras);
    if (tarefa && checkOutMudou) {
      const propriedade = await Propriedade.findById(reserva.propriedade_id).lean();
      // Quem estava na limpeza antiga (para avisar que saiu).
      const equipaAntes = idsEquipa(tarefa);
      const dataAntiga = tarefa.data;
      // Primeiro gera a nova (se falhar, a antiga fica intacta); só depois cancela a antiga.
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
        tipoLimpeza: tipoNovo,
        diaLimpeza: rd.dia,
      });
      tarefa.estado = 'cancelada';
      tarefa.utilizador_id = null;
      tarefa.equipa_atribuida = [];
      tarefa.pessoas_em_falta = 0;
      await tarefa.save();
      reserva.tarefa_gerada_id = nova._id;

      // Toda a equipa da limpeza antiga é avisada de que essa data foi cancelada
      // (mesmo quem volta a ser escalado na nova) e a da nova é avisada da nova.
      avisarEquipaSaiu(equipaAntes, propriedade, dataAntiga, 'foi cancelada (a reserva mudou de datas).');
      avisarEquipaNova(nova, propriedade);
      if (deOutraOrigem) await avisarGestorDuasLimpezas(reserva.empresa_id, propriedade, inicioNovoDia);
    } else if (tarefa) {
      if (tipoMudou) {
        // Mesmo dia, outro tipo: atualiza tipo, tempo e checklist da mesma tarefa (mantém equipa
        // e estado). A checklist só se troca se ainda não houve trabalho nela.
        const propriedade = await Propriedade.findById(reserva.propriedade_id).lean();
        const tempoAntes = Number(tarefa.tempo_limpeza_minutos) || 45;
        const tempoNovo = tempoDoTipo(propriedade, tipoNovo);
        tarefa.tipo_limpeza = tipoNovo;
        tarefa.tempo_limpeza_minutos = tempoNovo;
        if (!temProgresso(tarefa)) {
          tarefa.checklist = checklistDoTipo(propriedade, tipoNovo);
          tarefa.checklist_do_tipo = temChecklistPropria(propriedade, tipoNovo);
        }
        // Limpeza mais longa: se já não cabe (8h ou sobreposição), o motor replaneia.
        if (tempoNovo > tempoAntes && tarefa.estado === 'atribuida' && idsEquipa(tarefa).length > 0) {
          await replanearSeNaoCabe(tarefa, propriedade, tempoNovo);
        }
      }
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
    if (perdeuAjuste) {
      try {
        const pAj = await Propriedade.findById(reserva.propriedade_id).select('nome').lean();
        await avisarGestores(reserva.empresa_id, 'Dia da limpeza recalculado',
          `O proprietário mudou as datas ou o tipo da reserva de ${pAj ? pAj.nome : 'uma casa'}: o dia da limpeza que tinhas ajustado foi recalculado (${new Date(`${rd.dia}T00:00:00Z`).toISOString().slice(0, 10)}).`, '/gestor/tarefas');
      } catch (e) { console.error('⚠️  aviso de dia recalculado:', e.message); }
    }

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
      const equipaAntes = idsEquipa(tarefa);
      const dataAntiga = tarefa.data;
      tarefa.estado = 'cancelada';
      tarefa.utilizador_id = null;
      tarefa.equipa_atribuida = [];
      tarefa.pessoas_em_falta = 0;
      await tarefa.save();
      const prop = await Propriedade.findById(reserva.propriedade_id).select('nome').lean();
      if (prop) avisarEquipaSaiu(equipaAntes, prop, dataAntiga, 'foi cancelada (reserva eliminada).');
    }
    await reserva.deleteOne();
    return res.status(200).json({ mensagem: 'Reserva eliminada.' });
  } catch (err) {
    console.error('❌ parceiroController.eliminarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

module.exports = {
  limpezasDoDia,
  textoDuplicada,
  validarDatas,
  criarPropriedade,
  listarPropriedades,
  criarTarefa,
  listarTarefas,
  criarReserva,
  listarReservas,
  atualizarReserva,
  eliminarReserva,
};
