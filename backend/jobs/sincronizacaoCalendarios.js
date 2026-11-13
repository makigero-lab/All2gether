/**
 * Job: sincronização dos calendários externos (iCal) — All2gether.
 *
 * Corre no backend (node-cron), de 5 em 5 minutos; cada fonte lê-se de hora a hora (com desvio por fonte).
 * Em cada tique escolhe até 40 fontes devidas e processa-as com concorrência 3 e no máximo 1 pedido em
 * simultâneo por servidor. Desligado se ICAL_SYNC_ATIVO=false ou se as chaves de cifra não estão configuradas.
 * Também envia os lembretes dos períodos «por confirmar» (uma vez por dia, depois das 09:00) e limpa o que passou.
 */
const cron = require('node-cron');
const FonteCalendario = require('../models/FonteCalendario');
const ReservaExterna = require('../models/ReservaExterna');
const H = require('../utils/horario');
const { sincronizarFonte, funcionalidadeLigada } = require('../utils/calendarioExterno/sincronizar');
const { removerFonte } = require('../utils/calendarioExterno/decisoes');
const { avisarParceiro, avisarGestor } = require('../utils/calendarioExterno/avisos');
const { semUrl } = require('../utils/calendarioExterno/cifra');

const MAX_POR_TIQUE = 40;
const CONCORRENCIA = 3;
// Um host lento nunca prende o tique: prazo por fonte (acima dos 15 s do pedido + o tratamento) e orçamento do tique
// (abaixo dos 5 min entre tiques). O que ficar por ler continua «devido» e entra no tique seguinte.
const PRAZO_FONTE_MS = 45000;
const ORCAMENTO_TIQUE_MS = 4 * 60000;
const ADIAMENTO_HOST_LENTO_MS = 30 * 60000;
let emCurso = false;
let ultimoLembrete = null;

