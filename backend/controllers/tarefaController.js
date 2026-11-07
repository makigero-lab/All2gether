/**
 * Tarefa Controller — All2gether
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
const { registarAuditoria } = require('../utils/auditoria');
const {
  calcularInicioTarefaUtilizador,
} = require('../utils/scheduler');
const Horario = require('../utils/horario');
const { avisarParceiro, aoConcluirTarefa } = require('../utils/cicloTarefa');
const { listarDisponiveis } = require('../utils/disponiveisTarefa');
const { calcularInicioEquipa, obterRangeDia: rangeDoDia } = require('../utils/scheduler');
const { obterStaffDisponivel } = require('../utils/loadBalancer');
const { cabeNaAgendaNaHora } = require('../utils/atribuicaoAutomatica');
const { diaTexto, tipoDe: tipoDeTarefa } = require('../utils/tipoLimpeza');
const { avisarGestores } = require('../utils/notificar');

/**
 * 'YYYY-MM-DD' (+ 'HH:MM' de Lisboa, com hora de verão) -> instante UTC.
 * Sem hora fica à meia-noite UTC (marcador de «sem hora»): nunca passa para o dia anterior.
 */
function dataDeDiaEHora(dia, hhmm) {
  if (!hhmm) return new Date(`${dia}T00:00:00.000Z`);
  const [h, m] = hhmm.split(':').map(Number);
  return Horario.utcDeMinutosLocais(dia, h * 60 + m);
}

/**
 * Hora de uma limpeza atribuída À MÃO pelo gestor. Sem hora real (meia-noite) calcula-a
 * pelo mesmo cálculo de todos os caminhos; com hora explícita respeita-a. Nunca bloqueia:
 * se ficar fora do horário, devolve um aviso.
 * @returns {Promise<{ data: Date, aviso: string|null, tempoViagem: number }>}
 */
