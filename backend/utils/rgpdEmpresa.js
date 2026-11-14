/**
 * RGPD por empresa — All2gether (acordo de subcontratação, art. 28.º, n.º 3, al. g).
 *
 *  - exportarEmpresa:        JSON completo da empresa (devolução dos dados), em streaming.
 *  - agendarEliminacao:      marca eliminacao_agendada_para = agora + N dias (mín. 7) e desativa a empresa.
 *  - cancelarEliminacao:     desfaz o agendamento e repõe o estado `ativa` anterior.
 *  - apagarEmpresaDefinitivo: remove TODOS os documentos da empresa (usado pelo job diário).
 *
 * As coleções são descobertas pelos esquemas: qualquer modelo com `empresa_id` entra no export e no
 * apagamento, e qualquer modelo com `utilizador_id` é limpo também pelos utilizadores da empresa
 * (notificações e auditoria antigas sem empresa_id). Há um teste que falha se aparecer um modelo
 * novo que não seja coberto.
 */
const mongoose = require('mongoose');

// Garante que todos os modelos estão registados.
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
require('../models/Propriedade');
require('../models/Tarefa');
require('../models/TarefaArquivo');
require('../models/Ausencia');
require('../models/Notificacao');
require('../models/ReservaManual');
require('../models/ContactoHospede');
require('../models/WebhookLog');
require('../models/Auditoria');
require('../models/ModeloChecklist');
require('../models/FonteCalendario');
require('../models/ReservaExterna');
require('../models/LeituraCalendario');
const Auditoria = require('../models/Auditoria');
const { obterLock, libertarLock, LockEmpresa } = require('./lockEmpresa');

const DIAS_PADRAO = 30;
const DIAS_MINIMO = 7;
const DIAS_MAXIMO = 365;

const modelosDaEmpresa = () => Object.values(mongoose.models).filter((M) => M !== Empresa && M.schema.path('empresa_id'));
const modelosPorUtilizador = () => Object.values(mongoose.models).filter((M) => M !== Utilizador && M.schema.path('utilizador_id'));

/** Nomes das coleções cobertas (para o teste de cobertura e para a documentação). */
const coleccoesCobertas = () => [...new Set([...modelosDaEmpresa(), ...modelosPorUtilizador()].map((M) => M.collection.name)), Utilizador.collection.name];

/* ------------------------------------------------------------------ */
/* Exportação                                                          */
/* ------------------------------------------------------------------ */

const CHAVES_SECRETAS = /^(password(_hash)?|push_?subscription|api[_-]?key(_hmac)?|api[_-]?secret|token|access_token|refresh_token|secret|authorization)$/i;

/** Remove (em profundidade) palavras-passe, tokens e chaves. */
function limparSegredos(v) {
  if (Array.isArray(v)) return v.map(limparSegredos);
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId) && !Buffer.isBuffer(v)) {
    const r = {};
    for (const [k, x] of Object.entries(v)) if (!CHAVES_SECRETAS.test(k)) r[k] = limparSegredos(x);
    return r;
  }
  return v;
}

/**
 * Escreve o export em streaming: `escrever(texto)` devolve uma promessa (respeita o backpressure).
 * Formato: { formato, versao, gerado_em, empresa, colecoes: { <nome>: [ ... ] } }.
 */
async function exportarEmpresa(empresaId, escrever) {
  const empresa = await Empresa.findById(empresaId).lean();
  if (!empresa) return false;
  const id = new mongoose.Types.ObjectId(String(empresaId));

  await escrever(
    `{"formato":"all2gether-exportacao-empresa","versao":1,"gerado_em":${JSON.stringify(new Date().toISOString())},` +
    `"nota":${JSON.stringify('Todos os dados da empresa. Palavras-passe, tokens e chaves, segredos e HMAC de integração não estão incluídos.')},` +
    `"empresa":${JSON.stringify(limparSegredos(empresa))},"colecoes":{`
  );
  let primeira = true;
  const cursoresPor = [
    ...modelosDaEmpresa().map((M) => [M.collection.name, M.collection.find({ empresa_id: id })]),
  ];
  // Notificações/auditoria antigas sem empresa_id, ligadas pelos utilizadores da empresa.
  const idsUsers = await Utilizador.distinct('_id', { empresa_id: id });
  for (const M of modelosPorUtilizador()) {
    if (M.schema.path('empresa_id')) {
      cursoresPor.push([`${M.collection.name}__sem_empresa_id`, M.collection.find({ utilizador_id: { $in: idsUsers }, empresa_id: null })]);
    }
  }
  cursoresPor.push([Utilizador.collection.name, Utilizador.collection.find({ empresa_id: id })]);

  for (const [nome, cursor] of cursoresPor) {
    await escrever(`${primeira ? '' : ','}${JSON.stringify(nome)}:[`);
    primeira = false;
    let n = 0;
    for await (const doc of cursor) {
      await escrever(`${n++ ? ',' : ''}${JSON.stringify(limparSegredos(doc))}`);
    }
    await escrever(']');
  }
  await escrever('}}');
  return true;
}

/* ------------------------------------------------------------------ */
/* Agendar / cancelar                                                  */
/* ------------------------------------------------------------------ */

function diasValidos(dias) {
  if (dias === undefined || dias === null || dias === '') return { ok: true, dias: Number(process.env.ELIMINACAO_EMPRESA_DIAS) >= DIAS_MINIMO ? Math.floor(Number(process.env.ELIMINACAO_EMPRESA_DIAS)) : DIAS_PADRAO };
  const n = Number(dias);
  if (!Number.isInteger(n) || n < DIAS_MINIMO || n > DIAS_MAXIMO) return { ok: false };
  return { ok: true, dias: n };
}

