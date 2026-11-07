/**
 * Oferta de vagas à equipa — All2gether.
 *
 * Quando uma limpeza (criada pelo Smoobu, por uma reserva do proprietário, por uma reatribuição...)
 * fica sem ninguém disponível, a vaga é OFERECIDA a toda a equipa da empresa que não esteja ausente
 * nesse dia. Fica com ela quem aceitar primeiro (operação atómica: compare-and-set).
 *
 * Estado na Tarefa (campos oferta_*):
 *   - oferta_estado: 'aberta' | 'aceite' | 'expirada' | 'fechada' | null
 *   - oferta_expira_em: prazo (o que vier primeiro: 18:00 de Lisboa da véspera, ou 2 h antes do início)
 *   - oferta_dia: dia (AAAA-MM-DD) a que a oferta se refere; se a limpeza mudar de dia, a oferta recomeça
 * A tarefa mantém o seu estado normal (por_atribuir/nao_atribuida): os ecrãs e contagens existentes
 * continuam a valer. Uma oferta só está VIVA enquanto 'aberta', dentro do prazo e enquanto faltar gente
 * (sem responsável, ou pessoas_em_falta > 0): se o gestor atribuir à mão, a oferta fecha-se sozinha.
 *
 * Nas equipas de 2+ pessoas aceita-se até preencher as vagas (a 1.ª pessoa fica responsável).
 * Ao aceitar recalcula-se a hora com o motor de horário; se ficar fora do horário, avisa-se a pessoa
 * e os gestores (aceita-se na mesma: é uma escolha da pessoa).
 *
 * Desligado nos testes (NODE_ENV=test) salvo OFERTA_VAGAS_TESTE=1; kill switch: OFERTA_VAGAS_DESLIGADA=1.
 */
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Ausencia = require('../models/Ausencia');
const Propriedade = require('../models/Propriedade');
const H = require('./horario');
const { idsEquipa } = require('./equipaTarefa');
const { notificarUtilizador, avisarGestores } = require('./notificar');
const { calcularInicioEquipa, obterRangeDia } = require('./scheduler');

const ANTECEDENCIA_MIN_MS = 2 * 60 * 60 * 1000; // a limpeza começa daqui a menos de 2 h: sem oferta
const HORA_LIMITE_VESPERA = 18 * 60; // 18:00 de Lisboa
const ESTADOS_SEM_PESSOA = ['por_atribuir', 'nao_atribuida'];

function ofertasAtivas() {
  if (process.env.OFERTA_VAGAS_DESLIGADA === '1') return false;
  return process.env.NODE_ENV !== 'test' || process.env.OFERTA_VAGAS_TESTE === '1';
}

const fmtDia = (diaISO) => diaISO.split('-').reverse().slice(0, 2).join('/');
const horaLisboa = (d) => H.hhmm(H.minutosLocais(new Date(d)));

