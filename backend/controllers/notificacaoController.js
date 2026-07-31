/**
 * Controlador de Notificações In-App — FisioCell
 *
 * Prompt 114 — Centro de Notificações In-App (O Sino).
 *
 * Endpoints (montados em /api/auth/me/notificacoes):
 *   GET   /                     — lista notificações do utilizador (query ?lidas=false)
 *   GET   /contagem             — count de não-lidas (para o badge do sino)
 *   PATCH /marcar-lidas         — marca TODAS como lidas
 *   PATCH /:id/lida             — marca UMA como lida
 *
 * Todas as rotas usam `auth` — o destinatário é sempre req.user.id.
 */

const Notificacao = require('../models/Notificacao');

/**
 * GET /api/auth/me/notificacoes
 *
 * Query opcional: ?lidas=false (default) — só não-lidas.
 *   ?lidas=true  — só lidas.
 *   (sem param)  — todas.
 *
 * Resposta 200: { notificacoes: [...], total: number, nao_lidas: number }
 */
exports.listarNotificacoes = async (req, res) => {
  try {
    const filtro = { utilizador_id: req.user.id };
    if (req.query.lidas === 'false') filtro.lida = false;
    if (req.query.lidas === 'true') filtro.lida = true;

    const [notificacoes, naoLidas] = await Promise.all([
      Notificacao.find(filtro).sort({ createdAt: -1 }).limit(50).lean(),
      Notificacao.countDocuments({ utilizador_id: req.user.id, lida: false }),
    ]);

    return res.status(200).json({
      notificacoes: notificacoes.map((n) => ({
        _id: String(n._id),
        mensagem: n.mensagem,
        tipo: n.tipo,
        url: n.url,
        lida: n.lida,
        data: n.createdAt || n.data,
      })),
      total: notificacoes.length,
      nao_lidas: naoLidas,
    });
  } catch (err) {
    console.error('❌ listarNotificacoes:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * GET /api/auth/me/notificacoes/contagem
 *
 * Devolve o número de notificações não-lidas (para o badge do sino).
 *
 * Resposta 200: { nao_lidas: number }
 */
exports.contagemNotificacoes = async (req, res) => {
  try {
    const nao_lidas = await Notificacao.countDocuments({
      utilizador_id: req.user.id,
      lida: false,
    });
    return res.status(200).json({ nao_lidas });
  } catch (err) {
    console.error('❌ contagemNotificacoes:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/auth/me/notificacoes/marcar-lidas
 *
 * Marca TODAS as notificações não-lidas do utilizador como lidas.
 *
 * Resposta 200: { message, marcadas: number }
 */
exports.marcarTodasLidas = async (req, res) => {
  try {
    const resultado = await Notificacao.updateMany(
      { utilizador_id: req.user.id, lida: false },
      { $set: { lida: true } }
    );
    return res.status(200).json({
      message: 'Notificações marcadas como lidas.',
      marcadas: resultado.modifiedCount,
    });
  } catch (err) {
    console.error('❌ marcarTodasLidas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/auth/me/notificacoes/:id/lida
 *
 * Marca UMA notificação como lida.
 *
 * Resposta 200: { notificacao }
 * Resposta 404: notificação não encontrada (ou não pertence ao utilizador)
 */
exports.marcarUmaLida = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notificacao.findOneAndUpdate(
      { _id: id, utilizador_id: req.user.id },
      { $set: { lida: true } },
      { new: true }
    ).lean();
    if (!notif) {
      return res.status(404).json({ erro: 'Notificação não encontrada.' });
    }
    return res.status(200).json({ notificacao: notif });
  } catch (err) {
    console.error('❌ marcarUmaLida:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
