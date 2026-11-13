/**
 * Reservas dos proprietários marcadas pelo gestor — All2gether.
 *
 * O gestor marca, altera e apaga reservas EM NOME de um proprietário da sua empresa, com a mesma tabela
 * que o proprietário tem. Usa os mesmos serviços (utils/reservasParceiro.js): cria as mesmas limpezas,
 * ofertas, avisos e regras de casa ativa. A reserva fica a ser uma reserva NORMAL do proprietário
 * (criada_pelo_gestor: true); o proprietário recebe um aviso no sino e o gestor não recebe o das 48 h.
 *
 * Rotas (prefixo /api/gestor/parceiros/:id, auth + isGestor), sempre limitadas à empresa do gestor:
 *   GET    /propriedades          casas ativas do proprietário
 *   GET    /reservas              reservas + limpezas da gestão (só leitura)
 *   POST   /reservas              marcar reserva
 *   PUT    /reservas/:reservaId   alterar
 *   DELETE /reservas/:reservaId   apagar
 */
const mongoose = require('mongoose');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const R = require('../utils/reservasParceiro');

const enviar = (res, r) => res.status(r.status).json(r.body);

/** Carrega o proprietário SÓ se for da empresa do gestor (senão responde 404 e devolve null). */
async function proprietarioDaEmpresa(req, res) {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId || !mongoose.isValidObjectId(empresaId)) {
    res.status(400).json({ erro: 'empresa_id em falta ou inválido no token.' });
    return null;
  }
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ erro: 'ID de proprietário inválido.' });
    return null;
  }
  const p = await Utilizador.findOne({ _id: id, empresa_id: empresaId, role: 'parceiro', eliminado_em: null })
    .select('_id nome ativo empresa_id').lean();
  if (!p) {
    res.status(404).json({ erro: 'Proprietário não encontrado.' });
    return null;
  }
  return { proprietario: p, empresaId };
}

const atorGestor = (req) => ({ tipo: 'gestor', id: req.user.id, nome: req.user.nome || null });

async function listarPropriedades(req, res) {
  try {
    const ctx = await proprietarioDaEmpresa(req, res);
    if (!ctx) return;
    const propriedades = await Propriedade.find({ parceiro_id: ctx.proprietario._id, empresa_id: ctx.empresaId, ativo: true })
      .select('nome morada coordenadas tempo_limpeza_minutos capacidade_hospedes origem smoobu_id').lean();
    return res.status(200).json({ propriedades, proprietario: { _id: ctx.proprietario._id, nome: ctx.proprietario.nome, ativo: ctx.proprietario.ativo !== false } });
  } catch (err) {
    console.error('❌ gestorReservas.listarPropriedades:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

async function listarReservas(req, res) {
  try {
    const ctx = await proprietarioDaEmpresa(req, res);
    if (!ctx) return;
    return enviar(res, await R.listarReservasServico(ctx.proprietario._id));
  } catch (err) {
    console.error('❌ gestorReservas.listarReservas:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

async function criarReserva(req, res) {
  try {
    const ctx = await proprietarioDaEmpresa(req, res);
    if (!ctx) return;
    return enviar(res, await R.criarReservaComLimpeza({
      parceiroId: ctx.proprietario._id, empresaId: ctx.empresaId, body: req.body, ator: atorGestor(req),
    }));
  } catch (err) {
    console.error('❌ gestorReservas.criarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

async function atualizarReserva(req, res) {
  try {
    const ctx = await proprietarioDaEmpresa(req, res);
    if (!ctx) return;
    return enviar(res, await R.atualizarReservaServico({
      parceiroId: ctx.proprietario._id, id: req.params.reservaId, body: req.body, ator: atorGestor(req),
    }));
  } catch (err) {
    console.error('❌ gestorReservas.atualizarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

async function eliminarReserva(req, res) {
  try {
    const ctx = await proprietarioDaEmpresa(req, res);
    if (!ctx) return;
    return enviar(res, await R.eliminarReservaServico({
      parceiroId: ctx.proprietario._id, id: req.params.reservaId, ator: atorGestor(req),
    }));
  } catch (err) {
    console.error('❌ gestorReservas.eliminarReserva:', err.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
}

module.exports = { listarPropriedades, listarReservas, criarReserva, atualizarReserva, eliminarReserva };
