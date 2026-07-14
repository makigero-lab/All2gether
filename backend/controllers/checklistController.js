/**
 * Controlador de Modelos de Checklist — Autocell
 *
 * Prompt 133 — Sistema de Checklists Dinâmicas baseadas em Templates.
 *
 * CRUD completo em /api/gestor/checklists:
 *   GET    /            — lista todos os modelos da empresa
 *   POST   /            — cria um novo modelo
 *   GET    /:id         — devolve um modelo específico
 *   PUT    /:id         — atualiza um modelo
 *   DELETE /:id         — apaga um modelo
 */

const mongoose = require('mongoose');
const ModeloChecklist = require('../models/ModeloChecklist');
const { obterEmpresaId } = require('./gestorController');

// GET /api/gestor/checklists
exports.listarModelos = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const modelos = await ModeloChecklist.find({ empresa_id: empresaId })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ modelos });
  } catch (err) {
    console.error('❌ listarModelos:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

// POST /api/gestor/checklists
exports.criarModelo = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { nome, descricao, seccoes } = req.body || {};

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Nome é obrigatório.' });
    }

    if (!Array.isArray(seccoes) || seccoes.length === 0) {
      return res.status(400).json({ erro: 'Pelo menos uma secção é obrigatória.' });
    }

    // Valida estrutura das secções.
    for (const sec of seccoes) {
      if (!sec.nome || !String(sec.nome).trim()) {
        return res.status(400).json({ erro: 'Cada secção deve ter um nome.' });
      }
      if (!Array.isArray(sec.items) || sec.items.length === 0) {
        return res.status(400).json({ erro: `Secção "${sec.nome}" deve ter pelo menos um item.` });
      }
    }

    const novo = await ModeloChecklist.create({
      empresa_id: empresaId,
      nome: String(nome).trim(),
      descricao: descricao ? String(descricao).trim() : '',
      seccoes: seccoes.map((sec) => ({
        nome: String(sec.nome).trim(),
        items: sec.items.map((item) => String(item).trim()).filter(Boolean),
      })),
    });

    return res.status(201).json({ modelo: novo });
  } catch (err) {
    console.error('❌ criarModelo:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

// GET /api/gestor/checklists/:id
exports.obterModelo = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }

    const modelo = await ModeloChecklist.findOne({ _id: id, empresa_id: empresaId }).lean();
    if (!modelo) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    return res.status(200).json({ modelo });
  } catch (err) {
    console.error('❌ obterModelo:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

// PUT /api/gestor/checklists/:id
exports.atualizarModelo = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }

    const { nome, descricao, seccoes } = req.body || {};

    const update = {};
    if (nome !== undefined) update.nome = String(nome).trim();
    if (descricao !== undefined) update.descricao = String(descricao).trim();
    if (seccoes !== undefined) {
      if (!Array.isArray(seccoes)) {
        return res.status(400).json({ erro: 'Secções deve ser um array.' });
      }
      update.seccoes = seccoes.map((sec) => ({
        nome: String(sec.nome).trim(),
        items: Array.isArray(sec.items) ? sec.items.map((i) => String(i).trim()).filter(Boolean) : [],
      }));
    }

    const modelo = await ModeloChecklist.findOneAndUpdate(
      { _id: id, empresa_id: empresaId },
      { $set: update },
      { new: true }
    ).lean();

    if (!modelo) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    return res.status(200).json({ modelo });
  } catch (err) {
    console.error('❌ atualizarModelo:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

// DELETE /api/gestor/checklists/:id
exports.apagarModelo = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }

    const resultado = await ModeloChecklist.deleteOne({ _id: id, empresa_id: empresaId });
    if (resultado.deletedCount === 0) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    return res.status(200).json({ message: 'Modelo apagado com sucesso.' });
  } catch (err) {
    console.error('❌ apagarModelo:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
