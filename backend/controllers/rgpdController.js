/**
 * RGPD — exportação e apagamento (acordo de subcontratação, art. 28.º, n.º 3, al. e) e g)).
 *
 * Por pessoa:
 *   GET  /api/auth/me/exportar-dados                    — o próprio descarrega os seus dados
 *   GET  /api/gestor/equipa/:id/exportar-dados          — gestor/admin da empresa (404 se for de outra)
 *   POST /api/gestor/equipa/:id/apagar-dados-pessoais   — body { confirmar: "APAGAR" }
 * Por empresa (só Super Admin):
 *   GET  /api/admin/empresas/:id/exportar
 *   POST /api/admin/empresas/:id/agendar-eliminacao     — body { confirmar: "<nome exato>", dias? }
 *   POST /api/admin/empresas/:id/cancelar-eliminacao
 *
 * A auditoria regista quem pediu e o quê, nunca os dados.
 */
const mongoose = require('mongoose');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const { registarAuditoria } = require('../utils/auditoria');
const { exportarDadosPessoa, apagarDadosPessoa, jaAnonimizada } = require('../utils/rgpdPessoa');
const rgpdEmpresa = require('../utils/rgpdEmpresa');

const hoje = () => new Date().toISOString().slice(0, 10);

async function nomeDe(req) {
  try {
    const u = await Utilizador.findById(req.user.id).select('nome').lean();
    return (u && u.nome) || 'Utilizador';
  } catch {
    return 'Utilizador';
  }
}

function enviarJson(res, nomeFicheiro, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeFicheiro}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify(corpo, null, 2));
}

/* ------------------------------------------------------------------ */
/* Por pessoa                                                          */
/* ------------------------------------------------------------------ */

exports.exportarMeusDados = async (req, res) => {
  try {
    if (req.user.impersonado_por) {
      return res.status(403).json({ erro: 'Não é possível exportar dados pessoais numa sessão de suporte.' });
    }
    if (!mongoose.isValidObjectId(req.user.id)) return res.status(400).json({ erro: 'Sessão inválida.' });
    const u = await Utilizador.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ erro: 'Utilizador não encontrado.' });
    const dados = await exportarDadosPessoa(u);
    registarAuditoria({
      utilizador_id: u._id, utilizador_nome: u.nome, empresa_id: u.empresa_id,
      acao: 'rgpd_exportar', recurso: 'utilizador', recurso_id: u._id,
      descricao: 'Exportação dos próprios dados pessoais.',
    });
    return enviarJson(res, `os-meus-dados-${hoje()}.json`, dados);
  } catch (err) {
    console.error('❌ exportarMeusDados:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/** Carrega a pessoa da empresa do pedido (404 se não existir ou for de outra empresa). */
async function pessoaDaEmpresa(req, res) {
  const empresaId = req.user && req.user.empresa_id;
  if (!empresaId || !mongoose.isValidObjectId(empresaId)) {
    res.status(400).json({ erro: 'empresa_id em falta ou inválido no token.' });
    return null;
  }
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ erro: 'ID de utilizador inválido.' });
    return null;
  }
  const u = await Utilizador.findOne({ _id: id, empresa_id: empresaId }).lean();
  if (!u) {
    res.status(404).json({ erro: 'Utilizador não encontrado (ou não pertence a esta empresa).' });
    return null;
  }
  return u;
}