/** Corre `promessa` com prazo: devolve { atrasada: true } se passar de `ms` (a promessa continua em segundo plano, limitada pelo prazo do pedido). */
function comPrazoFonte(promessa, ms) {
  let t;
  const prazo = new Promise((resolve) => { t = setTimeout(() => resolve({ atrasada: true }), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(t));
}

/**
 * Processa uma lista de fontes com concorrência limitada, 1 pedido por servidor de cada vez, prazo por fonte e
 * orçamento de tempo para o lote. Um servidor que falhou por tempo é deixado em paz até ao tique seguinte.
 */
async function processarEmLote(fontes, opcoes = {}) {
  const { prazoFonteMs = PRAZO_FONTE_MS, orcamentoMs = ORCAMENTO_TIQUE_MS, ...restoOpcoes } = opcoes;
  const fila = [...fontes];
  const hostsAtivos = new Set();
  const hostsLentos = new Set();
  const adiar = [];
  const resultados = [];
  const limite = Date.now() + orcamentoMs;
  const trabalhador = async () => {
    while (fila.length && Date.now() < limite) {
      const i = fila.findIndex((f) => !hostsAtivos.has(f.url_host) && !hostsLentos.has(f.url_host));
      if (i === -1) {
        if (!hostsAtivos.size) break; // só restam fontes de hosts lentos: ficam para o próximo tique
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const [f] = fila.splice(i, 1);
      hostsAtivos.add(f.url_host);
      try {
        const r = await comPrazoFonte(sincronizarFonte(f._id, { esperaLockMs: 0, ...restoOpcoes }), prazoFonteMs);
        if (r && r.atrasada) { hostsLentos.add(f.url_host); adiar.push(f._id); } else {
          resultados.push(r);
          if (r && r.resultado === 'erro' && r.codigo === 'timeout') hostsLentos.add(f.url_host);
        }
      } catch (e) { console.error('⚠️  calendário (leitura):', semUrl(e.message)); } finally { hostsAtivos.delete(f.url_host); }
    }
  };
  await Promise.all(Array.from({ length: CONCORRENCIA }, trabalhador));
  // As fontes de um host lento que ficaram por ler são adiadas, para não ocuparem o início da fila em todos os tiques.
  for (const f of fila) if (hostsLentos.has(f.url_host)) adiar.push(f._id);
  if (adiar.length) {
    const ate = new Date(Date.now() + ADIAMENTO_HOST_LENTO_MS);
    try { await FonteCalendario.updateMany({ _id: { $in: adiar }, proxima_leitura_em: { $lt: ate } }, { $set: { proxima_leitura_em: ate } }); } catch (e) { console.error('⚠️  calendário (adiar):', semUrl(e.message)); }
  }
  return resultados;
}

/** Lembretes dos períodos por confirmar: a 3 dias (proprietário) e a 1 dia (proprietário e gestor). */
async function enviarLembretes(agora = new Date()) {
  const hoje = H.hojeLisboa(agora);
  let n = 0;
  for (const [dias, chave, gestor] of [[3, 'd3', false], [1, 'd1', true]]) {
    const dia = H.somarDiasISO(hoje, dias);
    const lista = await ReservaExterna.find({ estado: 'por_confirmar', check_out: new Date(`${dia}T00:00:00Z`), avisos_enviados: { $ne: chave } }).populate('propriedade_id', 'nome');
    for (const x of lista) {
      const casa = (x.propriedade_id && x.propriedade_id.nome) || 'uma casa';
      const txt = `Falta confirmar se o período de ${x.check_in.toISOString().slice(8, 10)}/${x.check_in.toISOString().slice(5, 7)} a ${dia.slice(8)}/${dia.slice(5, 7)} em ${casa} é uma reserva: sem isso não há limpeza.`;
      await avisarParceiro(x.parceiro_id, x.empresa_id, txt, { chave: `ical:${x._id}:${chave}` });
      if (gestor) await avisarGestor(x.empresa_id, 'Período por confirmar', txt, { chave: `ical:${x._id}:${chave}:g` });
      await ReservaExterna.updateOne({ _id: x._id }, { $addToSet: { avisos_enviados: chave } });
      n += 1;
    }
  }
  return n;
}

/** Limpezas de rotina: períodos terminados e fontes em pausa há mais de 90 dias. */
async function limpar(agora = new Date()) {
  const hoje = H.hojeLisboa(agora);
  await ReservaExterna.updateMany(
    { estado: { $in: ['por_confirmar', 'duplicada'] }, check_out: { $lt: new Date(`${hoje}T00:00:00Z`) } },
    { $set: { estado: 'terminada' } }
  );
  const antigas = await FonteCalendario.find({ removida: false, estado: 'pausada', pausada_em: { $lt: new Date(agora.getTime() - 90 * 86400000) } }).select('_id empresa_id propriedade_id parceiro_id canal_chave rotulo canal');
  for (const f of antigas) await removerFonte(f, { silencioso: true });
}

/** Um tique do job. Devolve um resumo (para testes). */
async function executarTique({ agora = new Date(), opcoes = {} } = {}) {
  if (!funcionalidadeLigada()) return { ligado: false };
  if (emCurso) return { ocupado: true };
  emCurso = true;
  try {
    const devidas = await FonteCalendario.find({ removida: false, estado: { $in: ['ativa', 'erro'] }, proxima_leitura_em: { $lte: agora } })
      .sort({ proxima_leitura_em: 1 }).limit(MAX_POR_TIQUE).select('_id url_host').lean();
    const resultados = await processarEmLote(devidas, { agora, ...opcoes });
    // Pausadas por causas externas: de hora a hora, vê-se se já podem retomar.
    if (agora.getMinutes() < 5) {
      const pausadas = await FonteCalendario.find({ removida: false, estado: 'pausada', motivo_estado: { $in: ['casa_inativa', 'parceiro_inativo', 'empresa_inativa'] } }).limit(100).select('_id url_host').lean();
      await processarEmLote(pausadas, { agora, ...opcoes });
    }
    const dia = H.hojeLisboa(agora);
    if (ultimoLembrete !== dia && H.minutosLocais(agora) >= 9 * 60) {
      ultimoLembrete = dia;
      await enviarLembretes(agora);
      await limpar(agora);
    }
    return { ligado: true, lidas: devidas.length, resultados };
  } finally {
    emCurso = false;
  }
}

function iniciarSincronizacaoCalendarios() {
  if (!funcionalidadeLigada()) {
    console.log('📅 [Calendários] desligado (ICAL_SYNC_ATIVO=false ou chaves de cifra por configurar).');
    return null;
  }
  const tarefa = cron.schedule('*/5 * * * *', () => { executarTique().catch((e) => console.error('❌ job calendários:', semUrl(e.message))); }, { timezone: 'Europe/Lisbon' });
  console.log('📅 [Calendários] sincronização iCal agendada (a cada 5 min; cada fonte de hora a hora).');
  return tarefa;
}

module.exports = { iniciarSincronizacaoCalendarios, executarTique, enviarLembretes, processarEmLote, limpar, _resetLembrete: () => { ultimoLembrete = null; } };
