/**
 * Mudança do «Tempo base» (ou tempo por tipo) e das «Pessoas necessárias» de uma casa
 * aplicada às limpezas dessa casa que ainda não começaram (de hoje em diante).
 *
 * Regras (decisão do utilizador, 2026-11-09):
 *   - Só limpezas (tipo 'limpeza') por_atribuir / nao_atribuida / atribuida, sem início.
 *   - O tempo só muda nas limpezas que seguiam o valor antigo da casa para o seu tipo
 *     (um tempo posto à mão numa limpeza, ou um atraso reportado, não é apagado).
 *   - Atribuídas: a equipa mantém-se se couber; senão procura outra hora para a mesma
 *     equipa; senão o motor atribui de novo. Com mais pessoas preenche as vagas; com
 *     menos, saem as últimas (o responsável fica). Quem sai ou vê a limpeza mudar é avisado.
 *   - Sem equipa (e não desatribuída à mão): o motor volta a tentar.
 * Best-effort: nunca lança. Serializado com o preenchimento de vagas (mesmo lock).
 */

const Tarefa = require('../models/Tarefa');
const H = require('./horario');
const { tempoDoTipo, tipoDe } = require('./tipoLimpeza');
const { idsEquipa, normalizarEquipa } = require('./equipaTarefa');
const { calcularInicioEquipa, obterRangeDia } = require('./scheduler');
const { cabeNaAgendaNaHora, preencherVagaTarefa, atribuirTarefaEmFalta } = require('./atribuicaoAutomatica');

const ESTADOS = ['por_atribuir', 'nao_atribuida', 'atribuida'];

/** Houve mudança que interessa às limpezas? (tempo base, tempos por tipo ou pessoas) */
function mudouConfig(antes, depois) {
  const tipos = ['normal', 'intermedia', 'profunda', 'preparacao'];
  const tempo = tipos.some((t) => tempoDoTipo(antes, t) !== tempoDoTipo(depois, t));
  const pessoas = (Number(antes.staff_necessario) || 1) !== (Number(depois.staff_necessario) || 1);
  return { tempo, pessoas, algo: tempo || pessoas };
}

async function cabeEquipaNaHora(ids, t, tempo, prop) {
  for (const m of ids) {
    if (!(await cabeNaAgendaNaHora(m, t.data, tempo, t._id, prop.coordenadas, prop._id))) return false;
  }
  return true;
}

/**
 * @param {object} p
 * @param {*} p.empresaId
 * @param {object} p.antes  - valores da casa antes de gravar (tempo_limpeza_minutos, tempos_limpeza_por_tipo, staff_necessario)
 * @param {object} p.propriedade - casa já gravada (documento ou lean, com _id, nome, coordenadas)
 * @returns {Promise<{ atualizadas: number, sem_equipa: number, erro?: string }>}
 */
