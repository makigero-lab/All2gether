/**
 * Daily Briefing — Cron Job (FisioCell)
 *
 * Todos os dias às 08:00 (hora do servidor), gera e envia via WhatsApp
 * (mock) o plano de limpezas de cada staff para o dia.
 *
 * Fluxo:
 *   1. Calcula o intervalo [início, fim] do dia atual (UTC meia-noite).
 *   2. Procura todas as Tarefas do dia que não estejam canceladas,
 *      fazendo populate de propriedade_id e utilizador_id.
 *   3. Agrupa as tarefas por utilizador_id.
 *   4. Para cada utilizador com telefone válido, gera uma mensagem
 *      formatada e chama enviarWhatsApp(telefone, mensagem).
 *
 * NOTA: enviarWhatsApp é uma função MOCK que faz console.log.
 * Quando a integração real (Twilio/Meta Cloud API) estiver pronta,
 * substituir o corpo desta função pela chamada HTTP real.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const { notificarUtilizador } = require('../utils/notificar');

/**
 * Envia uma mensagem WhatsApp para um número de telefone.
 * MOCK: apenas regista no console. Substituir por Twilio/Meta API.
 *
 * @param {string} telefone - número em formato internacional (ex.: +351912345678)
 * @param {string} mensagem - texto a enviar
 */
function enviarWhatsApp(telefone, mensagem) {
  console.log(`\n📱 WHATSAPP → ${telefone}`);
  console.log('─────────────────────────────────────');
  console.log(mensagem);
  console.log('─────────────────────────────────────\n');
}

/**
 * Gera a mensagem formatada do briefing diário para um utilizador.
 *
 * @param {{ nome: string }} utilizador
 * @param {Array<{ propriedade_id?: { nome: string }, hora_limite?: string, tipo: string }>} tarefas
 * @returns {string}
 */
function gerarMensagem(utilizador, tarefas) {
  const nome = utilizador.nome.split(' ')[0]; // primeiro nome
  let msg = `Olá ${nome}! Aqui está o teu plano de limpezas para hoje:\n\n`;

  tarefas.forEach((t, i) => {
    const nomeCasa = t.propriedade_id?.nome ?? 'Propriedade desconhecida';
    const hora = t.hora_limite ?? '';
    const horaTxt = hora ? ` (Até às ${hora})` : '';
    msg += `${i + 1}. ${nomeCasa}${horaTxt}\n`;
  });

  msg += '\nBom trabalho! 🧹✨';
  return msg;
}

/**
 * Executa o briefing diário.
 * Procura tarefas do dia, agrupa por utilizador, e envia WhatsApp.
 */
async function executarBriefing() {
  console.log('🔔 [Daily Briefing] A iniciar às', new Date().toISOString());

  try {
    // 1) Calcula o intervalo do dia atual (meia-noite UTC).
    const agora = new Date();
    const inicioDia = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );
    const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

    // 2) Procura todas as Tarefas do dia (não canceladas).
    //    Faz populate de propriedade_id (para ter o nome da casa) e
    //    utilizador_id (para ter o nome e telefone do staff).
    const tarefas = await Tarefa.find({
      data: { $gte: inicioDia, $lt: fimDia },
      estado: { $ne: 'cancelada' },
    })
      .populate({
        path: 'propriedade_id',
        select: 'nome',
      })
      .populate({
        path: 'utilizador_id',
        select: 'nome telefone ativo eliminado_em',
      })
      .lean();

    if (tarefas.length === 0) {
      console.log('ℹ️  [Daily Briefing] Sem tarefas para hoje.');
      return;
    }

    // 3) Agrupa por utilizador_id (ignora tarefas sem utilizador atribuído).
    const porUtilizador = new Map();

    for (const t of tarefas) {
      const u = t.utilizador_id;
      // Ignora tarefas sem utilizador, utilizadores eliminados ou inativos.
      if (!u || u.eliminado_em || !u.ativo) continue;

      const key = String(u._id);
      if (!porUtilizador.has(key)) {
        porUtilizador.set(key, { utilizador: u, tarefas: [] });
      }
      porUtilizador.get(key).tarefas.push(t);
    }

    if (porUtilizador.size === 0) {
      console.log('ℹ️  [Daily Briefing] Tarefas encontradas, mas sem utilizadores ativos atribuídos.');
      return;
    }

    // 4) Para cada utilizador com telefone, gera e envia a mensagem.
    //    Além do WhatsApp, envia também uma notificação push (se o staff
    //    tiver pushSubscription ativa) com um resumo das tarefas do dia.
    let enviados = 0;
    let semTelefone = 0;
    let pushesEnviados = 0;

    for (const [, { utilizador, tarefas: tarefasUser }] of porUtilizador) {
      const telefone = utilizador.telefone?.trim();

      if (!telefone) {
        semTelefone++;
        console.log(`⚠️  [Daily Briefing] ${utilizador.nome} não tem telefone — skipping WhatsApp.`);
      } else {
        const mensagem = gerarMensagem(utilizador, tarefasUser);
        enviarWhatsApp(telefone, mensagem);
        enviados++;
      }

      // Push notification (fire-and-forget) — além do WhatsApp.
      // notificarUtilizador valida internamente se há pushSubscription.
      const staffId = String(utilizador._id);
      const count = tarefasUser.length;
      notificarUtilizador(
        staffId,
        '📋 Daily Briefing',
        `Tens ${count} tarefa(s) hoje.`,
        '/staff',
        // Prompt 115 — Daily Briefing é uma notificação "principal" → cria
        // registo in-app (sino) para o staff ver mesmo se não viu o push.
        { criarInApp: true, tipo: 'sistema' }
      );
      pushesEnviados++;
    }

    console.log(
      `✅ [Daily Briefing] Concluído: ${enviados} mensagem(s) WhatsApp enviada(s), ` +
        `${semTelefone} utilizador(es) sem telefone, ${pushesEnviados} push(es) enviados(s).`
    );
  } catch (err) {
    console.error('❌ [Daily Briefing] Erro:', err.message);
  }
}

/**
 * Inicia o cron job.
 * Agenda para todos os dias às 08:00 (0 8 * * *).
 * O fuso horário é o do servidor (configurar TZ no ambiente de produção
 * se necessário — ex.: TZ=Europe/Lisbon no Render).
 */
function iniciarDailyBriefing() {
  console.log('⏰ [Daily Briefing] Cron agendado para 08:00 diariamente (0 8 * * *).');

  cron.schedule('0 8 * * *', async () => {
    await executarBriefing();
  });

  // Permite execução manual para teste (exporta a função).
  return { executarBriefing };
}

module.exports = { iniciarDailyBriefing, executarBriefing };
