/**
 * RGPD por pessoa — All2gether (acordo de subcontratação, art. 28.º, n.º 3, al. e).
 *
 *  - exportarDadosPessoa: tudo o que o sistema guarda SOBRE a pessoa (e só sobre ela).
 *  - apagarDadosPessoa:   anonimiza a pessoa (mesma regra das contas eliminadas em
 *                         jobs/retencao.js) e limpa as referências vivas.
 *
 * Nunca devolve password_hash, tokens, pushSubscription, dados de hóspedes nem de terceiros.
 */
const mongoose = require('mongoose');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const Ausencia = require('../models/Ausencia');
const Notificacao = require('../models/Notificacao');
const ReservaManual = require('../models/ReservaManual');
const Auditoria = require('../models/Auditoria');
const { filtroMembro } = require('./equipaTarefa');

const NOME_ANONIMO = 'Pessoa removida';
const LIMITE = 5000;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Mesmo padrão de jobs/retencao.js: email único por conta, sem password, inativa. */
function emailPlaceholder(id) {
  return `eliminado-${String(id)}@invalido`;
}
const PLACEHOLDER_EMAIL = /^eliminado-[0-9a-f]{24}@invalido$/;

function jaAnonimizada(u) {
  return Boolean(u && PLACEHOLDER_EMAIL.test(u.email || '') && u.nome === NOME_ANONIMO);
}

/* ------------------------------------------------------------------ */
/* Exportação                                                          */
/* ------------------------------------------------------------------ */

// Projeção segura de uma tarefa: sem hóspedes, sem colegas, sem fotos (só a contagem).
const nFotos = (campo) => ({ $cond: [{ $isArray: campo }, { $size: campo }, 0] });
const PROJECAO_TAREFA = {
  _id: 1, propriedade_id: 1, data: 1, estado: 1, tipo: 1, tipo_limpeza: 1, tempo_limpeza_minutos: 1,
  observacoes_staff: 1, iniciada_em: 1, concluida_em: 1, hora_conclusao: 1, data_conclusao: 1,
  n_fotos_conclusao: nFotos('$fotos_conclusao'),
  n_colegas_na_equipa: { $max: [0, { $subtract: [{ $size: { $ifNull: ['$equipa_atribuida', []] } }, 1] }] },
  avarias: {
    $map: {
      input: { $cond: [{ $isArray: '$avarias' }, '$avarias', []] },
      as: 'a',
      in: {
        descricao: '$$a.descricao', data_registo: '$$a.data_registo', resolvido: '$$a.resolvido',
        data_resolucao: '$$a.data_resolucao', n_fotos: nFotos('$$a.fotos'),
      },
    },
  },
};

const brutas = (Modelo, filtro) => Modelo.aggregate([{ $match: filtro }, { $sort: { data: -1 } }, { $limit: LIMITE }, { $project: PROJECAO_TAREFA }]);
const comNome = (lista, nomes) => lista.map(({ propriedade_id: pid, ...resto }) => ({ ...resto, propriedade: nomes.get(String(pid)) || null }));

/**
 * @param {object} u utilizador (lean) já validado e pertencente à sua empresa
 * @param {{ limitarAuditoriaAEmpresa?: boolean }} [opts]
 */
