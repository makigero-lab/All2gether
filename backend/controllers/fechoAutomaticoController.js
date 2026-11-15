/**
 * Limpezas fechadas automaticamente — lista do gestor (All2gether)
 *
 *   GET /api/gestor/limpezas/fechadas-automaticamente?dias=7
 *
 * O job das 20:00 (jobs/fechoAutomatico.js) fecha as limpezas 'em_curso' que ninguém fechou. Esta lista
 * deixa o gestor ver quais foram, quem lá estava e se a pessoa acrescentou algo depois (fotos, notas,
 * avarias ou a confirmação). Só da empresa do gestor; por omissão últimos 7 dias, no máximo 30.
 */
const Tarefa = require('../models/Tarefa');
const { obterEmpresaId } = require('./gestorController');
const { membrosPopulados } = require('../utils/equipaTarefa');
const { moradaParaApi } = require('../utils/calendarioExterno/moradaCurta');
const H = require('../utils/horario');
const { JANELA_RECUPERACAO_DIAS } = require('../jobs/fechoAutomatico');

const DIAS_POR_OMISSAO = 7;
const DIAS_MAXIMO = 30;

function lerDias(valor) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n) || n < 1) return DIAS_POR_OMISSAO;
  return Math.min(n, DIAS_MAXIMO);
}

exports.listarFechadasAutomaticamente = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;
    const dias = lerDias(req.query.dias);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      tipo: 'limpeza',
      estado: 'concluida',
      fechada_automaticamente_em: { $gte: desde },
      // Só as que continuam a ser fecho do sistema (ou confirmadas depois). Reaberta e concluída de verdade sai da lista.
      $or: [{ conclusao_origem: 'automatica' }, { confirmada_depois_em: { $ne: null } }],
    })
      .select('data tipo tipo_limpeza tempo_limpeza_minutos propriedade_id utilizador_id equipa_atribuida conclusao_origem concluida_em fechada_automaticamente_em confirmada_depois_em fotos_conclusao observacoes_staff avarias')
      .populate({ path: 'propriedade_id', select: 'nome morada morada_estruturada' })
      .populate({ path: 'utilizador_id', select: 'nome' })
      .populate({ path: 'equipa_atribuida', select: 'nome' })
      .sort({ data: -1, fechada_automaticamente_em: -1 })
      .limit(500)
      .lean();

    const itens = tarefas.map((t) => {
      const p = t.propriedade_id;
      const fecho = new Date(t.fechada_automaticamente_em).getTime();
      const fotos = Array.isArray(t.fotos_conclusao) ? t.fotos_conclusao.length : 0;
      const notas = !!(t.observacoes_staff && String(t.observacoes_staff).trim());
      const avarias = (t.avarias || []).filter((a) => a && a.data_registo && new Date(a.data_registo).getTime() > fecho).length;
      const confirmada = t.conclusao_origem !== 'automatica' && !!t.confirmada_depois_em;
      return {
        _id: String(t._id),
        data: t.data,
        tipo: t.tipo,
        tipo_limpeza: t.tipo_limpeza || null,
        tempo_limpeza_minutos: t.tempo_limpeza_minutos,
        conclusao_origem: t.conclusao_origem || null,
        concluida_em: t.concluida_em || null,
        casa: p && p.nome ? { _id: String(p._id), nome: p.nome, ...moradaParaApi(p) } : null,
        pessoas: membrosPopulados(t).map((u) => ({ _id: String(u._id), nome: u.nome })),
        fechada_em: t.fechada_automaticamente_em,
        confirmada_depois: confirmada,
        confirmada_depois_em: confirmada ? t.confirmada_depois_em : null,
        acrescentou: { fotos, notas, avarias },
        acrescentou_algo: confirmada || fotos > 0 || notas || avarias > 0,
      };
    });

    // 'em_curso' com pessoa há mais de {JANELA_RECUPERACAO_DIAS} dias: o job já não lhes mexe; ficam à vista do gestor.
    const limite = new Date(`${H.somarDiasISO(H.hojeLisboa(), -JANELA_RECUPERACAO_DIAS)}T00:00:00.000Z`);
    const presasDb = await Tarefa.find({
      empresa_id: empresaId,
      tipo: 'limpeza',
      estado: 'em_curso',
      utilizador_id: { $ne: null },
      data: { $gte: desde, $lt: limite },
    })
      .select('data tipo_limpeza tempo_limpeza_minutos iniciada_em propriedade_id utilizador_id equipa_atribuida')
      .populate({ path: 'propriedade_id', select: 'nome morada morada_estruturada' })
      .populate({ path: 'utilizador_id', select: 'nome' })
      .populate({ path: 'equipa_atribuida', select: 'nome' })
      .sort({ data: -1 })
      .limit(200)
      .lean();
    const presas = presasDb.map((t) => {
      const p = t.propriedade_id;
      return {
        _id: String(t._id),
        data: t.data,
        tipo_limpeza: t.tipo_limpeza || null,
        tempo_limpeza_minutos: t.tempo_limpeza_minutos,
        iniciada_em: t.iniciada_em || null,
        casa: p && p.nome ? { _id: String(p._id), nome: p.nome, ...moradaParaApi(p) } : null,
        pessoas: membrosPopulados(t).map((u) => ({ _id: String(u._id), nome: u.nome })),
      };
    });

    return res.status(200).json({ dias, total: itens.length, limpezas: itens, presas });
  } catch (err) {
    console.error('❌ listarFechadasAutomaticamente:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