async function horaDeAtribuicaoManual({ utilizadorId, data, tempo, propriedade }) {
  const dia = Horario.diaUTC(data);
  if (Horario.temHoraReal(data)) {
    const a = Horario.avisoForaDoHorario(data, tempo);
    return { data, aviso: a ? `Fica fora do horário (${a}).` : null, tempoViagem: 0 };
  }
  const r = await calcularInicioTarefaUtilizador(
    utilizadorId, data, propriedade.coordenadas, tempo, null, propriedade._id
  );
  if (r.cabe) return { data: r.data, aviso: null, tempoViagem: Number(r.tempoViagem) || 0 };
  return {
    data: Horario.utcDeMinutosLocais(dia, Horario.HORARIO.INICIO_DIA),
    aviso: `Fica fora do horário: ${r.motivo}. Ficou às 09:00; ajusta a hora se for preciso.`,
    tempoViagem: 0,
  };
}
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
    const outrasTarefas = await Tarefa.find(comMembro({
      data: { $gte: inicioDia, $lt: fimDia },
      _id: { $ne: null },
      estado: { $nin: ['cancelada', 'concluida'] },
    }, utilizadorId))
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
const {
  diagnosticarFaltaDeStaff, planearAtribuicao, preencherVagaTarefa,
  FILTRO_SEM_PESSOA, semPessoa, recuperavelSemPessoa,
} = require('../utils/atribuicaoAutomatica');
const { comMembro, idsEquipa, normalizarEquipa, retirarMembroDoc } = require('../utils/equipaTarefa');

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
 * Se a nova carga total do utilizador no dia ultrapassar a capacidade do dia (CAPACIDADE_ATRASO_MINUTOS),
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
      const tarefasDoDia = await Tarefa.find(comMembro({
        data: { $gte: inicioDia, $lt: fimDia },
        estado: { $nin: ['cancelada', 'concluida'] },
      }, utilizadorId)).lean();

      cargaTotal = tarefasDoDia.reduce(
        (acc, t) => acc + t.tempo_limpeza_minutos,
        0
      );

      // Se exceder a capacidade máxima, desatribui a última tarefa do dia.
      if (cargaTotal > CAPACIDADE_ATRASO_MINUTOS) {
        // Encontra a última tarefa atribuída (excluindo a atual, que já foi atualizada).
        // Só 'atribuida' (nunca 'em_curso') e só sai o responsável do atraso.
        const ultimaTarefa = await Tarefa.findOne(comMembro({
          data: { $gte: inicioDia, $lt: fimDia },
          estado: 'atribuida',
          _id: { $ne: tarefa._id },
        }, utilizadorId)).sort({ createdAt: -1 });

        if (ultimaTarefa) {
          retirarMembroDoc(ultimaTarefa, utilizadorId);
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
 * Cria uma tarefa manualmente (sem depender de integrações externas).
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
    //   - check_in / check_out: strings (datas/horas da reserva de Alojamento Local)
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
        : null;

      dataNormalizada = dataDeDiaEHora(dataStr, horaStr);
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
          erro: 'Utilizador não encontrado (ou não é da equipa/gestor ativo da empresa).',
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
      if (Horario.temHoraReal(dataNormalizada)) {
        const novoInicio = dataNormalizada.getTime();
        const novoFim = novoInicio + tempoMinutos * 60 * 1000;

        // Busca tarefas do staff no mesmo dia (não canceladas/concluídas).
        const dDia = new Date(dataNormalizada);
        const inicioDia = new Date(Date.UTC(dDia.getUTCFullYear(), dDia.getUTCMonth(), dDia.getUTCDate()));
        const fimDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);

        const tarefasExistentes = await Tarefa.find(comMembro({
          data: { $gte: inicioDia, $lt: fimDia },
          estado: { $nin: ['cancelada', 'concluida'] },
        }, utilizadorValidado))
          .populate('propriedade_id', 'nome')
          .lean();

        for (const tExist of tarefasExistentes) {
          // Só verifica conflito se a tarefa existente também tiver hora real.
          if (!Horario.temHoraReal(tExist.data)) continue;
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

    // Atribuída à mão: sem hora real, calcula-a (nunca fica uma tarefa atribuída à meia-noite).
    let dataFinal = dataNormalizada;
    let avisoHorario = null;
    if (utilizadorValidado) {
      const hm = await horaDeAtribuicaoManual({
        utilizadorId: utilizadorValidado,
        data: dataNormalizada,
        tempo: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
        propriedade,
      });
      dataFinal = hm.data;
      avisoHorario = hm.aviso;
    }

    // FIX (bloqueio de duplicados) — Rejeita a criação se já existir uma
    // tarefa ativa (não cancelada) para a MESMA propriedade, no MESMO dia E
    // MESMA hora (data exata). Múltiplas tarefas no mesmo dia são permitidas
    // apenas se as horas forem diferentes.
    const tarefaDuplicada = await Tarefa.findOne({
      empresa_id: empresaId,
      propriedade_id,
      data: dataFinal,
      estado: { $nin: ['cancelada'] },
    }).lean();
    if (tarefaDuplicada) {
      return res.status(409).json({
        erro: 'Já existe uma tarefa para esta propriedade neste dia e hora.',
        tarefa_id: tarefaDuplicada._id,
        data: dataFinal,
      });
    }

    const nova = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id,
      utilizador_id: utilizadorValidado,
      data: dataFinal,
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
    if (conflitoWarning) { resposta.warning = conflitoWarning; resposta.conflito_horario = true; }
    // Campo próprio: o aviso de «fora do horário de trabalho» não é um conflito de agenda.
    if (avisoHorario) resposta.aviso_horario = avisoHorario;

    // Prompt 137 — Debug log para confirmar que a tarefa guardada tem nome_hospede.
    console.log('📋 criarTarefa — tarefa criada detalhes_reserva:', JSON.stringify(nova.detalhes_reserva));

    return res.status(201).json(resposta);
  } catch (err) {
    console.error('❌ criarTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/gestor/tarefas/:id/data   body: { data: 'AAAA-MM-DD', hora?: 'HH:MM' (Lisboa) }
 *
 * O gestor muda o DIA (e, se quiser, a hora) de uma limpeza. Recalcula hora e pessoa com o motor
 * de horário, como o Smoobu ao mudar a data: a equipa atual fica se couber nesse dia; senão procura
 * outra; se ninguém couber fica por atribuir, com o motivo. Recusa em_curso/concluida/cancelada e
 * um dia que já tenha outra limpeza do proprietário do mesmo tipo (409 RESERVA_DUPLICADA).
 * A data fica marcada como ajustada pelo gestor (Tarefa.data_ajustada_gestor e
 * ReservaManual.data_limpeza_ajustada) para o sistema não a recalcular quando o proprietário só mexe
 * em notas. Avisa o proprietário (sino «alterada»), quem sai e quem entra/fica, e os gestores se ficar por atribuir.
 * Resposta 200: { tarefa, aviso, equipa_mudou }
 */
exports.mudarDiaTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    const dia = diaTexto(typeof (req.body || {}).data === 'string' ? req.body.data : null);
    if (!dia) return res.status(400).json({ erro: 'Dia inválido (usa o formato AAAA-MM-DD).' });
    const horaBruta = req.body.hora;
    const temHoraPedida = horaBruta !== undefined && horaBruta !== null && horaBruta !== '';
    if (temHoraPedida && !(typeof horaBruta === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(horaBruta.trim()))) {
      return res.status(400).json({ erro: 'Hora inválida (usa HH:MM).' });
    }
    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    if (['em_curso', 'concluida', 'cancelada'].includes(tarefa.estado)) {
      return res.status(409).json({
        erro: tarefa.estado === 'em_curso'
          ? 'A limpeza já começou: não se pode mudar o dia.'
          : `Não é possível mudar o dia de uma limpeza ${tarefa.estado}.`,
        codigo: 'ESTADO_INVALIDO',
      });
    }
    const diaAntes = Horario.diaUTC(tarefa.data);
    if (dia === diaAntes && !temHoraPedida) return res.status(400).json({ erro: 'A limpeza já está nesse dia.' });
    const prop = await Propriedade.findOne({ _id: tarefa.propriedade_id, empresa_id: empresaId })
      .select('nome coordenadas staff_necessario tempo_limpeza_minutos').lean();
    if (!prop) return res.status(404).json({ erro: 'Propriedade não encontrada.' });

    // Duplicados: outra limpeza do proprietário do mesmo tipo nesse dia.
    if (tarefa.tipo === 'limpeza' && dia !== diaAntes) {
      const { limpezasDoDia, textoDuplicada } = require('./parceiroController');
      const tipoT = tipoDeTarefa(tarefa);
      const inicioDia = new Date(`${dia}T00:00:00Z`);
      const r = await limpezasDoDia({ empresaId, propriedadeId: prop._id, inicioDia, tipoLimpeza: tipoT, excluirTarefaId: tarefa._id });
      if (r.doParceiro) {
        return res.status(409).json({
          erro: `Já existe outra limpeza para "${prop.nome}" ${textoDuplicada(tipoT, inicioDia)}.`,
          codigo: 'RESERVA_DUPLICADA',
        });
      }
    }

    const range = rangeDoDia(new Date(`${dia}T00:00:00Z`));
    const tempo = Number(tarefa.tempo_limpeza_minutos) || 45;
    const staffNec = Math.max(1, Number(prop.staff_necessario) || 1);
    const membrosAntes = idsEquipa(tarefa).map(String);
    const horaMin = temHoraPedida ? (() => { const [h, m] = horaBruta.trim().split(':').map(Number); return h * 60 + m; })() : null;
    const dataPedida = horaMin !== null ? Horario.utcDeMinutosLocais(dia, horaMin) : null;

    // Cabe esta equipa nesse dia? (hora pedida, se houver; senão a mais cedo)
    const tentar = async (ids) => {
      if (dataPedida) {
        for (const m of ids) {
          if (!(await cabeNaAgendaNaHora(m, dataPedida, tempo, tarefa._id, prop.coordenadas, prop._id))) return { ok: false };
        }
        return { ok: true, data: dataPedida, viagem: 0 };
      }
      const r = await calcularInicioEquipa(ids, range.start, prop.coordenadas, tempo, tarefa._id, prop._id);
      return r.cabe ? { ok: true, data: r.data, viagem: Number(r.tempoViagem) || 0 } : { ok: false, motivo: r.motivo };
    };

    let equipaNova = [];
    let dataNova = null;
    let viagem = 0;
    let motivo = null;
    let estadoNovo = 'por_atribuir';
    // 1) quem já estava e continua disponível nesse dia
    if (membrosAntes.length > 0) {
      const { disponiveis } = await obterStaffDisponivel(empresaId, range, prop._id, null);
      const okSet = new Set(disponiveis.map((u) => String(u._id)));
      const mantidos = membrosAntes.filter((m) => okSet.has(m));
      if (mantidos.length > 0) {
        const r = await tentar(mantidos);
        if (r.ok) { equipaNova = mantidos; dataNova = r.data; viagem = r.viagem; estadoNovo = 'atribuida'; }
      }
    }
    // 2) senão, o motor procura outra equipa para o dia
    if (equipaNova.length === 0) {
      const plano = await planearAtribuicao({ empresaId, propriedade: prop, dia: range.start, tempoLimpeza: tempo });
      if (plano.estado === 'atribuida' && plano.equipa_atribuida.length > 0) {
        const ids = plano.equipa_atribuida.map(String);
        if (dataPedida) {
          const r = await tentar(ids);
          if (r.ok) { equipaNova = ids; dataNova = r.data; viagem = 0; estadoNovo = 'atribuida'; }
          else { equipaNova = ids; dataNova = plano.data; viagem = plano.tempo_viagem_minutos || 0; estadoNovo = 'atribuida'; }
        } else { equipaNova = ids; dataNova = plano.data; viagem = plano.tempo_viagem_minutos || 0; estadoNovo = 'atribuida'; }
      } else {
        estadoNovo = plano.estado === 'nao_atribuida' ? 'nao_atribuida' : 'por_atribuir';
        motivo = plano.motivo_nao_atribuicao || 'Ninguém disponível nesse dia';
        dataNova = dataPedida || plano.data;
      }
    }

    const dataAntes = new Date(tarefa.data).getTime();
    if (equipaNova.length > 0) {
      const eq = normalizarEquipa(equipaNova[0], equipaNova);
      tarefa.utilizador_id = eq.utilizador_id;
      tarefa.equipa_atribuida = eq.equipa_atribuida.length > 1 ? eq.equipa_atribuida : [];
      tarefa.estado = 'atribuida';
      tarefa.motivo_nao_atribuicao = null;
      tarefa.pessoas_em_falta = Math.max(0, staffNec - eq.equipa_atribuida.length);
      tarefa.tempo_viagem_minutos = viagem;
    } else {
      tarefa.utilizador_id = null;
      tarefa.equipa_atribuida = [];
      tarefa.estado = estadoNovo;
      tarefa.motivo_nao_atribuicao = motivo;
      tarefa.pessoas_em_falta = 0;
      tarefa.tempo_viagem_minutos = 0;
    }
    tarefa.data = dataNova;
    tarefa.data_ajustada_gestor = true;
    await tarefa.save();

    // Falta gente: tenta preencher a vaga sem mexer na hora.
    if (equipaNova.length > 0 && tarefa.pessoas_em_falta > 0) {
      try { await preencherVagaTarefa({ empresaId, tarefa: tarefa.toObject(), propriedade: prop }); } catch (e) { /* mantém a vaga */ }
    }
    // A reserva do proprietário passa a ter o dia ajustado (o sistema não o recalcula por notas).
    try {
      const ReservaManual = require('../models/ReservaManual');
      await ReservaManual.updateOne({ tarefa_gerada_id: tarefa._id }, { $set: { data_limpeza: new Date(`${dia}T00:00:00Z`), data_limpeza_ajustada: true } });
    } catch (e) { console.error('⚠️  mudarDiaTarefa (reserva):', e.message); }

    // Avisos.
    if (new Date(tarefa.data).getTime() !== dataAntes) await avisarParceiro(tarefa, 'alterada');
    const fim = await Tarefa.findById(tarefa._id).lean();
    const equipaFinal = idsEquipa(fim).map(String);
    const dFmt = new Date(`${dia}T00:00:00Z`).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    const hFmt = Horario.temHoraReal(fim.data) ? ` às ${new Date(fim.data).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })}` : '';
    const opts = { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId), criarInApp: true };
    for (const m of membrosAntes.filter((x) => !equipaFinal.includes(x))) {
      notificarUtilizador(m, '📅 Limpeza mudou de dia', `A limpeza de ${prop.nome} foi mudada para ${dFmt}: já não estás nela.`, '/staff', opts);
    }
    for (const m of equipaFinal) {
      notificarUtilizador(m, '📅 Limpeza mudou de dia', `A limpeza de ${prop.nome} passou para ${dFmt}${hFmt}.`, '/staff', opts);
    }
    let aviso = null;
    if (!equipaFinal.length) {
      aviso = `Ninguém disponível a ${dFmt}: a limpeza ficou por atribuir (${motivo}).`;
      await avisarGestores(empresaId, 'Limpeza por atribuir', `${prop.nome} (${dFmt}): ${motivo}.`, '/gestor/tarefas');
    } else if (fim.pessoas_em_falta > 0) {
      aviso = `Falta ${fim.pessoas_em_falta} ${fim.pessoas_em_falta === 1 ? 'pessoa' : 'pessoas'} nessa limpeza.`;
    }
    return res.status(200).json({ tarefa: fim, aviso, equipa_mudou: membrosAntes.join() !== equipaFinal.join() });
  } catch (err) {
    console.error('❌ mudarDiaTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/gestor/tarefas/:id/disponiveis[?acao=atribuir|reatribuir]
 *
 * Quem pode fazer a limpeza (para o seletor da atribuição manual), com a hora
 * prevista de cada pessoa. Sem ninguém: lista vazia e o motivo real.
 * Resposta 200: { modo: 'responsavel'|'vaga', disponiveis: [{ _id, nome, hora_prevista, tempo_viagem_minutos }], motivo }
 */
exports.listarDisponiveisTarefa = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    }
    const tarefa = await Tarefa.findOne({ _id: id, empresa_id: empresaId }).lean();
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    if (tarefa.estado === 'concluida' || tarefa.estado === 'cancelada') {
      return res.status(409).json({ erro: "Não é possível atribuir uma tarefa " + tarefa.estado + ".", codigo: 'ESTADO_INVALIDO' });
    }
    const propriedade = await Propriedade.findOne({ _id: tarefa.propriedade_id, empresa_id: empresaId })
      .select('coordenadas nome staff_necessario').lean();
    if (!propriedade) return res.status(404).json({ erro: 'Propriedade não encontrada.' });
    const acao = req.query.acao === 'atribuir' ? 'atribuir' : 'reatribuir';
    const r = await listarDisponiveis({ empresaId, tarefa, propriedade, acao });
    return res.status(200).json(r);
  } catch (err) {
    console.error('❌ listarDisponiveisTarefa:', err.message);
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
    let equipaAntes = [];
    let avisoHorario = null;
    const dataAntes = new Date(tarefa.data).getTime();

    // Tarefas concluídas/canceladas são histórico: não se atribuem (antes eram "ressuscitadas").
    if (tarefa.estado === 'concluida' || tarefa.estado === 'cancelada') {
      return res.status(409).json({
        erro: `Não é possível atribuir uma tarefa ${tarefa.estado}.`,
        codigo: 'ESTADO_INVALIDO',
      });
    }

    if (!utilizador_id) {
      // Remove atribuição.
      tarefa.utilizador_id = null;
      tarefa.equipa_atribuida = [];
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
          erro: 'Utilizador não encontrado (ou não é da equipa/gestor ativo).',
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

      // Equipa anterior (para saber quem é novo e para notificar só esses).
      equipaAntes = idsEquipa(tarefa);

      // Quem escolhe UMA pessoa define o RESPONSÁVEL: substitui o responsável
      // atual e MANTÉM os outros membros (antes ficavam como membros fantasma).
      // Se a pessoa já era membro, apenas passa a responsável. Para definir a
      // equipa inteira de uma vez, enviar também `equipa_atribuida: [ids]`.
      let membros;
      const extra = req.body && req.body.equipa_atribuida;
      if (Array.isArray(extra) && extra.length > 0) {
        const ids = [...new Set(extra.map(String))];
        if (!ids.every((i) => mongoose.isValidObjectId(i))) {
          return res.status(400).json({ erro: 'equipa_atribuida inválida.' });
        }
        const validos = await Utilizador.find({
          _id: { $in: ids },
          empresa_id: empresaId,
          role: { $in: ['staff', 'gestor'] },
          ativo: true,
          eliminado_em: null,
        }).select('nome').lean();
        if (validos.length !== ids.length) {
          return res.status(400).json({ erro: 'Há membros da equipa inválidos (ou de outra empresa).' });
        }
        for (const v of validos) {
          if (String(v._id) === String(user._id)) continue;
          const dm = await verificarDisponibilidadeUtilizador(v._id, tarefa.data);
          if (dm.indisponivel) {
            return res.status(409).json({
              erro: `${v.nome} está indisponível: ${mensagemIndisponivel(dm.ausencia)}`,
              codigo: 'UTILIZADOR_INDISPONIVEL',
            });
          }
        }
        membros = ids;
      } else {
        const antigoResp = tarefa.utilizador_id ? String(tarefa.utilizador_id) : null;
        membros = equipaAntes.filter((i) => i !== antigoResp);
      }
      const eq = normalizarEquipa(user._id, membros);
      tarefa.utilizador_id = eq.utilizador_id;
      // Equipa de 1 pessoa em tarefa antiga mantém-se "vazia" (equivale a utilizador_id).
      tarefa.equipa_atribuida = eq.equipa_atribuida.length > 1 || equipaAntes.length > 1 ? eq.equipa_atribuida : [];
      tarefa.estado = 'atribuida';
      tarefa.motivo_nao_atribuicao = null;
      try {
        const pr = await Propriedade.findById(tarefa.propriedade_id).select('staff_necessario coordenadas').lean();
        tarefa.pessoas_em_falta = Math.max(0, (Number(pr?.staff_necessario) || 1) - eq.equipa_atribuida.length);
        // Hora: uma tarefa atribuída nunca fica à meia-noite. Sem hora real calcula-se pelo
        // mesmo cálculo de todos os caminhos; com hora real respeita-se (o gestor manda) e
        // avisa-se, sem bloquear, se ficar fora do horário.
        const tempoT = tarefa.tempo_limpeza_minutos || 45;
        if (!Horario.temHoraReal(tarefa.data)) {
          const r = await calcularInicioTarefaUtilizador(
            idsEquipa(tarefa), tarefa.data, pr && pr.coordenadas, tempoT, tarefa._id, tarefa.propriedade_id
          );
          if (r.cabe) {
            tarefa.data = r.data;
            tarefa.tempo_viagem_minutos = Number(r.tempoViagem) || 0;
          } else {
            tarefa.data = Horario.utcDeMinutosLocais(Horario.diaUTC(tarefa.data), Horario.HORARIO.INICIO_DIA);
            avisoHorario = `Fica fora do horário: ${r.motivo}. Ficou às 09:00; ajusta a hora se for preciso.`;
          }
        } else {
          const fora = Horario.avisoForaDoHorario(tarefa.data, tempoT);
          if (fora) avisoHorario = `Fica fora do horário (${fora}).`;
        }
      } catch (e) { /* mantém */ }
    }

    await tarefa.save();
    // O gestor mudou o dia/hora de uma limpeza de parceiro: aviso no sino do parceiro.
    if (new Date(tarefa.data).getTime() !== dataAntes) await avisarParceiro(tarefa, 'alterada');

    // Notifica quem passou a fazer parte da tarefa (fire-and-forget).
    // Só envia se foi uma (re)atribuição real — não no caso de remover atribuição.
    if (utilizador_id) {
      try {
        const propriedade = await Propriedade.findById(
          tarefa.propriedade_id
        )
          .select('nome')
          .lean();
        for (const novo of idsEquipa(tarefa).filter((i) => !equipaAntes.includes(i))) {
          notificarUtilizador(
            novo,
            '🔄 Tarefa reatribuída',
            `Foste escalado para limpar a ${propriedade?.nome ?? 'Propriedade'}.`,
            '/staff',
            { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId) }
          );
        }
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
    if (avisoHorario) resposta.aviso_horario = avisoHorario;
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

    // Coerência: 'atribuida'/'em_curso' exigem staff; sair de 'concluida' limpa os campos de conclusão.
    if ((estado === 'atribuida' || estado === 'em_curso') && !tarefa.utilizador_id) {
      return res.status(400).json({
        erro: `Não é possível marcar como "${estado}" uma tarefa sem staff. Atribui primeiro.`,
      });
    }
    if (tarefa.estado === 'concluida' && estado !== 'concluida') {
      tarefa.concluida_em = null;
      tarefa.data_conclusao = null;
      tarefa.hora_conclusao = null;
    }
    const estadoAntes = tarefa.estado;
    tarefa.estado = estado;
    if (estado === 'concluida') {
      const agoraConclusao = new Date();
      tarefa.concluida_em = tarefa.concluida_em || agoraConclusao;
      tarefa.data_conclusao = tarefa.data_conclusao || agoraConclusao; // usado pelo job limpezaFotos
      tarefa.hora_conclusao = tarefa.hora_conclusao || agoraConclusao;
    }
    // Volta ao pool (ou cancelada): liberta o staff e a equipa.
    if (estado === 'por_atribuir' || estado === 'nao_atribuida' || estado === 'cancelada') {
      tarefa.utilizador_id = null;
      tarefa.equipa_atribuida = [];
    }
    await tarefa.save();

    // Efeitos laterais (só quando o estado mudou de facto): avaria resolvida, avisos ao parceiro.
    if (estadoAntes !== estado) {
      if (estado === 'concluida') await aoConcluirTarefa(tarefa);
      else if (estado === 'cancelada') await avisarParceiro(tarefa, 'cancelada');
    }

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
 *   4. (Removido) A atribuição à mão já não é bloqueada pela capacidade:
 *      se a limpeza não couber no horário (09:00-18:00, almoço, viagens)
 *      a resposta traz um `warning` e a tarefa fica na hora atual.
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
        erro: 'Utilizador não encontrado (ou não é da equipa/gestor ativo).',
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

    // 5. Carrega a propriedade para obter coordenadas.
    const propriedade = await Propriedade.findById(tarefa.propriedade_id)
      .select('coordenadas nome staff_necessario')
      .lean();
    if (!propriedade) {
      return res.status(404).json({ erro: 'Propriedade não encontrada.' });
    }

    // 6. Calcula o novo início primeiro (scheduler sequencial + almoço), ignorando a
    //    própria tarefa. Nada é gravado até estar tudo calculado: se falhar, a equipa
    //    anterior fica intacta e a tarefa nunca fica com o responsável a null.
    const equipaAntes = idsEquipa(tarefa);
    const antigoResp = tarefa.utilizador_id ? String(tarefa.utilizador_id) : null;
    // A hora calcula-se para a equipa RESULTANTE (novo responsável + os membros que ficam).
    const eq = normalizarEquipa(novoUser._id, equipaAntes.filter((i) => i !== antigoResp));
    const idsResultantes = [...new Set([String(novoUser._id), ...eq.equipa_atribuida.map(String)])];
    let resultadoScheduler = await calcularInicioTarefaUtilizador(
      idsResultantes.length > 1 ? idsResultantes : utilizador_id,
      tarefa.data,
      propriedade.coordenadas,
      tarefa.tempo_limpeza_minutos || 45,
      tarefa._id,
      tarefa.propriedade_id
    );
    // A atribuição à mão nunca é bloqueada pelo horário: se não couber, mantém a hora
    // da tarefa (ou as 09:00 se não tinha hora real) e AVISA o gestor.
    let avisoHorario = null;
    if (!resultadoScheduler.cabe) {
      const diaT = Horario.diaUTC(tarefa.data);
      const dataManter = Horario.temHoraReal(tarefa.data)
        ? new Date(tarefa.data)
        : Horario.utcDeMinutosLocais(diaT, Horario.HORARIO.INICIO_DIA);
      avisoHorario = idsResultantes.length > 1
        ? `A equipa fica fora do horário neste dia: ${resultadoScheduler.motivo}.`
        : `${novoUser.nome} fica fora do horário neste dia: ${resultadoScheduler.motivo}.`;
      resultadoScheduler = { ...resultadoScheduler, data: dataManter, origem: 'manual_fora_do_horario', tempoViagem: 0 };
    }

    // 8. Guarda a tarefa com o novo utilizador + nova data.
    // Prompt 138 (136 V2) — guarda o tempo de viagem calculado pelo scheduler.
    // O novo responsável substitui o anterior; os outros membros mantêm-se.
    tarefa.utilizador_id = eq.utilizador_id;
    tarefa.equipa_atribuida = eq.equipa_atribuida.length > 1 || equipaAntes.length > 1 ? eq.equipa_atribuida : [];
    const dataAntesReatrib = new Date(tarefa.data).getTime();
    tarefa.data = resultadoScheduler.data;
    tarefa.estado = 'atribuida';
    tarefa.motivo_nao_atribuicao = null;
    tarefa.tempo_viagem_minutos = Number(resultadoScheduler.tempoViagem) || 0;
    // Recalcula as vagas com o staff_necessario atual (a equipa pode ter encolhido,
    // p.ex. se o novo responsável já era membro).
    tarefa.pessoas_em_falta = Math.max(0, (Number(propriedade.staff_necessario) || 1) - eq.equipa_atribuida.length);
    await tarefa.save();
    if (new Date(tarefa.data).getTime() !== dataAntesReatrib) await avisarParceiro(tarefa, 'alterada');

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
      if (!equipaAntes.includes(String(novoUser._id))) {
        notificarUtilizador(
          String(novoUser._id),
          '🔄 Tarefa reatribuída',
          `Foste escalado para limpar a ${propriedade.nome ?? 'Propriedade'}.`,
          '/staff',
          { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId) }
        );
      }
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
    if (avisoHorario) resposta.aviso_horario = avisoHorario;
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
      // 'nao_atribuida' também: antes ficavam presas para sempre mesmo havendo staff novo/disponível.
      // E as 'atribuida' com equipa incompleta (só se preenche a vaga).
      $or: [
        { estado: { $in: ['por_atribuir', 'nao_atribuida'] } },
        { estado: 'atribuida', pessoas_em_falta: { $gt: 0 } },
        // 'atribuida'/'em_curso' sem ninguém (estado incoerente): tratadas como por atribuir.
        FILTRO_SEM_PESSOA,
      ],
    })
      .populate({ path: 'propriedade_id', select: 'nome coordenadas staff_necessario tempo_limpeza_minutos' })
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

    const porPessoa = new Map();
    const emCursoSemResponsavel = [];
    for (const tarefa of tarefasOrfas) {
      try {
        const fantasma = semPessoa(tarefa);
        if (fantasma && !recuperavelSemPessoa(tarefa)) {
          // 'em_curso' sem responsável mas com trabalho já feito: não se mexe; o gestor decide.
          orfas++;
          emCursoSemResponsavel.push(tarefa.propriedade_id?.nome ?? '—');
          detalhe.push({
            tarefa_id: String(tarefa._id),
            propriedade: tarefa.propriedade_id?.nome ?? '—',
            status: 'em_curso_sem_responsavel',
          });
          continue;
        }
        // Equipa incompleta: preenche só a vaga (mantém responsável e hora).
        if (tarefa.estado === 'atribuida' && !fantasma) {
          const v = await preencherVagaTarefa({ empresaId, tarefa, propriedade: tarefa.propriedade_id || {} });
          if (v.novos.length > 0) {
            reatribuidas++;
            detalhe.push({
              tarefa_id: String(tarefa._id),
              propriedade: tarefa.propriedade_id?.nome ?? '—',
              status: 'vaga_preenchida',
              preenchidas: v.novos.length,
              ...(v.faltam > 0 ? { faltam: v.faltam } : {}),
            });
            for (const id of v.novos) {
              const k = String(id);
              if (!porPessoa.has(k)) porPessoa.set(k, []);
              porPessoa.get(k).push(tarefa.propriedade_id?.nome ?? 'Propriedade');
            }
          } else {
            orfas++;
            detalhe.push({
              tarefa_id: String(tarefa._id),
              propriedade: tarefa.propriedade_id?.nome ?? '—',
              status: 'vaga_por_preencher',
              faltam: v.faltam,
            });
          }
          continue;
        }
        // Motor partilhado: respeita staff_necessario, scheduler e diagnóstico do motivo.
        const propriedade = tarefa.propriedade_id || {};
        const plano = await planearAtribuicao({
          empresaId,
          propriedade,
          dia: tarefa.data,
          tempoLimpeza: tarefa.tempo_limpeza_minutos || 45,
        });

        if (plano.estado === 'atribuida') {
          await Tarefa.updateOne(
            fantasma ? { _id: tarefa._id, estado: tarefa.estado, utilizador_id: null } : { _id: tarefa._id },
            {
              $set: {
                utilizador_id: plano.utilizador_id,
                equipa_atribuida: plano.equipa_atribuida,
                data: plano.data,
                tempo_viagem_minutos: plano.tempo_viagem_minutos,
                estado: 'atribuida',
                motivo_nao_atribuicao: null,
                pessoas_em_falta: plano.faltam,
              },
            }
          );

          reatribuidas++;
          detalhe.push({
            tarefa_id: String(tarefa._id),
            propriedade: propriedade.nome ?? '—',
            utilizador_id: String(plano.utilizador_id),
            equipa: plano.equipa_atribuida.map(String),
            novo_inicio: plano.data,
            tempo_viagem_minutos: plano.tempo_viagem_minutos,
            status: 'atribuida',
            ...(plano.faltam > 0 ? { faltam: plano.faltam } : {}),
          });
          for (const id of plano.equipa_atribuida) {
            const k = String(id);
            if (!porPessoa.has(k)) porPessoa.set(k, []);
            porPessoa.get(k).push(propriedade.nome ?? 'Propriedade');
          }
        } else {
          await Tarefa.updateOne(
            { _id: tarefa._id },
            { $set: { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao, ...(plano.estado === 'nao_atribuida' ? { tempo_viagem_minutos: 0 } : {}) } }
          );
          orfas++;
          detalhe.push({
            tarefa_id: String(tarefa._id),
            propriedade: propriedade.nome ?? '—',
            utilizador_id: null,
            status: plano.estado === 'nao_atribuida' ? 'nao_atribuida' : 'orfa',
            motivo: plano.motivo_nao_atribuicao,
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

    // Uma notificação por pessoa (não uma por tarefa).
    for (const [idStr, props] of porPessoa) {
      notificarUtilizador(
        idStr,
        '🧹 Nova Limpeza Atribuída',
        props.length === 1
          ? `Foste escalado para limpar a ${props[0]}.`
          : `Foste escalado para ${props.length} limpezas. Vê a tua agenda.`,
        '/staff'
      );
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
      ...(emCursoSemResponsavel.length ? { em_curso_sem_responsavel: emCursoSemResponsavel.length } : {}),
      detalhe,
    });
  } catch (err) {
    console.error('❌ autoAtribuirTarefas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};


/**
 * HF18 — POST /api/gestor/tarefas/espontanea
 *
 * Cria uma limpeza manual/espontânea (origem: 'manual'). Diferente do
 * criarTarefa (que é genérico), este endpoint:
 *   - Sempre define origem: 'manual' e smoobu_reserva_id: null
 *   - Aceita observacoes diretamente no body
 *   - Se utilizador_id vier (opcional), atribui diretamente (salta o LB)
 *   - Se não vier utilizador_id, fica 'por_atribuir' para o LB/gestor
 *
 * Body:
 *   propriedade_id: String (obrigatório)
 *   data: String "YYYY-MM-DD" ou ISO (obrigatório)
 *   hora: String "HH:mm" (opcional)
 *   observacoes: String (opcional)
 *   utilizador_id: String (opcional — força atribuição)
 *   tempo_limpeza_minutos: Number (opcional)
 *   tipo: String (opcional, default 'limpeza')
 */
exports.criarTarefaEspontanea = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const {
      propriedade_id,
      utilizador_id,
      data,
      hora,
      observacoes,
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

    // Valida tipo.
    const TIPOS_VALIDOS = ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'];
    if (tipo !== undefined && tipo !== null && !TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({
        erro: `Tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}.`,
      });
    }

    // Valida que a propriedade pertence à empresa.
    const propriedade = await Propriedade.findOne({
      _id: propriedade_id,
      empresa_id: empresaId,
    });
    if (!propriedade) {
      return res.status(404).json({
        erro: 'Propriedade não encontrada (ou não pertence a esta empresa).',
      });
    }

    // Normaliza a data (mesma lógica do criarTarefa).
    let dataNormalizada;
    const dataStr = String(data).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      const horaStr = hora && /^\d{1,2}:\d{2}$/.test(String(hora).trim())
        ? String(hora).trim().padStart(5, '0')
        : null;
      dataNormalizada = dataDeDiaEHora(dataStr, horaStr);
    } else {
      dataNormalizada = new Date(dataStr);
    }
    if (isNaN(dataNormalizada.getTime())) {
      return res.status(400).json({ erro: 'data inválida.' });
    }

    // Valida utilizador_id se vier (força atribuição, salta o LB).
    let utilizadorValidado = null;
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
          erro: 'Utilizador não encontrado (ou não é da equipa/gestor ativo da empresa).',
        });
      }
      utilizadorValidado = user._id;
    }

    // Checklist dinâmica (snapshot).
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
        console.error('⚠️  criarTarefaEspontanea: erro ao injetar checklist:', chkErr.message);
      }
    }

    let dataFinalE = dataNormalizada;
    let avisoHorarioE = null;
    if (utilizadorValidado) {
      const hm = await horaDeAtribuicaoManual({
        utilizadorId: utilizadorValidado,
        data: dataNormalizada,
        tempo: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
        propriedade,
      });
      dataFinalE = hm.data;
      avisoHorarioE = hm.aviso;
    }

    const nova = await Tarefa.create({
      empresa_id: empresaId,
      propriedade_id,
      smoobu_reserva_id: null, // tarefa manual — sem reserva Smoobu
      origem: 'manual', // HF17 — origem manual
      utilizador_id: utilizadorValidado,
      data: dataFinalE,
      tempo_limpeza_minutos: Number(tempo_limpeza_minutos) || propriedade.tempo_limpeza_minutos || 45,
      tipo: tipoFinal,
      estado: utilizadorValidado ? 'atribuida' : 'por_atribuir',
      observacoes: observacoes ? String(observacoes).trim() : '',
      checklist: propriedade.checklist || [],
      ...(checklistDinamica.length > 0 ? { checklist_dinamica: checklistDinamica } : {}),
    });

    // Notifica o staff se foi atribuído.
    if (utilizadorValidado) {
      try {
        const tituloNotif = tipoFinal === 'manutencao'
          ? '🛠️ Nova Manutenção Atribuída'
          : '🧹 Nova Limpeza Atribuída';
        const corpoNotif = tipoFinal === 'manutencao'
          ? `Foste escalado para resolver uma avaria na ${propriedade.nome}.`
          : `Foste escalado para limpar a ${propriedade.nome}.`;
        notificarUtilizador(
          String(utilizadorValidado),
          tituloNotif,
          corpoNotif,
          '/staff',
          { criarInApp: true, tipo: 'tarefa_atribuida' }
        );
      } catch (e) {
        console.error('⚠️  notificar staff (espontanea):', e.message);
      }
    }

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Gestor',
      empresa_id: empresaId,
      acao: 'criar',
      recurso: 'tarefa',
      recurso_id: nova._id,
      descricao: `Tarefa espontânea criada para "${propriedade.nome}" (${dataNormalizada.toISOString().slice(0, 10)})`,
      detalhes: { origem: 'manual', utilizador_id: utilizadorValidado, observacoes: observacoes?.slice(0, 100) },
    });

    console.log(
      `🧹 [Espontânea] tarefa ${nova._id} criada (propriedade "${propriedade.nome}", ` +
        `data=${dataNormalizada.toISOString()}, estado=${nova.estado}` +
        (utilizadorValidado ? `, staff=${utilizadorValidado}` : ', por_atribuir') + ').'
    );

    return res.status(201).json({ tarefa: nova, ...(avisoHorarioE ? { aviso_horario: avisoHorarioE } : {}) });
  } catch (err) {
    console.error('❌ criarTarefaEspontanea:', err.message);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