async function exportarDadosPessoa(u, { limitarAuditoriaAEmpresa = false } = {}) {
  const id = oid(u._id);
  const empresaId = oid(u.empresa_id);

  const propriedadesPessoa = ['parceiro', 'fornecedor'].includes(u.role)
    ? await Propriedade.find({ empresa_id: empresaId, [u.role === 'parceiro' ? 'parceiro_id' : 'fornecedor_id']: id })
      .select('nome morada nome_responsavel contacto').lean()
    : [];
  const propIds = propriedadesPessoa.map((p) => p._id);

  const filtroArquivo = { empresa_id: empresaId, $or: [{ utilizador_id: id }, { equipa_atribuida: id }] };
  const [tarefasB, arquivoB, propriasB] = await Promise.all([
    brutas(Tarefa, { empresa_id: empresaId, ...filtroMembro(id) }),
    brutas(TarefaArquivo, filtroArquivo),
    propIds.length ? brutas(Tarefa, { empresa_id: empresaId, propriedade_id: { $in: propIds } }) : [],
  ]);
  const reservasB = u.role === 'parceiro'
    ? await ReservaManual.find({ parceiro_id: id, empresa_id: empresaId })
      .select('propriedade_id check_in check_out hospedes plataforma hora_checkin tipo_limpeza data_limpeza createdAt')
      .sort({ check_in: -1 }).limit(LIMITE).lean()
    : [];

  const nomesProp = new Map();
  const todosIds = [...tarefasB, ...arquivoB, ...propriasB, ...reservasB].map((t) => String(t.propriedade_id));
  for (const p of await Propriedade.find({ _id: { $in: [...new Set(todosIds)] } }).select('nome').lean()) nomesProp.set(String(p._id), p.nome);

  const tarefas = comNome(tarefasB, nomesProp);
  const tarefasArquivo = comNome(arquivoB, nomesProp);
  const tarefasDasPropriedades = comNome(propriasB, nomesProp);
  const reservasManuais = reservasB.map(({ _id, propriedade_id, ...r }) => ({
    ...r, reserva_id: String(_id), propriedade: nomesProp.get(String(propriedade_id)) || null,
  }));

  const avariasReportadas = [...tarefas, ...tarefasArquivo].flatMap((t) =>
    (t.avarias || []).map((a) => ({ tarefa_id: String(t._id), propriedade: t.propriedade, ...a })));

  const ausencias = await Ausencia.find({ utilizador_id: id })
    .select('-_id -utilizador_id -empresa_id -__v').sort({ data_inicio: -1 }).limit(LIMITE).lean();
  const notificacoes = await Notificacao.find({ utilizador_id: id })
    .select('mensagem tipo lida data -_id').sort({ data: -1 }).limit(LIMITE).lean();

  // Auditoria: ações da pessoa (sem texto livre, que pode nomear terceiros) e registos sobre a pessoa.
  const idStr = String(id);
  const base = limitarAuditoriaAEmpresa ? { empresa_id: empresaId } : {};
  const [feitas, sobre] = await Promise.all([
    Auditoria.find({ ...base, utilizador_id: id, recurso_id: { $ne: idStr } })
      .select('acao recurso createdAt -_id').sort({ createdAt: -1 }).limit(LIMITE).lean(),
    Auditoria.find({ ...base, $or: [{ recurso_id: idStr }, { 'detalhes.utilizador_id': idStr }] })
      .select('acao recurso descricao createdAt -_id').sort({ createdAt: -1 }).limit(LIMITE).lean(),
  ]);

  const conta = {
    id: idStr, nome: u.nome, email: u.email, telefone: u.telefone || '', nif: u.nif || '',
    observacoes: u.observacoes || '', role: u.role, ativa: u.ativo !== false,
    dias_folga: u.dias_folga || [],
    folgas_rotativas: (u.folgas_rotativas || []).map((f) => ({ data: f.data, motivo: f.motivo || '' })),
    exclusivo_preferenciais: Boolean(u.exclusivo_preferenciais),
    n_propriedades_alocadas: (u.propriedades_alocadas || []).length,
    notificacoes_push_ativas: Boolean(u.pushSubscription),
    criada_em: u.createdAt, atualizada_em: u.updatedAt, eliminada_em: u.eliminado_em || null,
  };

  return {
    formato: 'all2gether-exportacao-dados-pessoais',
    versao: 1,
    gerado_em: new Date().toISOString(),
    nota: 'Inclui só dados sobre esta pessoa. Não inclui palavra-passe, tokens, dados de hóspedes nem de outras pessoas. Fotos: apenas a contagem.',
    conta,
    propriedades_associadas: propriedadesPessoa.map((p) => ({ nome: p.nome, morada: p.morada, nome_responsavel: p.nome_responsavel || '', contacto: p.contacto || '' })),
    tarefas,
    tarefas_arquivadas: tarefasArquivo,
    tarefas_nas_minhas_propriedades: tarefasDasPropriedades,
    avarias_reportadas: avariasReportadas,
    ausencias,
    notificacoes,
    reservas_manuais: reservasManuais,
    auditoria: { acoes_realizadas: feitas, registos_sobre_a_pessoa: sobre },
  };
}