exports.exportarDadosMembro = async (req, res) => {
  try {
    const u = await pessoaDaEmpresa(req, res);
    if (!u) return;
    const dados = await exportarDadosPessoa(u, { limitarAuditoriaAEmpresa: true });
    registarAuditoria({
      utilizador_id: req.user.id, utilizador_nome: await nomeDe(req), empresa_id: req.user.empresa_id,
      acao: 'rgpd_exportar', recurso: 'utilizador', recurso_id: u._id,
      descricao: 'Exportação de dados pessoais de um membro da empresa.',
      detalhes: req.user.impersonado_por ? { impersonado_por: String(req.user.impersonado_por) } : {},
    });
    return enviarJson(res, `dados-pessoais-${String(u._id)}-${hoje()}.json`, dados);
  } catch (err) {
    console.error('❌ exportarDadosMembro:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

exports.apagarDadosMembro = async (req, res) => {
  try {
    const u = await pessoaDaEmpresa(req, res);
    if (!u) return;
    const empresaId = req.user.empresa_id;

    if (String(u._id) === String(req.user.id)) {
      return res.status(403).json({ erro: 'Não podes apagar os teus próprios dados. Pede a outro gestor.' });
    }
    if (u.role === 'admin') {
      return res.status(403).json({ erro: 'Não é possível apagar os dados de um administrador.' });
    }
    if (u.role === 'gestor' && req.user.role !== 'admin') {
      return res.status(403).json({ erro: 'Só o administrador pode apagar os dados de um gestor.' });
    }
    if (!req.body || req.body.confirmar !== 'APAGAR') {
      return res.status(400).json({ erro: 'Confirmação em falta. Envia { "confirmar": "APAGAR" }.' });
    }
    if (jaAnonimizada(u)) {
      return res.status(200).json({ mensagem: 'Os dados desta pessoa já tinham sido apagados.', utilizador_id: String(u._id), ja_apagada: true });
    }
    if (u.role === 'gestor') {
      const outros = await Utilizador.countDocuments({
        empresa_id: empresaId, role: { $in: ['gestor', 'admin'] }, _id: { $ne: u._id }, ativo: true, eliminado_em: null,
      });
      if (outros === 0) {
        return res.status(409).json({ erro: 'Esta pessoa é o único gestor da empresa. Cria ou ativa outro gestor antes de apagar os dados.' });
      }
    }

    const nome = await nomeDe(req);
    const r = await apagarDadosPessoa(u);
    registarAuditoria({
      utilizador_id: req.user.id, utilizador_nome: nome, empresa_id: empresaId,
      acao: 'rgpd_apagar', recurso: 'utilizador', recurso_id: u._id,
      descricao: 'Dados pessoais de um membro da empresa apagados (anonimização).',
      detalhes: {
        notificacoes_apagadas: r.notificacoes_apagadas || 0,
        ausencias_apagadas: r.ausencias_apagadas || 0,
        tarefas_retiradas: r.tarefas_retiradas || 0,
        ...(req.user.impersonado_por ? { impersonado_por: String(req.user.impersonado_por) } : {}),
      },
    });
    return res.status(200).json({
      mensagem: 'Dados pessoais apagados. A pessoa ficou anonimizada e as tarefas futuras voltaram a ser distribuídas.',
      utilizador_id: String(u._id),
      ja_apagada: r.jaAnonimizada,
      notificacoes_apagadas: r.notificacoes_apagadas || 0,
      ausencias_apagadas: r.ausencias_apagadas || 0,
      tarefas_retiradas: r.tarefas_retiradas || 0,
      reatribuicao: r.reatribuicao || null,
    });
  } catch (err) {
    console.error('❌ apagarDadosMembro:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Por empresa (Super Admin)                                           */
/* ------------------------------------------------------------------ */

async function empresaDoPedido(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ erro: 'ID inválido.' });
    return null;
  }
  const e = await Empresa.findById(id);
  if (!e) {
    res.status(404).json({ erro: 'Empresa não encontrada.' });
    return null;
  }
  return e;
}

exports.exportarEmpresa = async (req, res) => {
  try {
    const e = await empresaDoPedido(req, res);
    if (!e) return;
    registarAuditoria({
      utilizador_id: req.user.id, utilizador_nome: await nomeDe(req), empresa_id: e._id,
      acao: 'rgpd_exportar_empresa', recurso: 'empresa', recurso_id: e._id,
      descricao: 'Exportação completa dos dados da empresa.',
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="empresa-${String(e._id)}-${hoje()}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    const escrever = (txt) => new Promise((resolve) => { if (res.write(txt)) resolve(); else res.once('drain', resolve); });
    await rgpdEmpresa.exportarEmpresa(e._id, escrever);
    return res.end();
  } catch (err) {
    console.error('❌ exportarEmpresa:', err.message);
    if (!res.headersSent) return res.status(500).json({ erro: 'Erro interno do servidor.' });
    return res.destroy(err);
  }
};

exports.agendarEliminacaoEmpresa = async (req, res) => {
  try {
    const e = await empresaDoPedido(req, res);
    if (!e) return;
    const body = req.body || {};
    if (typeof body.confirmar !== 'string' || body.confirmar !== e.nome) {
      return res.status(400).json({ erro: 'Confirmação inválida. Escreve o nome exato da empresa.' });
    }
    const d = rgpdEmpresa.diasValidos(body.dias);
    if (!d.ok) {
      return res.status(400).json({ erro: `O período de segurança tem de ser um número inteiro de dias entre ${rgpdEmpresa.DIAS_MINIMO} e ${rgpdEmpresa.DIAS_MAXIMO}.` });
    }
    if (await Utilizador.exists({ empresa_id: e._id, role: 'admin' })) {
      return res.status(409).json({ erro: 'Esta empresa contém contas de Super Admin (empresa-sistema) e não pode ser eliminada.' });
    }
    if (e.eliminacao_agendada_para) {
      return res.status(409).json({ erro: 'Já existe uma eliminação agendada. Cancela-a primeiro para reagendar.', eliminacao_agendada_para: e.eliminacao_agendada_para });
    }
    const atualizada = await rgpdEmpresa.agendarEliminacao(e, { dias: d.dias, pedidaPor: req.user.id });
    if (!atualizada) return res.status(409).json({ erro: 'Já existe uma eliminação agendada.' });
    registarAuditoria({
      utilizador_id: req.user.id, utilizador_nome: await nomeDe(req), empresa_id: e._id,
      acao: 'agendar_eliminacao', recurso: 'empresa', recurso_id: e._id,
      descricao: `Eliminação definitiva agendada para ${atualizada.eliminacao_agendada_para.toISOString().slice(0, 10)}.`,
      detalhes: { dias: d.dias },
    });
    return res.status(200).json({
      mensagem: `Eliminação agendada. A empresa foi desativada e os dados serão apagados em ${atualizada.eliminacao_agendada_para.toISOString().slice(0, 10)}.`,
      empresa: { _id: String(atualizada._id), nome: atualizada.nome, ativa: atualizada.ativa, eliminacao_agendada_para: atualizada.eliminacao_agendada_para },
    });
  } catch (err) {
    console.error('❌ agendarEliminacaoEmpresa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

exports.cancelarEliminacaoEmpresa = async (req, res) => {
  try {
    const e = await empresaDoPedido(req, res);
    if (!e) return;
    const atualizada = await rgpdEmpresa.cancelarEliminacao(e._id);
    if (!atualizada) return res.status(409).json({ erro: 'Não há nenhuma eliminação agendada para esta empresa.' });
    registarAuditoria({
      utilizador_id: req.user.id, utilizador_nome: await nomeDe(req), empresa_id: e._id,
      acao: 'cancelar_eliminacao', recurso: 'empresa', recurso_id: e._id,
      descricao: 'Eliminação definitiva cancelada.',
    });
    return res.status(200).json({
      mensagem: 'Eliminação cancelada. O estado anterior da empresa foi reposto.',
      empresa: { _id: String(atualizada._id), nome: atualizada.nome, ativa: atualizada.ativa, eliminacao_agendada_para: null },
    });
  } catch (err) {
    console.error('❌ cancelarEliminacaoEmpresa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
