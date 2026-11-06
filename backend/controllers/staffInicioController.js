/**
 * Staff — início da limpeza (All2gether)
 *
 *   PATCH /api/staff/tarefas/:id/iniciar        — «Comecei»
 *   POST  /api/staff/tarefas/:id/nao-consegui   — «Não consegui começar»
 *
 * O início é HÍBRIDO: o botão grava `inicio_origem: 'botao'`; sem clique, o job
 * `jobs/inicioLimpeza.js` faz o mesmo à hora marcada com `inicio_origem: 'automatico'`.
 */
const mongoose = require('mongoose');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const { avisarGestores } = require('../utils/notificar');
const { comMembro } = require('../utils/equipaTarefa');
const { horaLisboa } = require('../utils/cicloTarefa');

/**
 * O staff diz que começou: 'atribuida' -> 'em_curso', grava `iniciada_em` e `inicio_origem: 'botao'`.
 * Atómico e idempotente: um segundo clique (ou o colega da equipa) devolve 200 com
 * `ja_iniciada: true` sem alterar nada. Só no próprio dia da limpeza.
 */
exports.iniciarTarefa = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) return res.status(401).json({ erro: 'Não autenticado.' });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID de tarefa inválido.' });

    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada (ou não te está atribuída).' });
    if (tarefa.estado === 'concluida') return res.status(400).json({ erro: 'Esta tarefa já está concluída.' });
    if (tarefa.estado === 'cancelada') return res.status(400).json({ erro: 'Esta tarefa foi cancelada.' });
    if (tarefa.estado === 'em_curso') return res.status(200).json({ tarefa, ja_iniciada: true });
    if (tarefa.estado !== 'atribuida') {
      return res.status(400).json({ erro: 'Só podes começar uma tarefa que te esteja atribuída.' });
    }

    const agora = new Date();
    const hojeUTC = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());
    const d = new Date(tarefa.data);
    const diaTarefa = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (diaTarefa > hojeUTC) {
      return res.status(400).json({ erro: 'Só podes começar uma limpeza no próprio dia.' });
    }

    const atualizada = await Tarefa.findOneAndUpdate(
      comMembro({ _id: id, estado: 'atribuida' }, utilizadorId),
      {
        $set: { estado: 'em_curso', iniciada_em: agora, inicio_origem: 'botao', iniciada_por: utilizadorId },
        $unset: { nao_consegui_comecar: '' },
      },
      { new: true }
    );
    if (!atualizada) {
      // Perdeu a corrida (colega ou job): devolve o estado atual.
      const atual = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));
      return res.status(200).json({ tarefa: atual, ja_iniciada: true });
    }
    return res.status(200).json({ tarefa: atualizada, ja_iniciada: false });
  } catch (err) {
    console.error('❌ iniciarTarefa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

const MOTIVOS_NAO_CONSEGUI = {
  hospede_na_casa: 'hóspede ainda na casa',
  sem_acesso: 'sem acesso',
  casa_diferente: 'a casa não está como esperado',
};
exports.MOTIVOS_NAO_CONSEGUI = MOTIVOS_NAO_CONSEGUI;

/**
 * Body: { motivo: 'hospede_na_casa'|'sem_acesso'|'casa_diferente', nota?: string }
 * Regista no `alerta` da tarefa, guarda `nao_consegui_comecar` e avisa os gestores. Se o início
 * tinha sido automático, a limpeza volta a 'atribuida' (o job não a volta a iniciar). Se o
 * staff já carregou em «Comecei», recusa.
 */
exports.naoConseguiComecar = async (req, res) => {
  try {
    const utilizadorId = req.user && req.user.id;
    if (!utilizadorId) return res.status(401).json({ erro: 'Não autenticado.' });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ erro: 'ID de tarefa inválido.' });

    const motivo = req.body && req.body.motivo;
    if (typeof motivo !== 'string' || !Object.prototype.hasOwnProperty.call(MOTIVOS_NAO_CONSEGUI, motivo)) {
      return res.status(400).json({ erro: 'Escolhe um dos motivos indicados.' });
    }
    let nota = req.body && req.body.nota;
    if (nota !== undefined && nota !== null && typeof nota !== 'string') {
      return res.status(400).json({ erro: 'Nota inválida.' });
    }
    nota = String(nota || '').trim();
    if (nota.length > 500) return res.status(400).json({ erro: 'A nota pode ter no máximo 500 caracteres.' });

    const tarefa = await Tarefa.findOne(comMembro({ _id: id }, utilizadorId));
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada (ou não te está atribuída).' });
    if (['concluida', 'cancelada'].includes(tarefa.estado)) {
      return res.status(400).json({ erro: 'Esta tarefa já não está ativa.' });
    }
    if (tarefa.estado === 'em_curso' && tarefa.inicio_origem === 'botao') {
      return res.status(400).json({ erro: 'Já carregaste em «Comecei» nesta limpeza.' });
    }

    const [utilizador, propriedade] = await Promise.all([
      Utilizador.findById(utilizadorId).select('nome').lean(),
      Propriedade.findById(tarefa.propriedade_id).select('nome').lean(),
    ]);
    const agora = new Date();
    const quem = (utilizador && utilizador.nome) || 'O staff';
    const linha = `${quem} não conseguiu começar às ${horaLisboa(agora)}: ${MOTIVOS_NAO_CONSEGUI[motivo]}${nota ? ` (${nota})` : ''}`;
    const alerta = [tarefa.alerta, linha].filter(Boolean).join(' | ').slice(0, 1000);

    const set = { alerta, nao_consegui_comecar: { motivo, nota, em: agora, por: utilizadorId } };
    // Início automático: era só uma presunção; volta a «atribuida».
    if (tarefa.estado === 'em_curso' && tarefa.inicio_origem === 'automatico') {
      set.estado = 'atribuida';
      set.iniciada_em = null;
      set.inicio_origem = null;
      set.iniciada_por = null;
    }
    const atualizada = await Tarefa.findOneAndUpdate(
      comMembro({ _id: id, estado: { $in: ['atribuida', 'em_curso'] } }, utilizadorId),
      { $set: set },
      { new: true }
    );
    if (!atualizada) return res.status(400).json({ erro: 'Esta tarefa já não está ativa.' });

    await avisarGestores(
      tarefa.empresa_id,
      '🚧 Limpeza sem arrancar',
      `${(propriedade && propriedade.nome) || 'Casa'}: ${linha}`,
      '/gestor/tarefas',
      { chave: `nao_consegui:${tarefa._id}:${utilizadorId}:${motivo}` }
    );
    return res.status(200).json({ tarefa: atualizada });
  } catch (err) {
    console.error('❌ naoConseguiComecar:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