/** Marca a eliminação. Atómico: só agenda se ainda não estiver agendada. Devolve a empresa atualizada ou null. */
async function agendarEliminacao(empresa, { dias, pedidaPor, agora = new Date() }) {
  const quando = new Date(agora.getTime() + dias * 86400000);
  return Empresa.findOneAndUpdate(
    { _id: empresa._id, eliminacao_agendada_para: null },
    { $set: { eliminacao_agendada_para: quando, eliminacao_pedida_em: agora, eliminacao_pedida_por: pedidaPor, eliminacao_ativa_antes: empresa.ativa !== false, ativa: false } },
    { new: true }
  );
}

async function cancelarEliminacao(empresaId) {
  const e = await Empresa.findOne({ _id: empresaId, eliminacao_agendada_para: { $ne: null } });
  if (!e) return null;
  const ativa = e.eliminacao_ativa_antes !== false;
  return Empresa.findOneAndUpdate(
    { _id: empresaId, eliminacao_agendada_para: { $ne: null } },
    { $set: { eliminacao_agendada_para: null, eliminacao_pedida_em: null, eliminacao_pedida_por: null, eliminacao_ativa_antes: null, ativa } },
    { new: true }
  );
}

/* ------------------------------------------------------------------ */
/* Apagamento definitivo                                               */
/* ------------------------------------------------------------------ */

async function varrer(id, idsUsers) {
  const contagens = {};
  const soma = (nome, r) => { contagens[nome] = (contagens[nome] || 0) + (r.deletedCount || 0); };
  for (const M of modelosDaEmpresa()) soma(M.collection.name, await M.collection.deleteMany({ empresa_id: id }));
  // Registos ligados só pelo utilizador (empresa_id nulo ou em falta).
  if (idsUsers.length) {
    for (const M of modelosPorUtilizador()) soma(M.collection.name, await M.collection.deleteMany({ utilizador_id: { $in: idsUsers } }));
  }
  soma('utilizadors', await Utilizador.collection.deleteMany({ empresa_id: id }));
  return contagens;
}

/**
 * Apaga tudo o que pertence à empresa. Idempotente e retomável (a empresa só sai no fim).
 * Devolve { apagada, contagens } ou { apagada: false, motivo }.
 */
async function apagarEmpresaDefinitivo(empresaId, { agora = new Date() } = {}) {
  const id = new mongoose.Types.ObjectId(String(empresaId));
  const empresa = await Empresa.findById(id).lean();
  if (!empresa) return { apagada: false, motivo: 'inexistente' };

  // Salvaguarda: nunca apagar uma empresa que contenha Super Admins (empresa-sistema).
  if (await Utilizador.exists({ empresa_id: id, role: 'admin' })) return { apagada: false, motivo: 'contem_super_admin' };

  const chave = `eliminar-empresa:${String(id)}`;
  const dono = await obterLock(chave, { ttlMs: 15 * 60 * 1000, esperaMs: 0 });
  if (!dono) return { apagada: false, motivo: 'em_curso' };
  // Também espera por quem estiver a preencher vagas desta empresa (lock já usado noutros fluxos).
  const donoVagas = await obterLock(`vagas:${String(id)}`, { ttlMs: 5 * 60 * 1000, esperaMs: 10000 });
  try {
    if (!donoVagas) return { apagada: false, motivo: 'ocupada' };
    // Impede novos acessos e novas ligações enquanto apaga.
    // Guarda os ids dos utilizadores ANTES de apagar: se o job falhar depois de apagar os
    // utilizadores, a retoma ainda sabe que notificações/auditoria (ligadas só por utilizador_id) apagar.
    const atuais = await Utilizador.distinct('_id', { empresa_id: id });
    const guardados = Array.isArray(empresa.eliminacao_ids_utilizadores) ? empresa.eliminacao_ids_utilizadores : [];
    const idsUsers = [...new Map([...guardados, ...atuais].map((x) => [String(x), x])).values()];
    await Empresa.collection.updateOne({ _id: id }, { $set: { ativa: false, eliminacao_ids_utilizadores: idsUsers } });

    const contagens = await varrer(id, idsUsers);
    await Empresa.deleteOne({ _id: id });
    // Segunda passagem: apanha o que um job ou webhook tenha criado a meio.
    const resto = await varrer(id, idsUsers);
    for (const [k, v] of Object.entries(resto)) contagens[k] = (contagens[k] || 0) + v;

    await Auditoria.create({
      utilizador_id: empresa.eliminacao_pedida_por || new mongoose.Types.ObjectId('000000000000000000000000'),
      utilizador_nome: 'Super Admin',
      empresa_id: null,
      acao: 'empresa_apagada',
      recurso: 'empresa',
      recurso_id: String(id),
      descricao: `Empresa "${empresa.nome}" apagada em ${agora.toISOString().slice(0, 10)}.`,
    });
    return { apagada: true, contagens };
  } finally {
    if (donoVagas) await libertarLock(`vagas:${String(id)}`, donoVagas);
    await libertarLock(chave, dono);
    await LockEmpresa.deleteMany({ _id: { $regex: `:${String(id)}$` } }).catch(() => {});
  }
}

module.exports = {
  exportarEmpresa, agendarEliminacao, cancelarEliminacao, apagarEmpresaDefinitivo,
  diasValidos, limparSegredos, coleccoesCobertas, modelosDaEmpresa, modelosPorUtilizador,
  DIAS_PADRAO, DIAS_MINIMO, DIAS_MAXIMO,
};
