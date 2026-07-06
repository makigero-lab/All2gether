/**
 * Tarefa Controller — Autocell
 *
 * Gestão de tarefas individuais (reportar atraso, etc.)
 */

const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const { obterEmpresaId } = require('./gestorController');
const { notificarUtilizador } = require('../utils/notificar');
const {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularCargaDiaUtilizador,
  calcularInicioTarefaUtilizador,
} = require('../utils/scheduler');

/**
 * Limite de capacidade usado pelo reportarAtrasoTarefa para desatribuir a
 * última tarefa do dia em caso de overflow. Mantido em 420 min (7h) por
 * razões históricas — é mais conservador que o SLA do load balancer (480).
 */
const CAPACIDADE_ATRASO_MINUTOS = 420;

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
      if (cargaTotal > CAPACIDADE_ATRASO_MINUTOS) {
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

    // Notifica o NOVO utilizador atribuído (fire-and-forget).
    // Só envia se foi uma (re)atribuição real — não no caso de remover atribuição.
    if (utilizador_id) {
      try {
        const propriedade = await Propriedade.findById(
          tarefa.propriedade_id
        )
          .select('nome')
          .lean();
        const dataFmt = new Date(tarefa.data).toLocaleDateString('pt-PT', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });
        notificarUtilizador(
          String(tarefa.utilizador_id),
          '🔄 Tarefa reatribuída',
          `${propriedade?.nome ?? 'Propriedade'} — ${dataFmt}`,
          '/staff'
        );
      } catch (e) {
        // Fire-and-forget: não bloqueia a resposta.
        console.error('⚠️  notificar reatribuição:', e.message);
      }
    }

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

/* ------------------------------------------------------------------ */
/* PATCH /api/gestor/tarefas/:id/reatribuir — Reatribuição Inteligente  */
/* (v1.53.0 — Prompt 75)                                                */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/gestor/tarefas/:id/reatribuir
 *
 * Reatribui uma tarefa a um utilizador, recalculando a hora de início com
 * o scheduler sequencial (Haversine + proteção de almoço 13h-14h), exatamente
 * como na criação via webhook.
 *
 * Fluxo:
 *   1. Carrega a tarefa (valida pertença à empresa).
 *   2. Valida o novo utilizador (staff/gestor ativo da empresa).
 *   3. Verifica folga fixa semanal do novo utilizador nesse dia.
 *   4. Calcula a carga atual do novo utilizador no dia (excluindo esta
 *      tarefa) + tempo_limpeza desta. Se > CAPACIDADE_MAXIMA_MINUTOS (480),
 *      rejeita com 409 Conflict.
 *   5. Carrega a propriedade para obter coordenadas.
 *   6. Temporariamente desatribui a tarefa (utilizador_id = null) para que
 *      o scheduler não a considere como "última tarefa" do utilizador.
 *   7. Calcula o novo início via calcularInicioTarefaUtilizador.
 *   8. Guarda a tarefa com o novo utilizador + nova data + estado 'atribuida'.
 *   9. Notifica o novo utilizador (push, fire-and-forget).
 *
 * Body: { utilizador_id: string }
 *
 * Resposta 200: { tarefa, novo_inicio: string (ISO), origem: string, tempo_viagem: number }
 * Resposta 409: { erro, codigo: 'CAPACIDADE_EXCEDIDA', carga_total, limite }
 * Resposta 400: { erro, codigo: 'FOLGA_FIXA' }
 */
