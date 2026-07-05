/**
 * Relatório Controller — Autocell
 *
 * Endpoints de analytics / relatórios de produtividade.
 *
 * Autenticação: obrigatória (middleware `auth` aplicado nas rotas).
 * O `empresa_id` é lido do JWT (req.user.empresa_id).
 */

const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const { obterEmpresaId } = require('./gestorController');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normaliza um parâmetro de data (string ISO ou yyyy-mm-dd) para meia-noite
 * UTC. Devolve null se inválido.
 */
function normalizarDataUTC(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

/**
 * Arredonda para 1 casa decimal (percentagens).
 */
function round1(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* GET /api/admin/relatorios/produtividade                             */
/* ------------------------------------------------------------------ */

/**
 * Relatório de produtividade da empresa num intervalo de datas.
 *
 * Query params:
 *   - inicio (yyyy-mm-dd | ISO) — início do período. Default: há 30 dias.
 *   - fim    (yyyy-mm-dd | ISO) — fim do período (inclusive). Default: hoje.
 *
 * Resposta 200:
 *   {
 *     periodo: { inicio, fim },
 *     resumo: {
 *       totalTarefas,           // exclui canceladas
 *       concluidas,
 *       taxaConclusao,          // 0..1
 *       emAtraso,               // tarefas não concluídas cuja data já passou
 *       taxaAtraso,             // 0..1 (emAtraso / total)
 *       cargaTotalMinutos,      // soma de tempo_limpeza_minutos (exclui canceladas)
 *       tempoMedioMinutos,      // média de tempo estimado das concluídas (= tempoEstimadoMedioMinutos)
 *       tempoEstimadoMedioMinutos, // alias de tempoMedioMinutos
 *       tempoRealMedioMinutos   // média de (hora_conclusao - data) das concluídas, em minutos
 *     },
 *     porStaff: [{ utilizador_id, nome, total, concluidas, carga_minutos, taxaConclusao }],
 *     porDia:   [{ data, total, concluidas, carga_minutos }],
 *     porEstado:[{ estado, total }],
 *     porPropriedade: [{ propriedade_id, nome, total, carga_minutos }]
 *   }
 */
exports.getRelatorioProdutividade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // Período — default: últimos 30 dias.
    const agora = new Date();
    const hojeFim = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()) +
        24 * 60 * 60 * 1000
    ); // amanhã 00:00 UTC (exclusive)
    const fim = normalizarDataUTC(req.query.fim) || hojeFim;
    const inicio =
      normalizarDataUTC(req.query.inicio) ||
      new Date(fim.getTime() - 30 * 24 * 60 * 60 * 1000);

    // O intervalo é [inicio, fim[ (fim exclusive — já é meia-noite do dia
    // seguinte se vier de normalizarDataUTC; se for hojeFim também).
    const matchBase = {
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      data: { $gte: inicio, $lt: fim },
    };

    /* ---- Resumo (contagens + somas em paralelo) ---- */
    const [
      totalTarefas,
      concluidas,
      emAtraso,
      cargaTotal,
      tempoMedioAgg,
      porEstadoAgg,
      tempoRealAgg,
    ] = await Promise.all([
      // Total (exclui canceladas).
      Tarefa.countDocuments({ ...matchBase, estado: { $ne: 'cancelada' } }),
      // Concluídas.
      Tarefa.countDocuments({ ...matchBase, estado: 'concluida' }),
      // Em atraso: não concluídas nem canceladas cuja data já passou.
      Tarefa.countDocuments({
        ...matchBase,
        estado: { $nin: ['concluida', 'cancelada'] },
        data: { $gte: inicio, $lt: new Date() },
      }),
      // Carga total (minutos) — exclui canceladas.
      Tarefa.aggregate([
        { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
        { $group: { _id: null, total: { $sum: '$tempo_limpeza_minutos' } } },
      ]),
      // Tempo médio estimado das concluídas.
      Tarefa.aggregate([
        { $match: { ...matchBase, estado: 'concluida' } },
        { $group: { _id: null, media: { $avg: '$tempo_limpeza_minutos' } } },
      ]),
      // Distribuição por estado.
      Tarefa.aggregate([
        { $match: matchBase },
        { $group: { _id: '$estado', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      // Tempo real médio: média da diferença entre hora_conclusao e data
      // (em minutos) das tarefas concluídas com hora_conclusao definida.
      Tarefa.aggregate([
        {
          $match: {
            ...matchBase,
            estado: 'concluida',
            hora_conclusao: { $ne: null, $type: 'date' },
          },
        },
        {
          $group: {
            _id: null,
            media: {
              $avg: {
                $divide: [
                  { $subtract: ['$hora_conclusao', '$data'] },
                  60 * 1000, // ms → minutos
                ],
              },
            },
          },
        },
      ]),
    ]);

    const cargaTotalMinutos = cargaTotal[0]?.total || 0;
    const tempoMedioMinutos = tempoMedioAgg[0]?.media
      ? Math.round(tempoMedioAgg[0].media)
      : 0;
    // Tempo real médio em minutos — arredondado. Se não houver tarefas
    // concluídas com hora_conclusao, devolve 0.
    const tempoRealMedioMinutos = tempoRealAgg[0]?.media
      ? Math.round(tempoRealAgg[0].media)
      : 0;

    /* ---- Por staff (produtividade individual) ---- */
    const porStaffAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: '$utilizador_id',
          total: { $sum: 1 },
          concluidas: {
            $sum: { $cond: [{ $eq: ['$estado', 'concluida'] }, 1, 0] },
          },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { total: -1 } },
    ]);

    // Popula nomes (inclui tarefas por atribuir — utilizador_id null → "Por atribuir").
    const staffIds = porStaffAgg
      .filter((s) => s._id)
      .map((s) => s._id);
    const staffInfo = await Utilizador.find({ _id: { $in: staffIds } })
      .select('nome')
      .lean();
    const staffMap = new Map(staffInfo.map((s) => [String(s._id), s.nome]));

    const porStaff = porStaffAgg.map((s) => ({
      utilizador_id: s._id ? String(s._id) : null,
      nome: s._id ? staffMap.get(String(s._id)) ?? 'Desconhecido' : 'Por atribuir',
      total: s.total,
      concluidas: s.concluidas,
      carga_minutos: s.carga_minutos,
      taxaConclusao: s.total > 0 ? round1(s.concluidas / s.total) : 0,
    }));

    /* ---- Por dia (série temporal) ---- */
    const porDiaAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$data' },
          },
          total: { $sum: 1 },
          concluidas: {
            $sum: { $cond: [{ $eq: ['$estado', 'concluida'] }, 1, 0] },
          },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const porDia = porDiaAgg.map((d) => ({
      data: d._id,
      total: d.total,
      concluidas: d.concluidas,
      carga_minutos: d.carga_minutos,
    }));

    /* ---- Por propriedade ---- */
    const porPropriedadeAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: '$propriedade_id',
          total: { $sum: 1 },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const propIds = porPropriedadeAgg.map((p) => p._id);
    const propInfo = await Propriedade.find({ _id: { $in: propIds } })
      .select('nome')
      .lean();
    const propMap = new Map(propInfo.map((p) => [String(p._id), p.nome]));

    const porPropriedade = porPropriedadeAgg.map((p) => ({
      propriedade_id: String(p._id),
      nome: propMap.get(String(p._id)) ?? 'Desconhecida',
      total: p.total,
      carga_minutos: p.carga_minutos,
    }));

    /* ---- Resposta final ---- */
    const porEstado = porEstadoAgg.map((e) => ({ estado: e._id, total: e.total }));

    return res.status(200).json({
      periodo: { inicio: inicio.toISOString(), fim: fim.toISOString() },
      resumo: {
        totalTarefas,
        concluidas,
        taxaConclusao: totalTarefas > 0 ? round1(concluidas / totalTarefas) : 0,
        emAtraso,
        taxaAtraso: totalTarefas > 0 ? round1(emAtraso / totalTarefas) : 0,
        cargaTotalMinutos,
        tempoMedioMinutos,
        tempoEstimadoMedioMinutos: tempoMedioMinutos,
        tempoRealMedioMinutos,
      },
      porStaff,
      porDia,
      porEstado,
      porPropriedade,
    });
  } catch (err) {
    console.error('❌ getRelatorioProdutividade:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
