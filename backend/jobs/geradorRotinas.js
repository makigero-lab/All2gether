/**
 * Gerador de Rotinas — Cron Job (All2gether) — HF22
 *
 * Corre todos os dias às 02:00 (madrugada) e cria tarefas automáticas para
 * propriedades que têm dias_fixos_limpeza configurados para o dia de AMANHÃ.
 *
 * Fluxo:
 *   1. Calcula o dia da semana de amanhã (0=Dom, 1=Seg, ..., 6=Sáb).
 *   2. Procura todas as propriedades ativas com esse dia no array
 *      dias_fixos_limpeza.
 *   3. Para cada propriedade, verifica se já existe uma tarefa para amanhã
 *      (idempotência — não cria duplicados).
 *   4. Se não existe, cria a tarefa (origem: 'manual', estado: 'por_atribuir').
 *   5. Submete ao Load Balancer (determinarEquipaAtribuida ou
 *      determinarUtilizadorAtribuido) para alocar staff.
 *   6. Se o LB encontrar alguém, atualiza a tarefa com utilizador_id +
 *      equipa_atribuida + estado: 'atribuida'.
 *   7. Se não encontrar, a tarefa fica 'por_atribuir' — o gestor resolve.
 *
 * Log: informa quantas tarefas foram criadas e quantas atribuídas.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const { obterRangeDia } = require('../utils/scheduler');
const { determinarUtilizadorAtribuido, determinarEquipaAtribuida } = require('../utils/loadBalancer');

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/**
 * Executa a geração de tarefas para o dia de amanhã.
 *
 * @returns {Promise<{ criadas: number, atribuidas: number, erros: number }>}
 */