/** Dia anterior de um 'aaaa-mm-dd'. */
function diaAnterior(diaISO) {
  const [y, m, d] = diaISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Início previsto: a hora da tarefa, ou as 09:00 locais se ainda não tem hora real. */
function inicioPrevisto(tarefa) {
  return H.temHoraReal(tarefa.data) ? new Date(tarefa.data) : H.utcDeMinutosLocais(H.diaUTC(tarefa.data), H.HORARIO.INICIO_DIA);
}

/**
 * Prazo da oferta: o que vier primeiro entre as 18:00 (Lisboa) da véspera e 2 h antes do início.
 * Devolve null se já não há tempo (a limpeza começa em menos de 2 h, ou o prazo já passou).
 */
function calcularPrazoOferta(tarefa, agora = new Date()) {
  const inicio = inicioPrevisto(tarefa);
  if (inicio.getTime() - agora.getTime() < ANTECEDENCIA_MIN_MS) return null;
  const vespera = H.utcDeMinutosLocais(diaAnterior(H.diaUTC(tarefa.data)), HORA_LIMITE_VESPERA);
  const duasHoras = new Date(inicio.getTime() - ANTECEDENCIA_MIN_MS);
  const prazo = new Date(Math.min(vespera.getTime(), duasHoras.getTime()));
  return prazo.getTime() - agora.getTime() > 60 * 1000 ? prazo : null;
}

/** Quantas pessoas ainda faltam nesta tarefa (0 = nada a oferecer). */
function vagasEmFalta(tarefa, staffNecessario = 1) {
  if (!tarefa || tarefa.tipo !== 'limpeza') return 0;
  if (ESTADOS_SEM_PESSOA.includes(tarefa.estado) && !tarefa.utilizador_id) return Math.max(1, Number(staffNecessario) || 1);
  if (tarefa.estado === 'atribuida' && tarefa.utilizador_id) return Math.max(0, Number(tarefa.pessoas_em_falta) || 0);
  return 0;
}

/** A oferta está viva agora? (para ecrãs e para aceitar) */
function ofertaViva(tarefa, staffNecessario = 1, agora = new Date()) {
  return !!tarefa
    && tarefa.oferta_estado === 'aberta'
    && !!tarefa.oferta_expira_em
    && new Date(tarefa.oferta_expira_em) > agora
    && tarefa.oferta_dia === H.diaUTC(tarefa.data)
    && vagasEmFalta(tarefa, staffNecessario) > 0;
}

/** Ids dos utilizadores da empresa que estão ausentes (aprovada/emergência) no dia. */
async function ausentesNoDia(ids, diaISO) {
  if (ids.length === 0) return new Set();
  const range = obterRangeDia(new Date(`${diaISO}T00:00:00Z`));
  const a = await Ausencia.find({
    utilizador_id: { $in: ids },
    estado: { $in: ['aprovada', 'pendente_emergencia'] },
    data_inicio: { $lt: range.end },
    data_fim: { $gte: range.start },
  }).distinct('utilizador_id');
  return new Set(a.map(String));
}

/** Staff da empresa que pode receber a oferta: ativo, não ausente nesse dia, não membro da tarefa. */
async function destinatariosDaOferta(tarefa, diaISO) {
  const staff = await Utilizador.find({ empresa_id: tarefa.empresa_id, role: 'staff', ativo: true, eliminado_em: null }).select('_id').lean();
  const membros = new Set(idsEquipa(tarefa));
  const candidatos = staff.map((s) => String(s._id)).filter((id) => !membros.has(id));
  const ausentes = await ausentesNoDia(candidatos, diaISO);
  return candidatos.filter((id) => !ausentes.has(id));
}

/**
 * Abre a oferta de uma tarefa, se aplicável. Idempotente (compare-and-set sobre oferta_estado) e
 * seguro com execuções simultâneas: só quem "ganhar" a abertura notifica.
 * @returns {Promise<{ aberta: boolean, motivo?: string, destinatarios?: number, expira_em?: Date }>}
 */
async function abrirOferta(tarefaId, agora = new Date()) {
  const t = await Tarefa.findById(tarefaId).lean();
  if (!t || t.tipo !== 'limpeza') return { aberta: false, motivo: 'nao_aplicavel' };
  const prop = await Propriedade.findById(t.propriedade_id).select('nome staff_necessario').lean();
  const falta = vagasEmFalta(t, prop && prop.staff_necessario);
  if (falta <= 0) return { aberta: false, motivo: 'sem_vaga' };
  const dia = H.diaUTC(t.data);
  if (t.oferta_estado === 'aberta' && t.oferta_dia === dia) return { aberta: false, motivo: 'ja_aberta' };
  if (t.oferta_estado === 'expirada' && t.oferta_dia === dia) return { aberta: false, motivo: 'ja_expirou' };

  const prazo = calcularPrazoOferta(t, agora);
  if (!prazo) {
    // Sem tempo para oferecer: marca para não voltar a tentar neste dia.
    await Tarefa.updateOne({ _id: t._id, oferta_estado: t.oferta_estado ?? null }, { $set: { oferta_estado: 'expirada', oferta_dia: dia, oferta_expira_em: null } });
    return { aberta: false, motivo: 'sem_tempo' };
  }

  // Quem ganha a abertura é quem consegue passar o estado a 'aberta' (as outras execuções param aqui).
  const r = await Tarefa.updateOne(
    { _id: t._id, oferta_estado: t.oferta_estado ?? null, estado: t.estado, utilizador_id: t.utilizador_id ?? null },
    { $set: { oferta_estado: 'aberta', oferta_aberta_em: agora, oferta_expira_em: prazo, oferta_dia: dia } }
  );
  if (r.modifiedCount !== 1) return { aberta: false, motivo: 'concorrencia' };

  const destinatarios = await destinatariosDaOferta(t, dia);
  const nomeCasa = (prop && prop.nome) || 'uma casa';
  if (destinatarios.length === 0) {
    await Tarefa.updateOne({ _id: t._id, oferta_estado: 'aberta' }, { $set: { oferta_estado: 'expirada' } });
    return { aberta: false, motivo: 'sem_destinatarios' };
  }
  for (const id of destinatarios) {
    await notificarUtilizador(id, '🧹 Limpeza livre', `Há uma limpeza livre em ${nomeCasa} no dia ${fmtDia(dia)}`, '/staff', {
      criarInApp: true,
      tipo: 'aviso',
      empresa_id: String(t.empresa_id),
      tarefa_id: String(t._id),
      chave: `vaga:${t._id}:${dia}`,
    });
  }
  await avisarGestores(
    t.empresa_id,
    'Vaga oferecida à equipa',
    `A limpeza de ${nomeCasa} (${fmtDia(dia)}) ficou sem ninguém disponível e foi oferecida à equipa até às ${horaLisboa(prazo)} (${fmtDia(H.diaUTC(prazo))}).`,
    '/gestor/tarefas',
    { chave: `vaga_oferecida:${t._id}:${dia}` }
  );
  return { aberta: true, destinatarios: destinatarios.length, expira_em: prazo };
}

/** Best-effort para os pontos de criação: nunca lança e respeita o interruptor. */
async function abrirOfertaMelhorEsforco(tarefaId) {
  try {
    if (!ofertasAtivas() || !tarefaId) return null;
    return await abrirOferta(tarefaId);
  } catch (e) {
    console.error('⚠️  abrirOferta:', e.message);
    return null;
  }
}

/** A limpeza mudou de dia (ou ficou outra vez sem ninguém): fecha a oferta antiga e reabre se couber. */
async function reabrirOferta(tarefaId) {
  try {
    if (!ofertasAtivas() || !tarefaId) return null;
    await Tarefa.updateOne({ _id: tarefaId, oferta_estado: 'aberta' }, { $set: { oferta_estado: 'fechada' } });
    return await abrirOferta(tarefaId);
  } catch (e) {
    console.error('⚠️  reabrirOferta:', e.message);
    return null;
  }
}

/**
 * Ofertas abertas que já não fazem sentido -> 'fechada' (cancelada, atribuída à mão, mudou de dia);
 * as que chegaram ao prazo sem ninguém -> 'expirada' e os gestores são avisados.
 */
async function expirarOfertas(agora = new Date()) {
  const abertas = await Tarefa.find({ oferta_estado: 'aberta' }).populate({ path: 'propriedade_id', select: 'nome staff_necessario' }).lean();
  let expiradas = 0;
  let fechadas = 0;
  for (const t of abertas) {
    const prop = t.propriedade_id || {};
    const falta = vagasEmFalta(t, prop.staff_necessario);
    const obsoleta = falta <= 0 || t.oferta_dia !== H.diaUTC(t.data) || ['cancelada', 'concluida', 'em_curso'].includes(t.estado);
    if (obsoleta) {
      const r = await Tarefa.updateOne({ _id: t._id, oferta_estado: 'aberta' }, { $set: { oferta_estado: falta <= 0 && t.utilizador_id ? 'aceite' : 'fechada' } });
      if (r.modifiedCount === 1) fechadas++;
      continue;
    }
    if (t.oferta_expira_em && new Date(t.oferta_expira_em) <= agora) {
      const r = await Tarefa.updateOne({ _id: t._id, oferta_estado: 'aberta' }, { $set: { oferta_estado: 'expirada' } });
      if (r.modifiedCount === 1) {
        expiradas++;
        await avisarGestores(
          t.empresa_id,
          'Ninguém aceitou a limpeza livre',
          `Ninguém aceitou a limpeza de ${prop.nome || 'uma casa'} (${fmtDia(t.oferta_dia)}). Continua por atribuir: atribui à mão.`,
          '/gestor/tarefas',
          { chave: `vaga_expirou:${t._id}:${t.oferta_dia}` }
        );
      }
    }
  }
  return { expiradas, fechadas };
}

/** Procura limpezas com vaga sem oferta e abre-as (rede de segurança para todos os pontos de criação). */
async function abrirOfertasPendentes(agora = new Date()) {
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const candidatas = await Tarefa.find({
    tipo: 'limpeza',
    data: { $gte: hoje },
    oferta_estado: { $ne: 'aberta' },
    // Já expirou neste mesmo dia: não volta a tentar.
    $expr: { $not: [{ $and: [{ $eq: ['$oferta_estado', 'expirada'] }, { $eq: ['$oferta_dia', { $dateToString: { format: '%Y-%m-%d', date: '$data' } }] }] }] },
    $or: [
      { estado: { $in: ESTADOS_SEM_PESSOA }, utilizador_id: null },
      { estado: 'atribuida', pessoas_em_falta: { $gt: 0 } },
    ],
  }).select('_id').limit(200).lean();
  let abertas = 0;
  for (const c of candidatas) {
    const r = await abrirOferta(c._id, agora).catch((e) => { console.error('⚠️  abrirOferta:', e.message); return null; });
    if (r && r.aberta) abertas++;
  }
  return { candidatas: candidatas.length, abertas };
}

/** Ofertas vivas que o utilizador pode aceitar (para o cartão «Limpeza livre»). */
async function listarOfertas(utilizador, agora = new Date()) {
  const tarefas = await Tarefa.find({
    empresa_id: utilizador.empresa_id,
    tipo: 'limpeza',
    oferta_estado: 'aberta',
    oferta_expira_em: { $gt: agora },
  })
    .select('propriedade_id data tempo_limpeza_minutos estado utilizador_id equipa_atribuida pessoas_em_falta oferta_estado oferta_expira_em oferta_dia tipo')
    .populate({ path: 'propriedade_id', select: 'nome morada staff_necessario' })
    .lean();
  const candidatas = tarefas.filter((t) => ofertaViva(t, t.propriedade_id && t.propriedade_id.staff_necessario, agora) && !idsEquipa(t).includes(String(utilizador.id)));
  const dias = [...new Set(candidatas.map((t) => t.oferta_dia))];
  const ausentePorDia = new Map();
  for (const d of dias) ausentePorDia.set(d, (await ausentesNoDia([utilizador.id], d)).has(String(utilizador.id)));
  return candidatas
    .filter((t) => !ausentePorDia.get(t.oferta_dia))
    .sort((a, b) => new Date(a.data) - new Date(b.data))
    .map((t) => ({
      _id: String(t._id),
      casa: (t.propriedade_id && t.propriedade_id.nome) || 'Casa',
      morada: (t.propriedade_id && t.propriedade_id.morada) || null,
      dia: t.oferta_dia,
      tempo_limpeza_minutos: t.tempo_limpeza_minutos,
      vagas: vagasEmFalta(t, t.propriedade_id && t.propriedade_id.staff_necessario),
      expira_em: new Date(t.oferta_expira_em).toISOString(),
    }));
}

class ErroOferta extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

const MSG_JA_ACEITE = 'Esta limpeza já foi aceite por outra pessoa.';

/**
 * Aceita uma vaga oferecida. Atómico: o filtro do findOneAndUpdate compara o estado visto
 * (responsável e pessoas em falta), por isso só uma pessoa fica com cada vaga. Lança ErroOferta.
 * @returns {Promise<{ tarefa: object, aviso: string|null }>}
 */
async function aceitarOferta({ tarefaId, utilizadorId, empresaId }) {
  const agora = new Date();
  const uid = String(utilizadorId);
  const t = await Tarefa.findOne({ _id: tarefaId, empresa_id: empresaId, tipo: 'limpeza' }).lean();
  if (!t) throw new ErroOferta(404, 'NAO_ENCONTRADA', 'Limpeza não encontrada.');
  const prop = await Propriedade.findById(t.propriedade_id).select('nome coordenadas staff_necessario').lean();
  const staffNec = Math.max(1, Number(prop && prop.staff_necessario) || 1);
  if (idsEquipa(t).includes(uid)) throw new ErroOferta(409, 'JA_TUA', 'Esta limpeza já é tua.');
  if (t.oferta_estado === 'aberta' && t.oferta_expira_em && new Date(t.oferta_expira_em) <= agora) {
    throw new ErroOferta(409, 'OFERTA_EXPIRADA', 'O prazo para aceitar esta limpeza terminou.');
  }
  if (!ofertaViva(t, staffNec, agora)) {
    throw new ErroOferta(409, t.oferta_estado === 'expirada' ? 'OFERTA_EXPIRADA' : 'JA_ACEITE', t.oferta_estado === 'expirada' ? 'O prazo para aceitar esta limpeza terminou.' : MSG_JA_ACEITE);
  }
  const dia = H.diaUTC(t.data);
  if ((await ausentesNoDia([uid], dia)).has(uid)) {
    throw new ErroOferta(409, 'AUSENTE', 'Estás ausente nesse dia.');
  }
  const user = await Utilizador.findOne({ _id: uid, empresa_id: empresaId, role: 'staff', ativo: true, eliminado_em: null }).select('nome').lean();
  if (!user) throw new ErroOferta(403, 'SEM_PERMISSAO', 'Só a equipa pode aceitar limpezas livres.');

  const primeira = !t.utilizador_id;
  const emFaltaAntes = primeira ? staffNec : Number(t.pessoas_em_falta) || 0;
  const membros = idsEquipa(t);
  const faltaDepois = emFaltaAntes - 1;
  const filtro = {
    _id: t._id,
    empresa_id: empresaId,
    oferta_estado: 'aberta',
    oferta_expira_em: { $gt: agora },
    ...(primeira
      ? { estado: { $in: ESTADOS_SEM_PESSOA }, utilizador_id: null }
      : { estado: 'atribuida', utilizador_id: t.utilizador_id, pessoas_em_falta: emFaltaAntes }),
  };
  const set = primeira
    ? {
        utilizador_id: uid,
        equipa_atribuida: staffNec > 1 ? [uid] : [],
        estado: 'atribuida',
        pessoas_em_falta: faltaDepois,
        motivo_nao_atribuicao: null,
        alerta: null,
      }
    : { equipa_atribuida: [...membros, uid], pessoas_em_falta: faltaDepois };
  if (faltaDepois <= 0) set.oferta_estado = 'aceite';
  const atualizada = await Tarefa.findOneAndUpdate(filtro, { $set: set }, { new: true });
  if (!atualizada) throw new ErroOferta(409, 'JA_ACEITE', MSG_JA_ACEITE);

  // Recalcula a hora com o motor de horário; fora do horário aceita-se na mesma, com aviso.
  let aviso = null;
  try {
    const range = obterRangeDia(atualizada.data);
    const tempo = Number(atualizada.tempo_limpeza_minutos) || 45;
    if (primeira) {
      const r = await calcularInicioEquipa([uid], range.start, prop.coordenadas, tempo, atualizada._id, prop._id);
      if (r.cabe) {
        await Tarefa.updateOne({ _id: atualizada._id }, { $set: { data: r.data, tempo_viagem_minutos: Number(r.tempoViagem) || 0 } });
      } else {
        const ini = H.utcDeMinutosLocais(dia, H.HORARIO.INICIO_DIA);
        await Tarefa.updateOne({ _id: atualizada._id }, { $set: { data: ini } });
        aviso = `fica fora do teu horário normal (${r.motivo || 'não cabe na tua agenda'}). Marcámos o início para as ${horaLisboa(ini)}.`;
      }
    } else {
      const { cabeNaAgendaNaHora } = require('./atribuicaoAutomatica');
      if (H.temHoraReal(atualizada.data) && !(await cabeNaAgendaNaHora(uid, atualizada.data, tempo, atualizada._id, prop.coordenadas, prop._id))) {
        aviso = `fica fora do teu horário normal (a hora da equipa, ${horaLisboa(atualizada.data)}, não cabe na tua agenda).`;
      }
    }
  } catch (e) {
    console.error('⚠️  aceitarOferta (hora):', e.message);
  }

  const final = await Tarefa.findById(atualizada._id).lean();
  await avisarGestores(
    empresaId,
    'Limpeza livre aceite',
    `${user.nome} aceitou a limpeza de ${prop.nome} (${fmtDia(dia)})${faltaDepois > 0 ? `; ainda falta${faltaDepois > 1 ? 'm' : ''} ${faltaDepois}` : ''}${aviso ? ` — atenção: ${aviso}` : ''}.`,
    '/gestor/tarefas'
  );
  return { tarefa: final, aviso };
}

module.exports = {
  ofertasAtivas,
  calcularPrazoOferta,
  vagasEmFalta,
  ofertaViva,
  abrirOferta,
  abrirOfertaMelhorEsforco,
  reabrirOferta,
  expirarOfertas,
  abrirOfertasPendentes,
  listarOfertas,
  aceitarOferta,
  ErroOferta,
};
