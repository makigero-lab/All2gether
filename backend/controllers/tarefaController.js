/**
 * Tarefa Controller — Autocell
 *
 * Gestão de tarefas individuais (reportar atraso, etc.)
 */

const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const { obterEmpresaId } = require('./adminController');

const CAPACIDADE_MAXIMA_MINUTOS = 420;

/**
 * POST /api/admin/tarefas/:id/atraso
 *
 * Reporta um atraso numa tarefa. Soma minutos_atraso ao tempo_limpeza_minutos.
 * Se a nova carga total do utilizador no dia ultrapassar a CAPACIDADE_MAXIMA_MINUTOS,
 * a ÚLTIMA tarefa do dia desse utilizador é desatribuída (null + por_atribuir)
 * para não comprometer as limpezas seguintes.
 *
 * Body: { minutos_atraso: number }
 *
 * Resposta 200: { tarefa, carga_total, cascata_desatribuida: boolean, tarefa_desatribuida_id: string|null }
 */
exports.reportarAtrasoTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const { minutos_atraso } = req.body || {};
    const minutos = Number(minutos_atraso);
    if (!Number.isFinite(minutos) || minutos <= 0) {
      return res.status(400).json({
        erro: 'minutos_atraso deve ser um número positivo.',
      });
    }

    // Procura a tarefa (valida pertença à empresa).
    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId });
    if (!tarefa) {
      return res.status(404).json({
        erro: 'Tarefa não encontrada (ou não pertence a esta empresa).',
      });
    }

    // Soma o atraso ao tempo de limpeza.
    tarefa.tempo_limpeza_minutos += minutos;
    await tarefa.save();

    // Se a tarefa tem utilizador atribuído, verifica a carga total do dia.
    let cascataDesatribuida = false;
    let tarefaDesatribuidaId = null;
    let cargaTotal = 0;

    if (tarefa.utilizador_id) {
      const utilizadorId = tarefa.utilizador_id;

      // Calcula o intervalo do dia da tarefa (UTC meia-noite).
      const d = new Date(tarefa.data);
      const inicioDia = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      );
      const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

      // Soma o tempo_limpeza_minutos de todas as tarefas do utilizador no dia.
      const tarefasDoDia = await Tarefa.find({
        utilizador_id: utilizadorId,
        data: { $gte: inicioDia, $lt: fimDia },
        estado: { $nin: ['cancelada', 'concluida'] },
      }).lean();

      cargaTotal = tarefasDoDia.reduce(
        (acc, t) => acc + t.tempo_limpeza_minutos,
        0
      );

      // Se exceder a capacidade máxima, desatribui a última tarefa do dia.
      if (cargaTotal > CAPACIDADE_MAXIMA_MINUTOS) {
        // Encontra a última tarefa atribuída (excluindo a atual, que já foi atualizada).
        const ultimaTarefa = await Tarefa.findOne({
          utilizador_id: utilizadorId,
          data: { $gte: inicioDia, $lt: fimDia },
          estado: { $nin: ['cancelada', 'concluida'] },
          _id: { $ne: tarefa._id },
        }).sort({ createdAt: -1 });

        if (ultimaTarefa) {
          ultimaTarefa.utilizador_id = null;
          ultimaTarefa.estado = 'por_atribuir';
          await ultimaTarefa.save();
          cascataDesatribuida = true;
          tarefaDesatribuidaId = String(ultimaTarefa._id);
        }
      }
    }

    const tarefaResp = tarefa.toObject();
    delete tarefaResp.__v;

    return res.status(200).json({
      tarefa: tarefaResp,
      carga_total: cargaTotal,
      cascata_desatribuida: cascataDesatribuida,
      tarefa_desatribuida_id: tarefaDesatribuidaId,
    });
  } catch (err) {
    console.error('❌ reportarAtrasoTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Criação manual de tarefas                                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/tarefas
 *
 * Cria uma tarefa manualmente (sem depender do Smoobu).
 *
 * Body: { propriedade_id, utilizador_id?, data, tempo_limpeza_minutos?, tipo? }
 *
 * Se utilizador_id vier, atribui diretamente. Se não vier, a tarefa fica
 * 'por_atribuir' e o admin pode atribuir depois via PATCH /:id/atribuir.
 *
 * Resposta 201: { tarefa: { ... } }
 */
exports.criarTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { propriedade_id, utilizador_id, data, tempo_limpeza_minutos, tipo } = req.body || {};

    if (!propriedade_id || !data) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: propriedade_id e data.',
      });
    }
    if (!mongoose.isValidObjectId(propriedade_id)) {
      return res.status(400).json({ erro: 'propriedade_id inválido.' });
    }

    // Valida que a propriedade pertence à empresa e está ativa.
    const propriedade = await Propriedade.findOne({
      _id: propriedade_id,
      empresa_id: empresaId,
    });
    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a esta empresa).',
      });
    }

    // Valida utilizador_id se vier.
    let utilizadorValidado = null;
    if (utilizador_id) {
      if (!mongoose.isValidObjectId(utilizador_id)) {
        return res.status(400).json({ erro: 'utilizador_id inválido.' });
      }
      const user = await Utilizador.findOne({
        _id: utilizador_id,
        empresa_id: empresaId,
        role: { $in: ['staff', 'gestor'] },
        ativo: true,
        eliminado_em: null,
      });
      if (!user) {
        return res.status(400).json({
          erro: 'Utilizador não encontrado (ou não é staff/gestor ativo da empresa).',
        });
      }
      utilizadorValidado = user._id;
    }

    // Normaliza data para meia-noite UTC.
    const d = new Date(data);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ erro: 'data inválida.' });
    }
    const dataNormalizada = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );

    const nova = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id,
      utilizador_id: utilizadorValidado,
      data: dataNormalizada,
      tempo_limpeza_minutos: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
      tipo: tipo || 'limpeza',
      estado: utilizadorValidado ? 'atribuida' : 'por_atribuir',
    });

    return res.status(201).json({ tarefa: nova });
  } catch (err) {
    console.error('❌ criarTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/admin/tarefas/:id/atribuir
 *
 * Atribui (ou reatribui) uma tarefa a um utilizador.
 * Usado para atribuir tarefas órfãs (por_atribuir) manualmente.
 *
 * Body: { utilizador_id }
 * Se utilizador_id for null, remove a atribuição (volta a por_atribuir).
 *
 * Resposta 200: { tarefa: { ... } }
 */
exports.atribuirTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId });
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    const { utilizador_id } = req.body || {};

    if (!utilizador_id) {
      // Remove atribuição.
      tarefa.utilizador_id = null;
      tarefa.estado = 'por_atribuir';
    } else {
      if (!mongoose.isValidObjectId(utilizador_id)) {
        return res.status(400).json({ erro: 'utilizador_id inválido.' });
      }
      const user = await Utilizador.findOne({
        _id: utilizador_id,
        empresa_id: empresaId,
        role: { $in: ['staff', 'gestor'] },
        ativo: true,
        eliminado_em: null,
      });
      if (!user) {
        return res.status(400).json({
          erro: 'Utilizador não encontrado (ou não é staff/gestor ativo).',
        });
      }
      tarefa.utilizador_id = user._id;
      tarefa.estado = 'atribuida';
    }

    await tarefa.save();
    return res.status(200).json({ tarefa });
  } catch (err) {
    console.error('❌ atribuirTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/admin/tarefas/:id/estado
 *
 * Atualiza o estado de uma tarefa manualmente.
 *
 * Body: { estado: 'atribuida' | 'em_curso' | 'concluida' | 'cancelada' }
 *
 * Resposta 200: { tarefa: { ... } }
 */
exports.atualizarEstadoTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const { estado } = req.body || {};
    const estadosValidos = ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada'];
    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ erro: 'Estado inválido.' });
    }

    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId });
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    tarefa.estado = estado;
    if (estado === 'concluida') tarefa.concluida_em = new Date();
    await tarefa.save();

    return res.status(200).json({ tarefa });
  } catch (err) {
    console.error('❌ atualizarEstadoTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