async function executarGeradorRotinas() {
  const agora = new Date();
  // Amanhã = agora + 1 dia.
  const amanha = new Date(agora);
  amanha.setDate(agora.getDate() + 1);
  const diaSemanaAmanha = amanha.getDay();

  console.log(
    `🔄 [GeradorRotinas] a procurar propriedades com limpeza fixa para ${DIAS_SEMANA[diaSemanaAmanha]} ` +
      `(${amanha.toISOString().slice(0, 10)})...`
  );

  // Procura propriedades ativas com dias_fixos_limpeza contendo o dia de amanhã.
  const propriedades = await Propriedade.find({
    ativo: true,
    dias_fixos_limpeza: { $in: [diaSemanaAmanha] },
  })
    .populate('empresa_id', 'ativa')
    .lean();

  // Filtra só propriedades de empresas ativas.
  const propriedadesValidas = propriedades.filter(
    (p) => p.empresa_id && p.empresa_id.ativa !== false
  );

  if (propriedadesValidas.length === 0) {
    console.log('ℹ️  [GeradorRotinas] nenhuma propriedade com limpeza fixa para amanhã.');
    return { criadas: 0, atribuidas: 0, erros: 0 };
  }

  console.log(
    `📋 [GeradorRotinas] ${propriedadesValidas.length} propriedade(s) encontrada(s) para ${DIAS_SEMANA[diaSemanaAmanha]}.`
  );

  const rangeAmanha = obterRangeDia(amanha);
  let criadas = 0;
  let atribuidas = 0;
  let erros = 0;

  for (const propriedade of propriedadesValidas) {
    try {
      const empresaId = propriedade.empresa_id._id;

      // Idempotência: verifica se já existe tarefa para esta propriedade amanhã.
      const tarefaExistente = await Tarefa.findOne({
        propriedade_id: propriedade._id,
        empresa_id: empresaId,
        data: { $gte: rangeAmanha.start, $lt: rangeAmanha.end },
        estado: { $nin: ['cancelada'] },
      }).lean();

      if (tarefaExistente) {
        console.log(
          `⏭️  [GeradorRotinas] "${propriedade.nome}" já tem tarefa para amanhã — skip.`
        );
        continue;
      }

      // Cria a tarefa.
      const tempoLimpeza = propriedade.tempo_limpeza_minutos || 45;
      const staffNecessario = Number(propriedade.staff_necessario) || 1;

      // Data padrão: 10:00 UTC (11:00 local).
      const dataTarefa = new Date(rangeAmanha.start);
      dataTarefa.setUTCHours(10, 0, 0, 0);

      const novaTarefa = await Tarefa.create({
        empresa_id: empresaId,
        propriedade_id: propriedade._id,
        smoobu_reserva_id: null,
        origem: 'manual',
        utilizador_id: null,
        equipa_atribuida: [],
        data: dataTarefa,
        tempo_limpeza_minutos: tempoLimpeza,
        tipo: 'limpeza',
        estado: 'por_atribuir',
        observacoes: 'Tarefa automática (rotina de limpeza fixa)',
        checklist: propriedade.checklist || [],
      });

      criadas++;
      console.log(
        `🧹 [GeradorRotinas] tarefa ${novaTarefa._id} criada para "${propriedade.nome}" ` +
          `(staff_necessario=${staffNecessario}).`
      );

      // Submete ao Load Balancer.
      try {
        if (staffNecessario > 1) {
          // Múltiplos staff — usar determinarEquipaAtribuida.
          const resultadoEquipa = await determinarEquipaAtribuida(
            empresaId,
            rangeAmanha,
            propriedade.coordenadas,
            tempoLimpeza,
            propriedade._id,
            staffNecessario
          );

          if (resultadoEquipa && resultadoEquipa.equipa.length > 0) {
            const equipaIds = resultadoEquipa.equipa.map((e) => e.utilizadorId);
            const vencedorId = equipaIds[0];

            novaTarefa.utilizador_id = vencedorId;
            novaTarefa.equipa_atribuida = equipaIds;
            novaTarefa.estado = 'atribuida';
            novaTarefa.tempo_viagem_minutos = Number(resultadoEquipa.equipa[0].tempoViagem) || 0;

            if (resultadoEquipa.insuficiente) {
              novaTarefa.alerta = `Equipa parcial: ${equipaIds.length}/${staffNecessario} staff disponíveis`;
            }

            await novaTarefa.save();
            atribuidas++;
            console.log(
              `✅ [GeradorRotinas] "${propriedade.nome}" atribuída a equipa de ${equipaIds.length} staff.`
            );
          } else {
            console.log(
              `⚠️  [GeradorRotinas] "${propriedade.nome}" — LB não encontrou equipa. Tarefa por_atribuir.`
            );
          }
        } else {
          // 1 staff — usar determinarUtilizadorAtribuido.
          const resultadoLB = await determinarUtilizadorAtribuido(
            empresaId,
            rangeAmanha,
            propriedade.coordenadas,
            tempoLimpeza,
            propriedade._id
          );

          if (resultadoLB) {
            novaTarefa.utilizador_id = resultadoLB.utilizadorId;
            novaTarefa.equipa_atribuida = [resultadoLB.utilizadorId];
            novaTarefa.estado = 'atribuida';
            novaTarefa.tempo_viagem_minutos = Number(resultadoLB.tempoViagem) || 0;
            await novaTarefa.save();
            atribuidas++;
            console.log(
              `✅ [GeradorRotinas] "${propriedade.nome}" atribuída a staff ${resultadoLB.utilizadorId}.`
            );
          } else {
            console.log(
              `⚠️  [GeradorRotinas] "${propriedade.nome}" — LB não encontrou staff. Tarefa por_atribuir.`
            );
          }
        }
      } catch (lbErr) {
        console.error(
          `⚠️  [GeradorRotinas] erro no LB para "${propriedade.nome}": ${lbErr.message}. Tarefa fica por_atribuir.`
        );
        // A tarefa já foi criada — fica por_atribuir.
      }
    } catch (err) {
      erros++;
      console.error(
        `❌ [GeradorRotinas] erro ao processar propriedade ${propriedade._id}:`,
        err.message
      );
    }
  }

  console.log(
    `🔄 [GeradorRotinas] concluído: ${criadas} tarefa(s) criada(s), ` +
      `${atribuidas} atribuída(s), ${erros} com erro.`
  );

  return { criadas, atribuidas, erros };
}

/**
 * Agenda o cron job para correr todos os dias às 02:00 (madrugada).
 */
function iniciarGeradorRotinas() {
  console.log('⏰ [GeradorRotinas] Cron agendado para 02:00 diariamente (0 2 * * *).');

  cron.schedule('0 2 * * *', async () => {
    try {
      await executarGeradorRotinas();
    } catch (err) {
      console.error('❌ [GeradorRotinas] erro não capturado no cron:', err.message);
    }
  });

  return { executarGeradorRotinas };
}

module.exports = { iniciarGeradorRotinas, executarGeradorRotinas };
