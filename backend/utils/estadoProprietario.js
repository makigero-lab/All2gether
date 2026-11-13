/**
 * Desativar / reativar um proprietário (parceiro) — All2gether.
 *
 * DESATIVAR:
 *   - desativa todas as casas ativas dele (Propriedade.ativo = false, marcadas com
 *     `inativa_por_proprietario` para a reativação só repor estas);
 *   - CANCELA as limpezas futuras ainda não iniciadas dessas casas (estado atribuida, por_atribuir
 *     ou nao_atribuida, com data >= agora). Nunca toca em limpezas em_curso nem concluidas;
 *   - avisa as pessoas da equipa que as tinham (sino + push) e fecha as ofertas de vaga abertas.
 * REATIVAR: volta a ativar as casas que foram desativadas ao desativar o proprietário.
 *           As limpezas canceladas NÃO se recriam (o gestor ou o proprietário criam de novo).
 *
 * `impactoDesativar` devolve os mesmos números sem alterar nada (para o ecrã de confirmação).
 */
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { idsEquipa } = require('./equipaTarefa');
const { notificarUtilizador } = require('./notificar');

const ESTADOS_A_CANCELAR = ['atribuida', 'por_atribuir', 'nao_atribuida'];

const diaCurto = (d) => {
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Filtro das limpezas futuras, ainda não iniciadas, das casas indicadas. */
function filtroLimpezasACancelar(empresaId, idsCasas, agora) {
  return {
    empresa_id: empresaId,
    propriedade_id: { $in: idsCasas },
    tipo: 'limpeza',
    estado: { $in: ESTADOS_A_CANCELAR },
    data: { $gte: agora },
  };
}

/** Quantas casas e limpezas seriam afetadas ao desativar o proprietário (não altera nada). */
async function impactoDesativar(empresaId, parceiroId, agora = new Date()) {
  const casas = await Propriedade.find({ empresa_id: empresaId, parceiro_id: parceiroId }).select('_id ativo').lean();
  const casasAtivas = casas.filter((c) => c.ativo !== false).length;
  const limpezas = casas.length === 0
    ? 0
    : await Tarefa.countDocuments(filtroLimpezasACancelar(empresaId, casas.map((c) => c._id), agora));
  return { casas: casasAtivas, limpezas };
}

/**
 * Desativa as casas do proprietário e cancela as limpezas futuras não iniciadas.
 * @returns {Promise<{ casas_desativadas: number, limpezas_canceladas: number, pessoas_avisadas: number }>}
 */
async function desativarCasasDoProprietario(empresaId, parceiroId, agora = new Date()) {
  const casas = await Propriedade.find({ empresa_id: empresaId, parceiro_id: parceiroId }).select('_id nome ativo').lean();
  if (casas.length === 0) return { casas_desativadas: 0, limpezas_canceladas: 0, pessoas_avisadas: 0 };
  const nomes = new Map(casas.map((c) => [String(c._id), c.nome || 'uma casa']));
  const idsCasas = casas.map((c) => c._id);

  const r = await Propriedade.updateMany(
    { _id: { $in: idsCasas }, empresa_id: empresaId, ativo: { $ne: false } },
    { $set: { ativo: false, inativa_por_proprietario: true } }
  );

  const tarefas = await Tarefa.find(filtroLimpezasACancelar(empresaId, idsCasas, agora)).lean();
  let canceladas = 0;
  const avisos = new Map(); // pessoa -> frases
  for (const t of tarefas) {
    const equipa = idsEquipa(t);
    const ok = await Tarefa.updateOne(
      { _id: t._id, estado: { $in: ESTADOS_A_CANCELAR } },
      { $set: { estado: 'cancelada', utilizador_id: null, equipa_atribuida: [], pessoas_em_falta: 0 } }
    );
    if (ok.modifiedCount !== 1) continue; // mudou entretanto (ex.: começou): não se cancela
    canceladas++;
    // Fecha a oferta de vaga, se estava aberta.
    await Tarefa.updateOne({ _id: t._id, oferta_estado: 'aberta' }, { $set: { oferta_estado: 'fechada' } });
    const frase = `${nomes.get(String(t.propriedade_id))} (${diaCurto(t.data)})`;
    for (const id of equipa) {
      const k = String(id);
      if (!avisos.has(k)) avisos.set(k, []);
      avisos.get(k).push({ frase, tarefaId: String(t._id) });
    }
  }

  // Um aviso por pessoa, com todas as limpezas que perdeu.
  for (const [pessoa, itens] of avisos) {
    const lista = itens.map((i) => i.frase).join(', ');
    await notificarUtilizador(
      pessoa,
      'Limpeza cancelada',
      itens.length === 1
        ? `A limpeza de ${lista} foi cancelada: o proprietário da casa foi desativado.`
        : `${itens.length} limpezas foram canceladas (o proprietário das casas foi desativado): ${lista}.`,
      '/staff',
      {
        criarInApp: true,
        tipo: 'tarefa_cancelada',
        empresa_id: String(empresaId),
        tarefa_id: itens[0].tarefaId,
        chave: `prop_desativado:${itens.map((i) => i.tarefaId).sort().join(',')}`.slice(0, 200),
      }
    );
  }

  return { casas_desativadas: r.modifiedCount || 0, limpezas_canceladas: canceladas, pessoas_avisadas: avisos.size };
}

/**
 * Reativa as casas que foram desativadas ao desativar o proprietário. Não recria limpezas.
 * @returns {Promise<{ casas_reativadas: number }>}
 */
async function reativarCasasDoProprietario(empresaId, parceiroId) {
  const r = await Propriedade.updateMany(
    { empresa_id: empresaId, parceiro_id: parceiroId, ativo: false, inativa_por_proprietario: true },
    { $set: { ativo: true, inativa_por_proprietario: false } }
  );
  return { casas_reativadas: r.modifiedCount || 0 };
}

module.exports = { impactoDesativar, desativarCasasDoProprietario, reativarCasasDoProprietario, ESTADOS_A_CANCELAR };
