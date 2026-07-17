/**
 * Tarefa Controller — FisioCell
 *
 * Gestão de tarefas individuais (reportar atraso, etc.)
 */

const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const { obterEmpresaId } = require('./gestorController');
const { notificarUtilizador } = require('../utils/notificar');
const {
  CAPACIDADE_MAXIMA_MINUTOS,
  calcularCargaDiaUtilizador,
  calcularInicioTarefaUtilizador,
} = require('../utils/scheduler');
const {
  verificarDisponibilidadeUtilizador,
  mensagemIndisponivel,
} = require('../utils/disponibilidade');
// Prompt 114 — Haversine para warning logístico (>15km entre tarefas do mesmo dia).
const { distanciaHaversine } = require('../utils/distancia');

/**
 * Prompt 114 — Limite de distância (km) para warning logístico.
 * Se um staff tiver duas tarefas no mesmo dia em propriedades a mais de
 * 15km, o backend retorna um warning (não bloqueia) para o gestor ter
 * noção da logística.
 */
const LIMITE_DISTANCIA_KM = 15;

/**
 * Prompt 114 — Verifica se o staff tem outra(s) tarefa(s) no mesmo dia e,
 * se ambas as propriedades tiverem coordenadas, calcula a distância entre
 * a tarefa atual e a mais próxima. Se > LIMITE_DISTANCIA_KM, devolve um
 * warning.
 *
 * @param {string} utilizadorId
 * @param {Date} dataTarefa
 * @param {string} propriedadeIdAtual
 * @returns {Promise<string|null>} mensagem de warning ou null
 */
