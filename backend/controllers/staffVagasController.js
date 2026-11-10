/**
 * Limpezas livres (vagas oferecidas à equipa) — rotas do staff.
 *   GET  /api/staff/vagas-livres                 -> { vagas: [...] }
 *   POST /api/staff/vagas-livres/:id/aceitar     -> { tarefa, aviso }
 * A lógica vive em utils/ofertaVaga.js.
 */
const mongoose = require('mongoose');
const { listarOfertas, aceitarOferta, ErroOferta } = require('../utils/ofertaVaga');

exports.listarVagasLivres = async (req, res) => {
  try {
    const { id, empresa_id: empresaId } = req.user || {};
    if (!id || !empresaId) return res.status(401).json({ erro: 'Não autenticado.' });
    const vagas = await listarOfertas({ id, empresa_id: empresaId });
    return res.status(200).json({ vagas });
  } catch (err) {
    console.error('❌ listarVagasLivres:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

exports.aceitarVagaLivre = async (req, res) => {
  try {
    const { id: utilizadorId, empresa_id: empresaId } = req.user || {};
    if (!utilizadorId || !empresaId) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ erro: 'ID de tarefa inválido.' });
    const r = await aceitarOferta({ tarefaId: req.params.id, utilizadorId, empresaId });
    return res.status(200).json({ tarefa: r.tarefa, aviso: r.aviso });
  } catch (err) {
    if (err instanceof ErroOferta) return res.status(err.status).json({ erro: err.message, codigo: err.codigo });
    console.error('❌ aceitarVagaLivre:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
