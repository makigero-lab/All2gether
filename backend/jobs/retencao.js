/**
 * Retenção de dados pessoais (RGPD) — All2gether.
 *
 * Corre todos os dias às 03:30 (Europe/Lisbon). Complementa os TTL de ContactoHospede
 * (email/telefone, check-out + 30 dias) e WebhookLog (check-out + 30 dias). Prazos por
 * defeito (todos ajustáveis por variável de ambiente com o mesmo nome da constante):
 *
 *  RETENCAO_HOSPEDES_DIAS (90)                 nome do hóspede (Tarefa, TarefaArquivo, ReservaManual)
 *  RETENCAO_NOTAS_HOSPEDE_DIAS (30)            notas do hóspede (Tarefa, TarefaArquivo)
 *  RETENCAO_JUSTIFICACAO_DOENCA_DIAS (30)      justificacao/notas das ausências por doença, depois do fim
 *  RETENCAO_AUSENCIAS_DOENCA_MESES (12)        ausências por doença apagadas depois do fim
 *  RETENCAO_AUSENCIAS_NAO_APROVADAS_MESES (12) pendente, pendente_emergencia, rejeitada, cancelada
 *  RETENCAO_AUSENCIAS_MESES (36)               as restantes (aprovadas, não doença)
 *  RETENCAO_ARQUIVO_ANOS (5)                   TarefaArquivo anterior a 1 de janeiro de (ano - N): sem pessoas
 *  RETENCAO_AUDITORIA_ANOS (3)                 Auditoria apagada
 *  RETENCAO_NOTIFICACOES_DIAS (90)             Notificacao apagada
 *  RETENCAO_CONTAS_ELIMINADAS_DIAS (30)        contas eliminadas: email, telefone, nif, observações e password
 *
 * Tudo corre por empresa e em lotes; cada regra só toca em registos antigos que ainda têm dados
 * (idempotente). Best-effort: nunca lança.
 */
const cron = require('node-cron');
const Tarefa = require('../models/Tarefa');
const TarefaArquivo = require('../models/TarefaArquivo');
const ReservaManual = require('../models/ReservaManual');
const Ausencia = require('../models/Ausencia');
const Auditoria = require('../models/Auditoria');
const Notificacao = require('../models/Notificacao');
const Utilizador = require('../models/Utilizador');

const LOTE = 500;
const MS_DIA = 86400000;
const PLACEHOLDER_EMAIL = /^eliminado-[0-9a-f]{24}@invalido$/;
const ESTADOS_NAO_APROVADOS = ['pendente', 'pendente_emergencia', 'rejeitada', 'cancelada'];