exports.reatribuirTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }

    const { utilizador_id } = req.body || {};
    if (!utilizador_id || !mongoose.isValidObjectId(utilizador_id)) {
      return res.status(400).json({ erro: 'utilizador_id inválido.' });
    }

    // 1. Carrega a tarefa.
    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId });
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }

    // Não permite reatribuir tarefas concluídas/canceladas (faz pouco sentido).
    if (tarefa.estado === 'concluida' || tarefa.estado === 'cancelada') {
      return res.status(400).json({
        erro: `Não é possível reatribuir uma tarefa ${tarefa.estado}.`,
      });
    }

    // 2. Valida o novo utilizador.
    const novoUser = await Utilizador.findOne({
      _id: utilizador_id,
      empresa_id: empresaId,
      role: { $in: ['staff', 'gestor'] },
      ativo: true,
      eliminado_em: null,
    }).lean();
    if (!novoUser) {
      return res.status(400).json({
        erro: 'Utilizador não encontrado (ou não é staff/gestor ativo).',
      });
    }

    // 3. Verifica folga fixa semanal do novo utilizador nesse dia.
    const diaSemana = new Date(tarefa.data).getDay(); // 0=Dom, 6=Sáb
    if (
      Array.isArray(novoUser.dias_folga) &&
      novoUser.dias_folga.includes(diaSemana)
    ) {
      return res.status(400).json({
        erro: `${novoUser.nome} tem folga fixa neste dia da semana.`,
        codigo: 'FOLGA_FIXA',
      });
    }

    // 4. Verifica capacidade do novo utilizador no dia.
    const cargaAtual = await calcularCargaDiaUtilizador(
      utilizador_id,
      tarefa.data,
      tarefa._id
    );
    const novaCarga = cargaAtual + (tarefa.tempo_limpeza_minutos || 45);
    if (novaCarga > CAPACIDADE_MAXIMA_MINUTOS) {
      return res.status(409).json({
        erro: `Capacidade excedida para ${novoUser.nome} neste dia ` +
          `(${novaCarga} min > ${CAPACIDADE_MAXIMA_MINUTOS} min).`,
        codigo: 'CAPACIDADE_EXCEDIDA',
        carga_total: novaCarga,
        limite: CAPACIDADE_MAXIMA_MINUTOS,
      });
    }

    // 5. Carrega a propriedade para obter coordenadas.
    const propriedade = await Propriedade.findById(tarefa.propriedade_id)
      .select('coordenadas nome')
      .lean();
    if (!propriedade) {
      return res.status(404).json({ erro: 'Propriedade não encontrada.' });
    }

    // 6. Temporariamente desatribui a tarefa para o scheduler não a contar.
    tarefa.utilizador_id = null;
    await tarefa.save();

    // 7. Calcula o novo início (scheduler sequencial + almoço).
    const resultadoScheduler = await calcularInicioTarefaUtilizador(
      utilizador_id,
      tarefa.data,
      propriedade.coordenadas,
      tarefa.tempo_limpeza_minutos || 45
    );

    // 8. Guarda a tarefa com o novo utilizador + nova data.
    tarefa.utilizador_id = novoUser._id;
    tarefa.data = resultadoScheduler.data;
    tarefa.estado = 'atribuida';
    await tarefa.save();

    console.log(
      `🔄 reatribuirTarefa: tarefa ${tarefa._id} → utilizador ${novoUser.nome} ` +
        `(novo início: ${resultadoScheduler.data.toISOString()}, ` +
        `origem: ${resultadoScheduler.origem}, viagem: ${resultadoScheduler.tempoViagem}min)`
    );

    // 9. Notifica o novo utilizador (fire-and-forget).
    try {
      const dataFmt = new Date(tarefa.data).toLocaleDateString('pt-PT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      notificarUtilizador(
        String(novoUser._id),
        '🔄 Tarefa reatribuída',
        `${propriedade.nome ?? 'Propriedade'} — ${dataFmt}`,
        '/staff'
      );
    } catch (e) {
      console.error('⚠️  notificar reatribuição:', e.message);
    }

    const tarefaResp = tarefa.toObject();
    delete tarefaResp.__v;

    return res.status(200).json({
      tarefa: tarefaResp,
      novo_inicio: resultadoScheduler.data.toISOString(),
      origem: resultadoScheduler.origem,
      tempo_viagem: resultadoScheduler.tempoViagem,
    });
  } catch (err) {
    console.error('❌ reatribuirTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* DELETE /api/gestor/tarefas/futuras — apagar tarefas futuras (v1.50) */
/* ------------------------------------------------------------------ */

/**
 * Apaga todas as tarefas NÃO concluídas de hoje para a frente.
 * Útil para forçar o reprocessamento do load balancer — o gestor apaga
 * as tarefas futuras e depois clica em "Sincronizar Reservas" para
 * recriá-las com o scheduler sequencial (horas reais).
 *
 * Regras:
 *   - Só apaga tarefas da empresa do gestor (empresa_id do JWT).
 *   - Só apaga tarefas com data >= início de hoje (UTC).
 *   - NÃO apaga tarefas concluídas (preserva histórico).
 *   - NÃO apaga tarefas canceladas (já não contam para carga).
 *
 * Resposta 200: { mensagem, apagadas }
 */
exports.apagarTarefasFuturas = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    const resultado = await Tarefa.deleteMany({
      empresa_id: empresaId,
      data: { $gte: hojeInicio },
      estado: { $nin: ['concluida', 'cancelada'] },
    });

    console.log(
      `🧹 apagarTarefasFuturas: ${resultado.deletedCount} tarefa(s) apagada(s) ` +
        `(empresa ${empresaId}, desde ${hojeInicio.toISOString()}).`
    );

    return res.status(200).json({
      mensagem: `${resultado.deletedCount} tarefa(s) futura(s) apagada(s) com sucesso.`,
      apagadas: resultado.deletedCount,
    });
  } catch (err) {
    console.error('❌ apagarTarefasFuturas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
