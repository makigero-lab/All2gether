/**
 * Limpezas «da gestão» vistas pelo proprietário — SÓ DE LEITURA.
 *
 * Além das reservas que o proprietário cria, a tabela de Reservas dele mostra as limpezas das casas
 * dele que NÃO vêm de uma reserva sua: as criadas pela All2gether («Nova limpeza» do gestor, rotina)
 * e as vindas do Smoobu. Mostra a origem, as datas, o tipo de limpeza e o estado; não mostra
 * pessoas da equipa nem dados dos hóspedes. Não se editam nem se apagam (o backend responde 403).
 *
 * Sem duplicados: uma limpeza ligada a uma ReservaManual continua a aparecer como reserva dele.
 */
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const ReservaManual = require('../models/ReservaManual');
const { tipoDe } = require('./tipoLimpeza');

const MSG_LIMPEZA_DA_GESTAO = 'Esta limpeza é gerida pela All2gether (ou vem do Smoobu): não pode ser editada nem apagada por ti. Fala com o gestor.';
const DIAS_PARA_TRAS = 90; // o histórico mais antigo não se mostra (a tabela não cresce sem fim)
const MAX_LINHAS = 500;

/** 'smoobu' (reserva do Smoobu) ou 'all2gether' (criada pela equipa de gestão). */
function origemDaLimpeza(t) {
  return t.origem === 'smoobu' || t.smoobu_reserva_id ? 'smoobu' : 'all2gether';
}

/**
 * @param {*} parceiroId
 * @param {Array} [reservas] as reservas já carregadas (evita uma segunda ida à base de dados)
 * @returns {Promise<Array<object>>}
 */
async function listarLimpezasDaGestao(parceiroId, reservas = null) {
  const casas = await Propriedade.find({ parceiro_id: parceiroId }).select('_id nome morada').lean();
  if (casas.length === 0) return [];
  const casaPorId = new Map(casas.map((c) => [String(c._id), c]));

  const ligadas = new Set(
    (reservas || (await ReservaManual.find({ parceiro_id: parceiroId }).select('tarefa_gerada_id').lean()))
      .map((r) => {
        const t = r.tarefa_gerada_id;
        return t && t._id ? String(t._id) : t ? String(t) : null;
      })
      .filter(Boolean)
  );

  const desde = new Date(Date.now() - DIAS_PARA_TRAS * 86400000);
  const tarefas = await Tarefa.find({
    propriedade_id: { $in: casas.map((c) => c._id) },
    tipo: 'limpeza',
    origem_parceiro: { $ne: true }, // as geradas por reservas dele são «as reservas dele»
    data: { $gte: desde },
  })
    .select('propriedade_id data estado origem smoobu_reserva_id tipo_limpeza tempo_limpeza_minutos detalhes_reserva concluida_em hora_conclusao')
    .sort({ data: -1 })
    .limit(MAX_LINHAS)
    .lean();

  return tarefas
    .filter((t) => !ligadas.has(String(t._id)))
    .map((t) => {
      const casa = casaPorId.get(String(t.propriedade_id)) || {};
      const origem = origemDaLimpeza(t);
      const det = t.detalhes_reserva || {};
      return {
        _id: String(t._id),
        origem,
        origem_texto: origem === 'smoobu' ? 'Smoobu' : 'Criada pela All2gether',
        propriedade: { _id: String(t.propriedade_id), nome: casa.nome || 'Casa', morada: casa.morada || null },
        data: t.data,
        estado: t.estado,
        tipo_limpeza: tipoDe(t),
        tempo_limpeza_minutos: t.tempo_limpeza_minutos || null,
        check_in: det.checkin || null,
        check_out: det.checkout || null,
        hora_conclusao: t.hora_conclusao || t.concluida_em || null,
        somente_leitura: true,
      };
    });
}

/** O id é de uma limpeza da gestão numa casa deste proprietário? (para recusar editar/apagar com 403) */
async function limpezaDaGestaoDoParceiro(id, parceiroId) {
  const t = await Tarefa.findById(id).select('propriedade_id tipo').lean().catch(() => null);
  if (!t || t.tipo !== 'limpeza') return false;
  return !!(await Propriedade.exists({ _id: t.propriedade_id, parceiro_id: parceiroId }));
}

module.exports = { listarLimpezasDaGestao, limpezaDaGestaoDoParceiro, origemDaLimpeza, MSG_LIMPEZA_DA_GESTAO };