function inteiro(nome, padrao, min, max) {
  const n = Number(process.env[nome]);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

/**
 * Aplica `aplicar(colecao, filtroDoLote)` por empresa e em lotes de LOTE documentos.
 * Devolve { total, porEmpresa } com o número de documentos tratados.
 */
async function tratar(Modelo, filtro, aplicar) {
  const col = Modelo.collection;
  const porEmpresa = {};
  let total = 0;
  const empresas = await col.distinct('empresa_id', filtro);
  for (const emp of empresas) {
    const f = { ...filtro, empresa_id: emp };
    for (;;) {
      const ids = (await col.find(f, { projection: { _id: 1 } }).limit(LOTE).toArray()).map((d) => d._id);
      if (ids.length === 0) break;
      const n = await aplicar(col, { ...f, _id: { $in: ids } });
      if (!n) break;
      total += n;
      const k = emp ? String(emp) : 'sem_empresa';
      porEmpresa[k] = (porEmpresa[k] || 0) + n;
    }
  }
  return { total, porEmpresa };
}

const atualizar = (update) => async (col, f) => (await col.updateMany(f, update)).modifiedCount || 0;
const apagar = async (col, f) => (await col.deleteMany(f)).deletedCount || 0;

async function executarRetencao(agora = new Date()) {
  const diasHospedes = inteiro('RETENCAO_HOSPEDES_DIAS', 90, 30, 3650);
  const diasNotas = inteiro('RETENCAO_NOTAS_HOSPEDE_DIAS', 30, 7, 3650);
  const diasJustificacao = inteiro('RETENCAO_JUSTIFICACAO_DOENCA_DIAS', 30, 7, 3650);
  const mesesDoenca = inteiro('RETENCAO_AUSENCIAS_DOENCA_MESES', 12, 1, 120);
  const mesesNaoAprovadas = inteiro('RETENCAO_AUSENCIAS_NAO_APROVADAS_MESES', 12, 1, 120);
  const mesesAusencias = inteiro('RETENCAO_AUSENCIAS_MESES', 36, 1, 120);
  const anosArquivo = inteiro('RETENCAO_ARQUIVO_ANOS', 5, 1, 50);
  const anosAuditoria = inteiro('RETENCAO_AUDITORIA_ANOS', 3, 1, 50);
  const diasNotificacoes = inteiro('RETENCAO_NOTIFICACOES_DIAS', 90, 7, 3650);
  const diasContas = inteiro('RETENCAO_CONTAS_ELIMINADAS_DIAS', 30, 7, 3650);

  const out = {
    hospedes: 0, notas_hospede: 0, ausencias: 0, justificacoes_doenca: 0, arquivo_anonimizado: 0,
    auditoria: 0, notificacoes: 0, contas_anonimizadas: 0, por_empresa: {},
  };
  const regista = (categoria, r) => {
    out[categoria] += r.total;
    for (const [emp, n] of Object.entries(r.porEmpresa)) {
      out.por_empresa[emp] = out.por_empresa[emp] || {};
      out.por_empresa[emp][categoria] = (out.por_empresa[emp][categoria] || 0) + n;
    }
  };
  const menosDias = (d) => new Date(agora.getTime() - d * MS_DIA);
  const menosMeses = (m) => { const d = new Date(agora); d.setMonth(d.getMonth() - m); return d; };
  const menosAnos = (a) => { const d = new Date(agora); d.setFullYear(d.getFullYear() - a); return d; };

  // Cada regra é independente: uma falha numa não impede as outras.
  const regras = [
    ['hospedes', async () => {
      const lim = menosDias(diasHospedes);
      const nulo = atualizar({ $set: { 'detalhes_reserva.nome_hospede': null } });
      for (const Modelo of [Tarefa, TarefaArquivo]) {
        regista('hospedes', await tratar(Modelo, { data: { $lt: lim }, 'detalhes_reserva.nome_hospede': { $nin: [null, ''] } }, nulo));
      }
      regista('hospedes', await tratar(ReservaManual, { check_out: { $lt: lim }, nome_hospede: { $nin: [null, ''] } }, atualizar({ $set: { nome_hospede: null } })));
    }],
    ['notas_hospede', async () => {
      const lim = menosDias(diasNotas);
      const nulo = atualizar({ $set: { 'detalhes_reserva.notas_hospede': null } });
      for (const Modelo of [Tarefa, TarefaArquivo]) {
        regista('notas_hospede', await tratar(Modelo, { data: { $lt: lim }, 'detalhes_reserva.notas_hospede': { $nin: [null, ''] } }, nulo));
      }
    }],
    ['ausencias', async () => {
      regista('ausencias', await tratar(Ausencia, { tipo: 'doenca', data_fim: { $lt: menosMeses(mesesDoenca) } }, apagar));
      regista('ausencias', await tratar(Ausencia, { tipo: { $ne: 'doenca' }, estado: { $in: ESTADOS_NAO_APROVADOS }, data_fim: { $lt: menosMeses(mesesNaoAprovadas) } }, apagar));
      regista('ausencias', await tratar(Ausencia, { tipo: { $ne: 'doenca' }, estado: { $nin: ESTADOS_NAO_APROVADOS }, data_fim: { $lt: menosMeses(mesesAusencias) } }, apagar));
    }],
    ['justificacoes_doenca', async () => {
      regista('justificacoes_doenca', await tratar(Ausencia, {
        tipo: 'doenca',
        data_fim: { $lt: menosDias(diasJustificacao) },
        $or: [{ justificacao: { $nin: [null, ''] } }, { notas: { $nin: [null, ''] } }],
      }, atualizar({ $set: { justificacao: '', notas: '' } })));
    }],
    ['arquivo_anonimizado', async () => {
      const lim = new Date(Date.UTC(agora.getUTCFullYear() - anosArquivo, 0, 1));
      regista('arquivo_anonimizado', await tratar(TarefaArquivo, { data: { $lt: lim }, anonimizado_em: { $exists: false } }, atualizar({
        $set: {
          utilizador_id: null, equipa_atribuida: [], iniciada_por: null, observacoes: '', observacoes_staff: '',
          avarias: [], fotos_conclusao: [], checklist: [], anonimizado_em: agora,
        },
        $unset: { nao_consegui_comecar: '', detalhes_reserva: '', alerta: '', checklist_dinamica: '' },
      })));
    }],
    ['auditoria', async () => {
      regista('auditoria', await tratar(Auditoria, { createdAt: { $lt: menosAnos(anosAuditoria) } }, apagar));
    }],
    ['notificacoes', async () => {
      regista('notificacoes', await tratar(Notificacao, { createdAt: { $lt: menosDias(diasNotificacoes) } }, apagar));
    }],
    ['contas_anonimizadas', async () => {
      regista('contas_anonimizadas', await tratar(Utilizador, {
        eliminado_em: { $lt: menosDias(diasContas) },
        email: { $not: PLACEHOLDER_EMAIL },
      }, atualizar([
        // email único: placeholder por conta; sem password e inativa, o login é impossível
        { $set: { email: { $concat: ['eliminado-', { $toString: '$_id' }, '@invalido'] }, telefone: '', nif: '', observacoes: '', ativo: false, pushSubscription: null } },
        { $unset: 'password_hash' },
      ])));
    }],
  ];

  const erros = [];
  for (const [nome, fn] of regras) {
    try { await fn(); } catch (err) { erros.push(`${nome}: ${err.message}`); console.error(`❌ [Retenção] ${nome}:`, err.message); }
  }
  if (erros.length) out.erro = erros.join('; ');

  const resumo = Object.entries(out).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${k}=${v}`).join(', ');
  if (resumo) console.log(`🧹 [Retenção] ${resumo}.`);
  return out;
}

function iniciarRetencao() {
  console.log('⏰ [Retenção] Cron agendado para 03:30 (Europe/Lisbon) diariamente.');
  cron.schedule('30 3 * * *', () => { executarRetencao(); }, { timezone: 'Europe/Lisbon' });
  return { executarRetencao };
}

module.exports = { iniciarRetencao, executarRetencao };