async function aplicarConfigCasaNasLimpezas({ empresaId, antes, propriedade }) {
  const out = { atualizadas: 0, sem_equipa: 0 };
  const mud = mudouConfig(antes, propriedade);
  if (!mud.algo) return out;

  const { obterLock, libertarLock, renovarLock } = require('./lockEmpresa');
  const chave = `vagas:${empresaId}`;
  let dono = null;
  const avisos = new Map(); // pessoa -> [textos]
  const avisar = (id, txt) => avisos.set(String(id), [...(avisos.get(String(id)) || []), txt]);
  try {
    dono = await obterLock(chave, { ttlMs: 60000, esperaMs: 8000 });
    if (!dono) return { ...out, erro: 'ocupado' };

    const prop = {
      _id: propriedade._id,
      nome: propriedade.nome,
      coordenadas: propriedade.coordenadas,
      staff_necessario: propriedade.staff_necessario,
      tempo_limpeza_minutos: propriedade.tempo_limpeza_minutos,
    };
    const staffNec = Math.max(1, Number(propriedade.staff_necessario) || 1);
    const agora = new Date();
    const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      propriedade_id: propriedade._id,
      tipo: 'limpeza',
      estado: { $in: ESTADOS },
      iniciada_em: null,
      data: { $gte: hoje },
    }).sort({ data: 1 });

    for (let i = 0; i < tarefas.length; i++) {
      const t = tarefas[i];
      if (i > 0 && i % 20 === 0) await renovarLock(chave, dono, 60000);
      try {
        const tipo = tipoDe(t);
        const tempoAntigo = tempoDoTipo(antes, tipo);
        const tempoNovo = tempoDoTipo(propriedade, tipo);
        const segueCasa = Number(t.tempo_limpeza_minutos) === tempoAntigo;
        const tempo = segueCasa ? tempoNovo : Number(t.tempo_limpeza_minutos) || tempoNovo;
        const tempoMudou = tempo !== Number(t.tempo_limpeza_minutos);
        const dataTxt = new Date(t.data).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
        const membros = idsEquipa(t);

        if (t.estado !== 'atribuida' || membros.length === 0) {
          // Sem equipa: grava o tempo e, se não foi desatribuída à mão, o motor volta a tentar.
          if (tempoMudou) t.tempo_limpeza_minutos = tempo;
          if (tempoMudou) { await t.save(); out.atualizadas++; }
          if (!t.desatribuida_manual && (mud.pessoas || tempoMudou)) {
            const lean = { ...t.toObject(), propriedade_id: prop };
            const d = new Date(t.data);
            const r = await atribuirTarefaEmFalta(lean, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
            if (r.resultado === 'atribuida') {
              if (!tempoMudou) out.atualizadas++;
              for (const id of r.novos) avisar(id, `nova limpeza a ${dataTxt}`);
            } else out.sem_equipa++;
          }
          continue;
        }

        if (!tempoMudou && membros.length === staffNec && !(Number(t.pessoas_em_falta) > 0 && mud.pessoas)) continue;

        // Com menos pessoas: saem as últimas (o responsável fica).
        const ficam = membros.slice(0, staffNec);
        const saem = membros.slice(staffNec);
        let data = t.data;
        let viagem = t.tempo_viagem_minutos;
        let cabe = true;
        // Só um tempo maior pode deixar de caber na hora marcada.
        if (tempo > Number(t.tempo_limpeza_minutos) && H.temHoraReal(t.data)) {
          cabe = await cabeEquipaNaHora(ficam, t, tempo, prop);
          if (!cabe) {
            const s = await calcularInicioEquipa(ficam, obterRangeDia(t.data).start, prop.coordenadas, tempo, t._id, prop._id);
            if (s.cabe) { cabe = true; data = s.data; viagem = Number(s.tempoViagem) || 0; }
          }
        }

        if (!cabe) {
          // A equipa não tem hora para a limpeza mais longa: o motor atribui de novo.
          t.tempo_limpeza_minutos = tempo;
          t.utilizador_id = null;
          t.equipa_atribuida = [];
          t.pessoas_em_falta = 0;
          t.estado = 'por_atribuir';
          await t.save();
          const d = new Date(t.data);
          const r = await atribuirTarefaEmFalta({ ...t.toObject(), propriedade_id: prop }, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
          const novos = (r.novos || []).map(String);
          for (const m of membros) if (!novos.includes(m)) avisar(m, `saíste da limpeza de ${dataTxt} (passou a ${tempo} min e já não cabia no teu dia)`);
          for (const m of novos) if (!membros.includes(m)) avisar(m, `nova limpeza a ${dataTxt}`);
          if (r.resultado !== 'atribuida') out.sem_equipa++;
          out.atualizadas++;
          continue;
        }

        const eq = normalizarEquipa(ficam[0], ficam);
        const horaMudou = new Date(data).getTime() !== new Date(t.data).getTime();
        t.tempo_limpeza_minutos = tempo;
        t.data = data;
        t.tempo_viagem_minutos = viagem;
        t.utilizador_id = eq.utilizador_id;
        t.equipa_atribuida = eq.equipa_atribuida;
        t.pessoas_em_falta = Math.max(0, staffNec - ficam.length);
        await t.save();
        out.atualizadas++;
        for (const m of saem) avisar(m, `saíste da limpeza de ${dataTxt} (a casa passou a precisar de ${staffNec} ${staffNec === 1 ? 'pessoa' : 'pessoas'})`);
        if (tempoMudou || horaMudou) {
          const hora = horaMudou && H.temHoraReal(data) ? ` às ${H.hhmm(H.minutosLocais(data))}` : '';
          for (const m of ficam) avisar(m, `limpeza de ${dataTxt} passou a ${tempo} min${hora}`);
        }
        if (t.pessoas_em_falta > 0) {
          const v = await preencherVagaTarefa({ empresaId, tarefa: t.toObject(), propriedade: prop });
          for (const id of v.novos) avisar(id, `nova limpeza a ${dataTxt}`);
        }
      } catch (e) {
        console.error(`⚠️  [configCasaNasLimpezas] tarefa ${t._id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('⚠️  [configCasaNasLimpezas] falhou (best-effort):', err.message);
    return { ...out, erro: err.message };
  } finally {
    if (dono) await libertarLock(chave, dono);
  }

  try {
    const { notificarUtilizador } = require('./notificar');
    for (const [id, txts] of avisos) {
      await notificarUtilizador(
        id,
        '🧹 Limpezas atualizadas',
        `${propriedade.nome}: ${txts.join('; ')}.`,
        '/staff',
        { tipo: 'tarefa_reatribuida', empresa_id: String(empresaId), criarInApp: true }
      );
    }
  } catch (e) {
    console.error('⚠️  [configCasaNasLimpezas] notificar:', e.message);
  }
  return out;
}

/** Igual, mas devolve em `limiteMs` no máximo (o resto continua em segundo plano). */
async function aplicarConfigCasaComPrazo(args, limiteMs = 10000) {
  const trabalho = aplicarConfigCasaNasLimpezas(args).catch((e) => ({ atualizadas: 0, sem_equipa: 0, erro: e.message }));
  let timer;
  const prazo = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ atualizadas: 0, sem_equipa: 0, em_segundo_plano: true }), limiteMs);
    if (timer.unref) timer.unref();
  });
  const r = await Promise.race([trabalho, prazo]);
  clearTimeout(timer);
  return r;
}

module.exports = { aplicarConfigCasaNasLimpezas, aplicarConfigCasaComPrazo, mudouConfig };