async function verificarDistanciaTarefasDia(utilizadorId, dataTarefa, propriedadeIdAtual) {
  try {
    if (!utilizadorId || !dataTarefa || !propriedadeIdAtual) return null;

    // Normaliza o dia (meia-noite UTC para comparar mesmo-dia).
    const d = new Date(dataTarefa);
    const inicioDia = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

    // Busca as outras tarefas do staff nesse dia (excluindo a atual e
    // canceladas/concluídas que já não contam para logística).
    const outrasTarefas = await Tarefa.find({
      utilizador_id: utilizadorId,
      data: { $gte: inicioDia, $lt: fimDia },
      _id: { $ne: null },
      estado: { $nin: ['cancelada', 'concluida'] },
    })
      .populate('propriedade_id', 'coordenadas nome')
      .lean();

    if (!outrasTarefas || outrasTarefas.length === 0) return null;

    // Carrega a propriedade atual para obter coordenadas.
    const propAtual = await Propriedade.findById(propriedadeIdAtual).select('coordenadas nome').lean();
    if (!propAtual || !propAtual.coordenadas) return null;
    const coordAtual = propAtual.coordenadas;
    if (typeof coordAtual.lat !== 'number' || typeof coordAtual.lng !== 'number') return null;

    // Calcula a distância para cada outra tarefa e fica com a máxima.
    let distanciaMax = 0;
    let propriedadeDistante = null;
    for (const t of outrasTarefas) {
      const coordOutra = t.propriedade_id?.coordenadas;
      if (!coordOutra || typeof coordOutra.lat !== 'number' || typeof coordOutra.lng !== 'number') continue;
      // Ignora se for a MESMA propriedade (distância 0).
      if (String(t.propriedade_id?._id) === String(propriedadeIdAtual)) continue;
      const dist = distanciaHaversine(coordAtual, coordOutra);
      if (dist > distanciaMax) {
        distanciaMax = dist;
        propriedadeDistante = t.propriedade_id;
      }
    }

    if (distanciaMax > LIMITE_DISTANCIA_KM) {
      const kmFmt = distanciaMax.toFixed(1).replace('.', ',');
      // Prompt 123 — Estimativa de tempo de viagem (média de 40 km/h).
      const tempoViagemMin = Math.ceil((distanciaMax / 40) * 60);
      const nomeOutra = propriedadeDistante?.nome ?? 'outra propriedade';
      return `Atenção: A tarefa anterior deste funcionário fica a ${kmFmt} km de distância (em "${nomeOutra}"), tempo de viagem estimado ${tempoViagemMin} min.`;
    }

    return null;
  } catch (err) {
    console.error('⚠️  verificarDistanciaTarefasDia:', err.message);
    return null; // não bloqueia em caso de erro
  }
}
// F0 — Load balancer extraído para utils/loadBalancer.js (antes em webhookController).
const { determinarUtilizadorAtribuido } = require('../utils/loadBalancer');

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

    // Prompt 116 — aceita novos campos opcionais: hora, check_in, check_out, hospedes, nome_hospede.
    //   - hora: "HH:mm" (combina com `data` para definir a hora local da tarefa)
    //   - check_in / check_out: strings (datas/horas da reserva Smoobu)
    //   - hospedes: número de hóspedes (vai para detalhes_reserva.pax)
    //   - nome_hospede: nome do hóspede principal (vai para detalhes_reserva.nome_hospede)
    const {
      propriedade_id,
      utilizador_id,
      data,
      hora,
      check_in,
      check_out,
      hospedes,
      nome_hospede,
      tempo_limpeza_minutos,
      tipo,
    } = req.body || {};

    if (!propriedade_id || !data) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: propriedade_id e data.',
      });
    }
    if (!mongoose.isValidObjectId(propriedade_id)) {
      return res.status(400).json({ erro: 'propriedade_id inválido.' });
    }

    // v1.57.0 (Prompt 79) — Valida tipo se vier (permite criar manutenções).
    const TIPOS_VALIDOS = ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'];
    if (tipo !== undefined && tipo !== null && !TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({
        erro: `Tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}.`,
      });
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

    // Prompt 128 — Persistência de Hora Exata (Fuso de Portugal).
    //
    //   O problema: `new Date("2026-07-15T11:00")` (sem Z) é interpretado como
    //   LOCAL do servidor. Se o servidor estiver em UTC (Render/Vercel), 11:00
    //   local = 11:00 UTC. Mas o frontend em Lisboa (UTC+1) converte para 12:00.
    //
    //   Solução: convertemos a data+hora para um instante UTC que corresponda
    //   à hora de Portugal. Usamos a API Intl para determinar o offset de
    //   Europe/Lisbon no momento da data (+l1h no verão, +0h no inverno) e
    //   subtraímos esse offset para obter o instante UTC correto.
    //
    //   Assim, "11:00" em Portugal é gravada como 10:00 UTC (verão) ou
    //   11:00 UTC (inverno). Quando o frontend lê e converte para Lisboa,
    //   volta a mostrar 11:00 — exato.
    let dataNormalizada;
    const dataStr = String(data).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      // date-only "YYYY-MM-DD"
      const horaStr = hora && /^\d{1,2}:\d{2}$/.test(String(hora).trim())
        ? String(hora).trim().padStart(5, '0')
        : '00:00';

      // Cria a data como LOCAL do servidor primeiro.
      const dataLocal = new Date(`${dataStr}T${horaStr}`);

      // Calcula o offset de Europe/Lisbon para esta data (em minutos).
      // No verão (WEST = UTC+1): offset = -60. No inverno (WET = UTC+0): offset = 0.
      // O Intl devolve o offset como "GMT+0100" → extraímos os minutos.
      const offsetStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Lisbon',
        timeZoneName: 'shortOffset',
      }).formatToParts(dataLocal).find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';

      // Parse do offset (ex: "GMT+1" → +60 min, "GMT+0" → 0 min, "GMT-1" → -60 min).
      const offsetMatch = offsetStr.match(/GMT([+-])(\d+)/);
      const offsetMin = offsetMatch
        ? (offsetMatch[1] === '+' ? 1 : -1) * parseInt(offsetMatch[2], 10) * 60
        : 0;

      // Ajusta: subtrai o offset de Lisboa para obter o instante UTC que
      // corresponde à hora pretendida em Portugal.
      // Ex: 11:00 LOCAL servidor (UTC) → 11:00 UTC. Lisboa = UTC+1 → 12:00.
      //     Subtraímos 60min → 10:00 UTC. Lisboa = UTC+1 → 11:00. ✅
      dataNormalizada = new Date(dataLocal.getTime() - offsetMin * 60 * 1000);
    } else {
      // Já vem com hora ou ISO — usa diretamente (assume que já está correto).
      dataNormalizada = new Date(dataStr);
    }
    if (isNaN(dataNormalizada.getTime())) {
      return res.status(400).json({ erro: 'data inválida.' });
    }

    // Prompt 116 — Monta detalhes_reserva com os campos opcionais.
    const detalhesReserva = {};
    if (check_in !== undefined && check_in !== null && String(check_in).trim()) {
      detalhesReserva.checkin = String(check_in).trim();
    }
    if (check_out !== undefined && check_out !== null && String(check_out).trim()) {
      detalhesReserva.checkout = String(check_out).trim();
    }
    if (hospedes !== undefined && hospedes !== null && hospedes !== '') {
      const paxNum = Number(hospedes);
      if (!Number.isNaN(paxNum) && paxNum >= 0) {
        detalhesReserva.pax = paxNum;
      }
    }
    // Prompt 131 — nome_hospede (nome do hóspede principal da reserva).
    if (nome_hospede !== undefined && nome_hospede !== null && String(nome_hospede).trim()) {
      detalhesReserva.nome_hospede = String(nome_hospede).trim();
    }

    // Valida utilizador_id se vier.
    let utilizadorValidado = null;
    // Prompt 125 — Soft block: warning de conflito de horário (em vez de 409).
    let conflitoWarning = null;
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

      // v1.59.0 (Prompt 81) — Não permitir atribuir a staff de férias/ausência.
      const disp = await verificarDisponibilidadeUtilizador(user._id, dataNormalizada);
      if (disp.indisponivel) {
        return res.status(409).json({
          erro: `${user.nome} está indisponível: ${mensagemIndisponivel(disp.ausencia)}`,
          codigo: 'UTILIZADOR_INDISPONIVEL',
        });
      }

      utilizadorValidado = user._id;

      // Prompt 123 — Validação de Conflito de Horário.
      // Verifica se o staff já tem uma tarefa cuja hora de início ou fim
      // se sobrepõe à hora que estamos a tentar marcar.
      // SÓ aplica quando a tarefa tem hora real (>= 08:00) — tarefas sem
      // hora (00:00) são "all-day" e ainda não estão agendadas.
      //
      // Prompt 125 — Soft block: em vez de rejeitar com 409, definimos um
      // `conflitoWarning` e deixamos a tarefa ser criada. O warning é
      // incluído na resposta (201) para o gestor ser avisado. O conflito
      // tem prioridade sobre o warning logístico (distância entre tarefas).
      const tempoMinutos = Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45;
      const horaLocal = dataNormalizada.getHours();
      if (horaLocal >= 8) {
        const novoInicio = dataNormalizada.getTime();
        const novoFim = novoInicio + tempoMinutos * 60 * 1000;

        // Busca tarefas do staff no mesmo dia (não canceladas/concluídas).
        const dDia = new Date(dataNormalizada);
        const inicioDia = new Date(Date.UTC(dDia.getUTCFullYear(), dDia.getUTCMonth(), dDia.getUTCDate()));
        const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

        const tarefasExistentes = await Tarefa.find({
          utilizador_id: utilizadorValidado,
          data: { $gte: inicioDia, $lt: fimDia },
          estado: { $nin: ['cancelada', 'concluida'] },
        })
          .populate('propriedade_id', 'nome')
          .lean();

        for (const tExist of tarefasExistentes) {
          const existHoraLocal = new Date(tExist.data).getHours();
          // Só verifica conflito se a tarefa existente também tiver hora real.
          if (existHoraLocal < 8) continue;
          const existInicio = new Date(tExist.data).getTime();
          const existFim = existInicio + (tExist.tempo_limpeza_minutos || 45) * 60 * 1000;
          // Overlap: novoInicio < existFim AND novoFim > existInicio
          if (novoInicio < existFim && novoFim > existInicio) {
            const horaExist = new Date(tExist.data).toLocaleTimeString('pt-PT', {
              hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon',
            });
            conflitoWarning = `O funcionário já tem uma tarefa agendada neste horário (${horaExist} — ${tExist.propriedade_id?.nome ?? 'Propriedade'}).`;
            break; // não bloqueia — só regista o warning
          }
        }
      }
    }

    // Prompt 133 — Injeção de Checklist Dinâmica.
    // Se a propriedade tem modelo_checklist_id, copia as secções/items
    // para o campo checklist_dinamica da nova tarefa (snapshot).
    let checklistDinamica = [];
    const tipoFinal = tipo || 'limpeza';
    if (tipoFinal === 'limpeza' && propriedade.modelo_checklist_id) {
      try {
        const ModeloChecklist = require('../models/ModeloChecklist');
        const modelo = await ModeloChecklist.findById(propriedade.modelo_checklist_id).lean();
        if (modelo && Array.isArray(modelo.seccoes)) {
          checklistDinamica = modelo.seccoes.map((sec) => ({
            nome: sec.nome,
            items: (sec.items || []).map((item) => ({
              texto: item,
              concluido: false,
            })),
          }));
        }
      } catch (chkErr) {
        console.error('⚠️  criarTarefa: erro ao injetar checklist dinâmica:', chkErr.message);
      }
    }

    // Prompt 137 — Debug log para confirmar que nome_hospede chega e é guardado.
    console.log('📋 criarTarefa — detalhes_reserva a guardar:', JSON.stringify(detalhesReserva));

    const nova = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id,
      utilizador_id: utilizadorValidado,
      data: dataNormalizada,
      tempo_limpeza_minutos: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
      tipo: tipoFinal,
      estado: utilizadorValidado ? 'atribuida' : 'por_atribuir',
      // Prompt 116 — só guarda detalhes_reserva se houver algum campo preenchido.
      ...(Object.keys(detalhesReserva).length > 0 ? { detalhes_reserva: detalhesReserva } : {}),
      // Prompt 133 — Snapshot da checklist dinâmica (se existir modelo).
      ...(checklistDinamica.length > 0 ? { checklist_dinamica: checklistDinamica } : {}),
    });

    // v1.65.0 (Prompt 88) — Notifica o staff se a tarefa foi criada já atribuída.
    // Prompt 123 — Cria automaticamente um registo Notificacao (criarInApp: true)
    // para tarefas manuais atribuídas. O gestor criou a tarefa propositadamente
    // — o staff deve ver no sino.
    if (utilizadorValidado) {
      try {
        const tituloNotif = tipo === 'manutencao'
          ? '🛠️ Nova Manutenção Atribuída'
          : '🧹 Nova Limpeza Atribuída';
        const corpoNotif = tipo === 'manutencao'
          ? `Foste escalado para resolver uma avaria na ${propriedade.nome}.`
          : `Foste escalado para limpar a ${propriedade.nome}.`;
        notificarUtilizador(
          String(utilizadorValidado),
          tituloNotif,
          corpoNotif,
          '/staff',
          { tipo: 'tarefa_atribuida', empresa_id: String(empresaId), criarInApp: true, tarefa_id: String(nova._id) }
        );
      } catch (e) {
        // Fire-and-forget: não bloqueia a criação.
        console.error('⚠️  notificar criarTarefa:', e.message);
      }
    }

    // Prompt 114 — Warning logístico (distância entre tarefas do mesmo dia).
    let warning = null;
    if (utilizadorValidado) {
      warning = await verificarDistanciaTarefasDia(
        utilizadorValidado,
        dataNormalizada,
        propriedade_id
      );
    }

    // Prompt 125 — Soft block de conflitos: o warning de conflito (se houver)
    // tem prioridade sobre o warning logístico (distância).
    const resposta = { tarefa: nova };
    if (warning) resposta.warning = warning;
    if (conflitoWarning) resposta.warning = conflitoWarning;

    // Prompt 137 — Debug log para confirmar que a tarefa guardada tem nome_hospede.
    console.log('📋 criarTarefa — tarefa criada detalhes_reserva:', JSON.stringify(nova.detalhes_reserva));

    return res.status(201).json(resposta);
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

      // v1.59.0 (Prompt 81) — Não permitir atribuir a staff de férias/ausência.
      const disp = await verificarDisponibilidadeUtilizador(user._id, tarefa.data);
      if (disp.indisponivel) {
        return res.status(409).json({
          erro: `${user.nome} está indisponível: ${mensagemIndisponivel(disp.ausencia)}`,
          codigo: 'UTILIZADOR_INDISPONIVEL',
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
        notificarUtilizador(
          String(tarefa.utilizador_id),
          '🔄 Tarefa reatribuída',
          `Foste escalado para limpar a ${propriedade?.nome ?? 'Propriedade'}.`,
          '/staff',
          { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId) }
        );
      } catch (e) {
        // Fire-and-forget: não bloqueia a resposta.
        console.error('⚠️  notificar reatribuição:', e.message);
      }
    }

    // Prompt 114 — Warning logístico (distância entre tarefas do mesmo dia).
    let warning = null;
    if (utilizador_id) {
      warning = await verificarDistanciaTarefasDia(
        String(tarefa.utilizador_id),
        tarefa.data,
        String(tarefa.propriedade_id)
      );
    }

    const resposta = { tarefa };
    if (warning) resposta.warning = warning;
    return res.status(200).json(resposta);
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
    // Prompt 138 (136 V2) — inclui 'nao_atribuida' (SLA excedido).
    const estadosValidos = ['por_atribuir', 'atribuida', 'em_curso', 'concluida', 'cancelada', 'nao_atribuida'];
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
 * v1.57.0 (Prompt 79): NÃO bloqueia por tipo — tarefas de 'manutencao'
 * (avarias) podem ser reatribuídas livremente, tal como limpezas. Só
 * bloqueia por estado (concluída/cancelada).
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

    // v1.59.0 (Prompt 81) — Verifica ausências aprovadas (férias/doença).
    const disp = await verificarDisponibilidadeUtilizador(novoUser._id, tarefa.data);
    if (disp.indisponivel) {
      return res.status(409).json({
        erro: `${novoUser.nome} está indisponível: ${mensagemIndisponivel(disp.ausencia)}`,
        codigo: 'UTILIZADOR_INDISPONIVEL',
      });
    }

    // 4. Verifica capacidade do novo utilizador no dia.
    // Prompt 138 (136 V2) — Number() em tudo para evitar concatenação de strings.
    const cargaAtual = Number(await calcularCargaDiaUtilizador(
      utilizador_id,
      tarefa.data,
      tarefa._id
    )) || 0;
    const novaCarga = cargaAtual + Number(tarefa.tempo_limpeza_minutos || 45);
    if (!Number.isFinite(novaCarga) || novaCarga > CAPACIDADE_MAXIMA_MINUTOS) {
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
    // Prompt 138 (136 V2) — guarda o tempo de viagem calculado pelo scheduler.
    tarefa.utilizador_id = novoUser._id;
    tarefa.data = resultadoScheduler.data;
    tarefa.estado = 'atribuida';
    tarefa.tempo_viagem_minutos = Number(resultadoScheduler.tempoViagem) || 0;
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
        `Foste escalado para limpar a ${propriedade.nome ?? 'Propriedade'}.`,
        '/staff',
        { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId) }
      );
    } catch (e) {
      console.error('⚠️  notificar reatribuição:', e.message);
    }

    // Prompt 114 — Warning logístico (distância entre tarefas do mesmo dia).
    const warning = await verificarDistanciaTarefasDia(
      String(novoUser._id),
      tarefa.data,
      String(tarefa.propriedade_id)
    );

    const tarefaResp = tarefa.toObject();
    delete tarefaResp.__v;

    const resposta = {
      tarefa: tarefaResp,
      novo_inicio: resultadoScheduler.data.toISOString(),
      origem: resultadoScheduler.origem,
      tempo_viagem: resultadoScheduler.tempoViagem,
    };
    if (warning) resposta.warning = warning;
    return res.status(200).json(resposta);
  } catch (err) {
    console.error('❌ reatribuirTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* DELETE /api/gestor/tarefas/futuras — apagar tarefas futuras (v1.50) */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* GET /api/gestor/tarefas/indisponiveis — staff de férias numa data    */
/* (v1.59.0 — Prompt 81)                                                */
/* ------------------------------------------------------------------ */

/**
 * GET /api/gestor/tarefas/indisponiveis?data=YYYY-MM-DD
 *
 * Devolve os IDs dos utilizadores que têm ausência APROVADA a cobrir o
 * dia indicado. Usado pelo frontend para desabilitar/marcar essas opções
 * nos selects de atribuição de tarefas.
 *
 * Resposta 200: { indisponiveis: [{ utilizador_id, tipo, data_inicio, data_fim }] }
 */
exports.listarIndisponiveisData = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { data } = req.query;
    if (!data) {
      return res.status(400).json({ erro: 'Parâmetro data é obrigatório (YYYY-MM-DD).' });
    }

    const d = new Date(data);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ erro: 'data inválida.' });
    }
    const dia = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );

    const ausencias = await Ausencia.find({
      empresa_id: empresaId,
      estado: 'aprovada',
      data_inicio: { $lte: dia },
      data_fim: { $gte: dia },
    })
      .select('utilizador_id tipo data_inicio data_fim')
      .lean();

    const indisponiveis = ausencias.map((a) => ({
      utilizador_id: String(a.utilizador_id),
      tipo: a.tipo,
      data_inicio: a.data_inicio,
      data_fim: a.data_fim,
    }));

    return res.status(200).json({ indisponiveis });
  } catch (err) {
    console.error('❌ listarIndisponiveisData:', err.message);
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

/* ------------------------------------------------------------------ */
/* POST /api/gestor/tarefas/auto-atribuir — Load Balancer em lote      */
/* (v1.63.0 — Prompt 86)                                                */
/* ------------------------------------------------------------------ */

/**
 * POST /api/gestor/tarefas/auto-atribuir
 *
 * Corre o Load Balancer manualmente para todas as tarefas órfãs
 * (estado 'por_atribuir') da empresa a partir de hoje (meia-noite UTC).
 *
 * Para cada tarefa órfã:
 *   1. Calcula o range do dia da tarefa (início/fim do dia UTC).
 *   2. Carrega a propriedade para obter coordenadas.
 *   3. Invoca determinarUtilizadorAtribuido (load balancer partilhado com
 *      o webhook: filtra ausências, folgas fixas, calcula carga + viagem,
 *      respeita SLA 480min).
 *   4. Se encontrar staff: atualiza tarefa (utilizador_id + estado
 *      'atribuida') + recalcula hora de início via scheduler sequencial.
 *   5. Se não encontrar: mantém 'por_atribuir' (conta como órfã).
 *
 * Resposta 200: { sucesso: true, processadas: N, reatribuidas: X, orfas: Y, detalhe: [{...}] }
 */
exports.autoAtribuirTarefas = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // Data de hoje à meia-noite UTC.
    const agora = new Date();
    const hojeInicio = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
    );

    // Busca todas as tarefas órfãs (por_atribuir) da empresa desde hoje.
    const tarefasOrfas = await Tarefa.find({
      empresa_id: empresaId,
      data: { $gte: hojeInicio },
      estado: 'por_atribuir',
    })
      .populate({ path: 'propriedade_id', select: 'nome coordenadas' })
      .sort({ data: 1 })
      .lean();

    if (tarefasOrfas.length === 0) {
      return res.status(200).json({
        sucesso: true,
        processadas: 0,
        reatribuidas: 0,
        orfas: 0,
        mensagem: 'Não há tarefas por atribuir a partir de hoje.',
      });
    }

    let reatribuidas = 0;
    let orfas = 0;
    const detalhe = [];

    for (const tarefa of tarefasOrfas) {
      try {
        // Range do dia da tarefa (meia-noite UTC a meia-noite do dia seguinte).
        const d = new Date(tarefa.data);
        const start = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
        );
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        const range = { start, end };

        // Coordenadas da propriedade (para cálculo de tempo de viagem).
        const coordenadas = tarefa.propriedade_id?.coordenadas ?? null;
        const tempoNovaTarefa = tarefa.tempo_limpeza_minutos || 45;
        // Prompt 93 — id da propriedade para o Algoritmo VIP
        // (funcionário preferencial).
        const propriedadeId = tarefa.propriedade_id?._id ?? null;

        // Invoca o load balancer partilhado.
        // Prompt 138 (136 V2) — agora devolve { utilizadorId, tempoViagem } ou null.
        const resultadoLB = await determinarUtilizadorAtribuido(
          empresaId,
          range,
          coordenadas,
          tempoNovaTarefa,
          propriedadeId
        );

        const utilizadorAtribuido = resultadoLB?.utilizadorId ?? null;
        const tempoViagemLB = Number(resultadoLB?.tempoViagem) || 0;

        if (utilizadorAtribuido) {
          // Encontrou staff: recalcula hora de início via scheduler sequencial
          // (respeita viagem Haversine + almoço 13h-14h) e atualiza a tarefa.
          let novaData = tarefa.data;
          let tempoViagemScheduler = 0;
          try {
            const resultadoScheduler = await calcularInicioTarefaUtilizador(
              utilizadorAtribuido,
              start,
              coordenadas,
              tempoNovaTarefa
            );
            novaData = resultadoScheduler.data;
            tempoViagemScheduler = Number(resultadoScheduler.tempoViagem) || 0;
          } catch (errScheduler) {
            console.warn(
              `⚠️  auto-atribuir: scheduler falhou para tarefa ${tarefa._id} (mantém data original):`,
              errScheduler.message
            );
          }

          // Prompt 138 (136 V2) — tempo de viagem final (scheduler > LB).
          const tempoViagemFinal = tempoViagemScheduler > 0 ? tempoViagemScheduler : tempoViagemLB;

          await Tarefa.updateOne(
            { _id: tarefa._id },
            {
              $set: {
                utilizador_id: utilizadorAtribuido,
                estado: 'atribuida',
                data: novaData,
                tempo_viagem_minutos: tempoViagemFinal,
              },
            }
          );

          reatribuidas++;
          detalhe.push({
            tarefa_id: String(tarefa._id),
            propriedade: tarefa.propriedade_id?.nome ?? '—',
            utilizador_id: String(utilizadorAtribuido),
            novo_inicio: novaData,
            tempo_viagem_minutos: tempoViagemFinal,
            status: 'atribuida',
          });

          // Notifica o staff (fire-and-forget).
          try {
            const propNome = tarefa.propriedade_id?.nome ?? 'Propriedade';
            notificarUtilizador(
              String(utilizadorAtribuido),
              '🧹 Nova Limpeza Atribuída',
              `Foste escalado para limpar a ${propNome}.`,
              '/staff'
            );
          } catch (e) {
            // Fire-and-forget: não bloqueia.
          }
        } else {
          // Prompt 138 (136 V2) — Se o load balancer devolveu null, pode ser
          // "sem staff disponível" (ausências/folgas) ou "SLA excedido" (todos
          // > 480 min). Se for SLA, marca 'nao_atribuida' para o gestor ver.
          // Distingue pela presença de staff ativo na empresa.
          let slaExcedido = false;
          try {
            const Utilizador = require('../models/Utilizador');
            const temStaffAtivo = await Utilizador.exists({
              empresa_id: empresaId,
              role: 'staff',
              ativo: true,
              eliminado_em: null,
            });
            // Se há staff ativo mas o load balancer não atribuiu → SLA excedido.
            slaExcedido = !!temStaffAtivo;
          } catch (e) {
            // Se falha a verificação, mantém por_atribuir (seguro).
          }

          if (slaExcedido) {
            await Tarefa.updateOne(
              { _id: tarefa._id },
              { $set: { estado: 'nao_atribuida', tempo_viagem_minutos: 0 } }
            );
          }

          orfas++;
          detalhe.push({
            tarefa_id: String(tarefa._id),
            propriedade: tarefa.propriedade_id?.nome ?? '—',
            utilizador_id: null,
            status: slaExcedido ? 'nao_atribuida' : 'orfa',
          });
        }
      } catch (errTarefa) {
        // Erro numa tarefa específica não aborta o lote.
        orfas++;
        detalhe.push({
          tarefa_id: String(tarefa._id),
          propriedade: tarefa.propriedade_id?.nome ?? '—',
          utilizador_id: null,
          status: 'erro',
          erro: errTarefa.message,
        });
        console.error(
          `⚠️  auto-atribuir: erro na tarefa ${tarefa._id}:`,
          errTarefa.message
        );
      }
    }

    console.log(
      `🤖 autoAtribuirTarefas: ${tarefasOrfas.length} processadas, ` +
        `${reatribuidas} reatribuídas, ${orfas} órfãs (empresa ${empresaId}).`
    );

    return res.status(200).json({
      sucesso: true,
      processadas: tarefasOrfas.length,
      reatribuidas,
      orfas,
      detalhe,
    });
  } catch (err) {
    console.error('❌ autoAtribuirTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