/* ------------------------------------------------------------------ */
/* Apagamento (anonimização)                                           */
/* ------------------------------------------------------------------ */

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Substitui o nome antigo (palavra inteira) em textos livres da empresa. Best-effort. */
async function limparNomeEmTextos(empresaId, nome) {
  const n = String(nome || '').trim();
  if (n.length < 3 || n === NOME_ANONIMO) return 0;
  // Nome de uma só palavra: não substitui quando vem seguido de outra palavra com maiúscula,
  // para não partir o nome de outra pessoa ("Ana" em "Ana Maria concluiu").
  const umaPalavra = !/\s/.test(n);
  const seguinte = umaPalavra ? '(?!\\s+\\p{Lu})' : '';
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapar(n)}(?![\\p{L}\\p{N}])${seguinte}`, 'gu');
  let total = 0;
  for (const [Modelo, campo] of [[Auditoria, 'descricao'], [Notificacao, 'mensagem']]) {
    const docs = await Modelo.find({ empresa_id: empresaId, [campo]: { $regex: escapar(n), $options: 'i' } })
      .select(campo).limit(LIMITE).lean();
    for (const d of docs) {
      const novo = String(d[campo]).replace(re, NOME_ANONIMO);
      if (novo !== d[campo]) {
        await Modelo.collection.updateOne({ _id: d._id }, { $set: { [campo]: novo } });
        total++;
      }
    }
  }
  return total;
}

/**
 * Anonimiza a pessoa. O chamador já validou papéis, empresa e último gestor.
 * Idempotente: se já estiver anonimizada devolve { jaAnonimizada: true }.
 * @returns {Promise<{ jaAnonimizada: boolean, notificacoes_apagadas?: number, ausencias_apagadas?: number, tarefas_retiradas?: number, reatribuicao?: object }>}
 */
async function apagarDadosPessoa(utilizador) {
  const id = oid(utilizador._id);
  const empresaId = oid(utilizador.empresa_id);

  // 1) Anonimização atómica (inativa e sem password: já não entra nem é candidata a tarefas).
  const antes = await Utilizador.collection.findOneAndUpdate(
    { _id: id, empresa_id: empresaId, email: { $not: PLACEHOLDER_EMAIL } },
    [
      {
        $set: {
          nome: NOME_ANONIMO, email: emailPlaceholder(id), telefone: '', nif: '', observacoes: '',
          ativo: false, pushSubscription: null, dias_folga: [], folgas_rotativas: [], propriedades_alocadas: [],
          responsavel_id: null, exclusivo_preferenciais: false,
          eliminado_em: { $ifNull: ['$eliminado_em', new Date()] }, updatedAt: new Date(),
        },
      },
      { $unset: 'password_hash' },
    ],
    { returnDocument: 'before' }
  );
  if (!antes) return { jaAnonimizada: true };

  const out = { jaAnonimizada: false };

  // 2) Notificações e ausências da pessoa.
  out.notificacoes_apagadas = (await Notificacao.deleteMany({ utilizador_id: id })).deletedCount || 0;
  out.ausencias_apagadas = (await Ausencia.deleteMany({ utilizador_id: id })).deletedCount || 0;

  // 3) Referências nas propriedades (e contactos do proprietário, que são dados dele).
  await Propriedade.updateMany({ empresa_id: empresaId }, { $pull: { equipa_preferencial: id } });
  await Propriedade.updateMany({ empresa_id: empresaId, funcionario_preferencial_id: id }, { $set: { funcionario_preferencial_id: null } });
  await Propriedade.updateMany({ empresa_id: empresaId, fornecedor_id: id }, { $set: { fornecedor_id: null } });
  await Propriedade.updateMany({ empresa_id: empresaId, parceiro_id: id }, { $set: { parceiro_id: null, nome_responsavel: '', contacto: '' } });
  await Utilizador.collection.updateMany({ empresa_id: empresaId, responsavel_id: id }, { $set: { responsavel_id: null } });
  await ReservaManual.collection.updateMany({ parceiro_id: id, empresa_id: empresaId }, { $set: { observacoes: '' } });

  // 4) Tarefas futuras não concluídas: saem dela e voltam a por_atribuir pelo fluxo normal.
  const { desatribuirTarefasPeriodo, reatribuirAutomaticamente } = require('../controllers/ausenciaController');
  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);
  const fim = new Date(hoje.getTime() + 10 * 365 * 86400000);
  try {
    const d = await desatribuirTarefasPeriodo(id, hoje, fim, { incluirEmCurso: true });
    out.tarefas_retiradas = d.total;
  } catch (e) {
    console.error('⚠️  [RGPD] retirar das tarefas futuras:', e.message);
    out.erro_tarefas = true;
  }
  try {
    out.reatribuicao = await reatribuirAutomaticamente(empresaId, id, hoje, fim);
  } catch (e) {
    console.error('⚠️  [RGPD] reatribuição automática:', e.message);
  }

  // 5) Nome nos registos de auditoria e em textos livres da empresa.
  await Auditoria.collection.updateMany({ utilizador_id: id }, { $set: { utilizador_nome: NOME_ANONIMO } });
  try { await limparNomeEmTextos(empresaId, antes.nome); } catch (e) { console.error('⚠️  [RGPD] limpar nome em textos:', e.message); }

  return out;
}

module.exports = { exportarDadosPessoa, apagarDadosPessoa, jaAnonimizada, NOME_ANONIMO, PLACEHOLDER_EMAIL, emailPlaceholder };
