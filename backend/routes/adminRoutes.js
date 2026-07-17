/**
 * Rotas do Super Admin — FisioCell
 *
 * Prefixo montado em server.js: /api/admin
 *
 * Endpoints exclusivos do Super Admin (role 'admin'):
 *   GET    /empresas                                          — lista todas as empresas + gestor principal
 *   POST   /empresas                                          — cria nova empresa
 *   POST   /empresas/:id/impersonar                           — gera token JWT do gestor (impersonation)
 *   GET    /empresas/:empresaId/utilizadores                  — lista utilizadores de uma empresa
 *   POST   /empresas/:empresaId/utilizadores                  — cria gestor/staff numa empresa
 *   PATCH  /empresas/:empresaId/utilizadores/:utilizadorId/estado — alterna ativo/inativo
 *   DELETE /empresas/:id                                      — soft delete (reciclagem)
 *   PATCH  /empresas/:id/restaurar                            — restaura da reciclagem
 *   PATCH  /empresas/:id/toggle-status                        — ativa/suspende empresa
 *   POST   /empresas/:id/hard-reset                           — hard reset scoped à empresa
 *   GET    /empresas/:id/config                               — lê config da empresa
 *   PUT    /empresas/:id/config                               — atualiza config da empresa
 *   DELETE /hard-reset                                        — apaga Propriedades + Tarefas (global)
 *   GET    /webhook-logs                                      — lista logs de webhooks
 *   DELETE /webhook-logs/limpar                               — limpa logs > 30 dias
 *   POST   /seed-checklists                                   — corre seed de checklists
 *   POST   /forcar-daily-briefing                             — dispara cron manualmente
 *   POST   /forcar-agenda-amanha                              — dispara cron manualmente
 *   POST   /forcar-cao-guarda                                 — dispara cron manualmente
 *   POST   /push-teste                                        — envia push de teste
 *
 * Segurança: todas as rotas usam auth + isAdmin (ESTRITO — só role 'admin').
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/requireRole');
const {
  listarEmpresas,
  impersonarGestor,
  listarUtilizadoresEmpresa,
  criarUtilizadorEmpresa,
  alternarEstadoUtilizadorEmpresa,
} = require('../controllers/superAdminController');

// Todas as rotas exigem auth + isAdmin (só Super Admin).
router.use(auth, isAdmin);

// Listar todas as empresas (cross-tenant) com gestor principal.
router.get('/empresas', listarEmpresas);

// Impersonar gestor de uma empresa (gera token JWT do gestor).
router.post('/empresas/:id/impersonar', impersonarGestor);

// Gestão de utilizadores de empresas terceiras.
router.get('/empresas/:empresaId/utilizadores', listarUtilizadoresEmpresa);
router.post('/empresas/:empresaId/utilizadores', criarUtilizadorEmpresa);
router.patch(
  '/empresas/:empresaId/utilizadores/:utilizadorId/estado',
  alternarEstadoUtilizadorEmpresa
);

// Hard Reset global: apaga TODAS as Propriedades e Tarefas da empresa
// do utilizador autenticado (admin). Se o admin for cross-tenant, apaga tudo.
router.delete('/hard-reset', async (req, res) => {
  try {
    const Propriedade = require('../models/Propriedade');
    const Tarefa = require('../models/Tarefa');
    const mongoose = require('mongoose');

    const empresaId = req.user && req.user.empresa_id;
    const filtro = empresaId && mongoose.isValidObjectId(empresaId)
      ? { empresa_id: empresaId }
      : {};

    const propsResult = await Propriedade.deleteMany(filtro);
    const tarefasResult = await Tarefa.deleteMany(filtro);

    console.log(
      `🗑️  Hard Reset por admin ${req.user?.email || '?'} — ` +
        `${propsResult.deletedCount} propriedade(s) e ${tarefasResult.deletedCount} tarefa(s) apagadas` +
        (empresaId ? ` (empresa ${empresaId}).` : ' (TODAS as empresas).')
    );

    return res.status(200).json({
      message: 'Base de dados limpa com sucesso. Propriedades e Tarefas eliminadas.',
      detalhe: {
        propriedades_apagadas: propsResult.deletedCount,
        tarefas_apagadas: tarefasResult.deletedCount,
        ambito: empresaId ? `empresa ${empresaId}` : 'todas as empresas',
      },
    });
  } catch (err) {
    console.error('❌ hard-reset:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.', detalhe: err.message });
  }
});

// Forçar Cron Jobs manualmente.

// Forçar Daily Briefing.
router.post('/forcar-daily-briefing', async (req, res) => {
  try {
    const { executarBriefing } = require('../jobs/dailyBriefing');
    await executarBriefing();
    return res.status(200).json({ message: 'Daily Briefing executado com sucesso.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Daily Briefing.', detalhe: err.message });
  }
});

// Forçar Agenda de Amanhã.
router.post('/forcar-agenda-amanha', async (req, res) => {
  try {
    const { executarAgendaAmanha } = require('../jobs/agendaAmanha');
    await executarAgendaAmanha();
    return res.status(200).json({ message: 'Agenda de Amanhã executada com sucesso.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Agenda de Amanhã.', detalhe: err.message });
  }
});

// Forçar Cão de Guarda.
router.post('/forcar-cao-guarda', async (req, res) => {
  try {
    const { executarCaoGuarda } = require('../jobs/caoGuarda');
    const resultado = await executarCaoGuarda();
    return res.status(200).json({
      message: 'Cão de Guarda executado com sucesso.',
      failSafe: resultado.failSafe,
      alertas: resultado.alertas,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar Cão de Guarda.', detalhe: err.message });
  }
});

// Enviar Push de Teste para o utilizador atual.
router.post('/push-teste', async (req, res) => {
  try {
    const { notificarUtilizador } = require('../utils/notificar');
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(400).json({ erro: 'Utilizador sem ID no token.' });
    }
    notificarUtilizador(
      String(userId),
      '🧪 Push de Teste',
      'Se estás a ver esta notificação, o sistema de push notifications está a funcionar!',
      '/admin/sistema',
      { criarInApp: true, tipo: 'sistema' }
    );
    return res.status(200).json({ message: 'Push de teste enviado. Verifica o teu dispositivo (se tiveres subscrição ativa).' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao enviar push.', detalhe: err.message });
  }
});

// Configuração da Empresa (tenant local do admin).
// GET: devolve a configuração atual da empresa do admin.
router.get('/config-empresa', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'Admin sem empresa_id associada.' });
    }
    const empresa = await Empresa.findById(empresaId).select('nome nif morada telefone email').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    return res.status(200).json({
      nome: empresa.nome,
      nif: empresa.nif || '',
      morada: empresa.morada || '',
      telefone: empresa.telefone || '',
      email: empresa.email || '',
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// PUT: atualiza a configuração da empresa do admin.
router.put('/config-empresa', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'Admin sem empresa_id associada.' });
    }
    const { nome, nif, morada, telefone, email } = req.body || {};
    const update = {};
    if (nome !== undefined) update.nome = String(nome).trim();
    if (nif !== undefined) update.nif = String(nif).trim();
    if (morada !== undefined) update.morada = String(morada).trim();
    if (telefone !== undefined) update.telefone = String(telefone).trim();
    if (email !== undefined) update.email = String(email).trim().toLowerCase();

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
    }

    const empresa = await Empresa.findByIdAndUpdate(empresaId, { $set: update }, { new: true }).select('nome nif morada telefone email').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    return res.status(200).json({
      message: 'Configuração guardada com sucesso.',
      nome: empresa.nome,
      nif: empresa.nif || '',
      morada: empresa.morada || '',
      telefone: empresa.telefone || '',
      email: empresa.email || '',
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// CRUD de Empresas (Super Admin).

// Criar Nova Empresa.
router.post('/empresas', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { nome, nif, morada, telefone, email } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Nome da empresa é obrigatório.' });
    }
    const nova = await Empresa.create({
      nome: String(nome).trim(),
      nif: nif ? String(nif).trim() : '',
      morada: morada ? String(morada).trim() : '',
      telefone: telefone ? String(telefone).trim() : '',
      email: email ? String(email).trim().toLowerCase() : '',
    });
    return res.status(201).json({ empresa: nova });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar empresa.', detalhe: err.message });
  }
});

// Eliminar Empresa (SOFT DELETE).
// Marca apagada: true + ativa: false. A empresa desaparece da aba "Ativas"
// e aparece na "Reciclagem". Pode ser restaurada via PATCH .../restaurar.
router.delete('/empresas/:id', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const empresa = await Empresa.findByIdAndUpdate(
      id,
      { $set: { apagada: true, ativa: false } },
      { new: true }
    ).select('nome apagada ativa');
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const { registarAuditoria } = require('../utils/auditoria');
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Super Admin',
      empresa_id: id,
      acao: 'soft-delete',
      recurso: 'empresa',
      recurso_id: id,
      descricao: `Empresa "${empresa.nome}" movida para a reciclagem (apagada: true).`,
    });
    return res.status(200).json({
      message: `Empresa "${empresa.nome}" movida para a reciclagem.`,
      empresa: { _id: String(empresa._id), apagada: empresa.apagada, ativa: empresa.ativa },
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao eliminar empresa.', detalhe: err.message });
  }
});

// Restaurar Empresa (desfaz o soft delete).
// Marca apagada: false. Não reativa automaticamente (ativa continua false) —
// o admin deve carregar em "Ativar" depois de restaurar, para confirmar.
router.patch('/empresas/:id/restaurar', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const empresa = await Empresa.findByIdAndUpdate(
      id,
      { $set: { apagada: false } },
      { new: true }
    ).select('nome apagada ativa');
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const { registarAuditoria } = require('../utils/auditoria');
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Super Admin',
      empresa_id: id,
      acao: 'restaurar',
      recurso: 'empresa',
      recurso_id: id,
      descricao: `Empresa "${empresa.nome}" restaurada da reciclagem (apagada: false).`,
    });
    return res.status(200).json({
      message: `Empresa "${empresa.nome}" restaurada. Carrega em "Ativar" para reativar o acesso.`,
      empresa: { _id: String(empresa._id), apagada: empresa.apagada, ativa: empresa.ativa },
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao restaurar empresa.', detalhe: err.message });
  }
});

// Toggle do estado `ativa` de uma empresa.
// Quando `ativa: false`: o login é bloqueado para todos os utilizadores
// desta empresa (exceto admin).
// Body (opcional): { ativa: boolean } — se não vier, alterna o estado atual.
router.patch('/empresas/:id/toggle-status', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const empresa = await Empresa.findById(id);
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const novoEstado = typeof req.body?.ativa === 'boolean' ? req.body.ativa : !empresa.ativa;
    empresa.ativa = novoEstado;
    await empresa.save();
    return res.status(200).json({
      message: `Empresa ${novoEstado ? 'ativada' : 'desativada'} com sucesso.`,
      empresa: { _id: String(empresa._id), nome: empresa.nome, ativa: empresa.ativa },
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao alterar estado da empresa.', detalhe: err.message });
  }
});

// Hard reset de UMA empresa específica.
// Apaga apenas as Tarefas e Propriedades dessa empresa (não toca noutras
// empresas, nem em utilizadores/ausências/auditoria).
router.post('/empresas/:id/hard-reset', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const Propriedade = require('../models/Propriedade');
    const Tarefa = require('../models/Tarefa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const empresa = await Empresa.findById(id).select('_id nome').lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const [propApagadas, tarefasApagadas] = await Promise.all([
      Propriedade.deleteMany({ empresa_id: id }),
      Tarefa.deleteMany({ empresa_id: id }),
    ]);
    const { registarAuditoria } = require('../utils/auditoria');
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Super Admin',
      empresa_id: id,
      acao: 'hard-reset',
      recurso: 'empresa',
      recurso_id: id,
      descricao: `Hard reset da empresa "${empresa.nome}": ${propApagadas.deletedCount} propriedade(s) e ${tarefasApagadas.deletedCount} tarefa(s) apagadas.`,
      detalhes: { propriedades: propApagadas.deletedCount, tarefas: tarefasApagadas.deletedCount },
    });
    return res.status(200).json({
      message: `Hard reset concluído para a empresa "${empresa.nome}".`,
      detalhe: {
        propriedades_apagadas: propApagadas.deletedCount,
        tarefas_apagadas: tarefasApagadas.deletedCount,
      },
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro no hard reset da empresa.', detalhe: err.message });
  }
});

// Gaveta da Empresa: endpoints scoped por :id (empresa_id).
// O admin atua sobre UMA empresa específica.

// GET /api/admin/empresas/:id/config — devolve a configuração da empresa.
router.get('/empresas/:id/config', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const emp = await Empresa.findById(id).select('nome nif morada telefone email ativa').lean();
    if (!emp) return res.status(404).json({ erro: 'Empresa não encontrada.' });
    return res.status(200).json({
      nome: emp.nome,
      nif: emp.nif || '',
      morada: emp.morada || '',
      telefone: emp.telefone || '',
      email: emp.email || '',
      ativa: emp.ativa,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao carregar config.', detalhe: err.message });
  }
});

// PUT /api/admin/empresas/:id/config — atualiza a configuração da empresa.
router.put('/empresas/:id/config', async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const { id } = req.params;
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID inválido.' });
    }
    const { nome, nif, morada, telefone, email } = req.body || {};
    const update = {};
    if (nome !== undefined) update.nome = String(nome).trim();
    if (nif !== undefined) update.nif = String(nif).trim();
    if (morada !== undefined) update.morada = String(morada).trim();
    if (telefone !== undefined) update.telefone = String(telefone).trim();
    if (email !== undefined) update.email = String(email).trim().toLowerCase();
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
    }
    const emp = await Empresa.findByIdAndUpdate(id, { $set: update }, { new: true }).select('nome nif morada telefone email').lean();
    if (!emp) return res.status(404).json({ erro: 'Empresa não encontrada.' });
    return res.status(200).json({
      message: 'Configuração guardada.',
      nome: emp.nome,
      nif: emp.nif || '',
      morada: emp.morada || '',
      telefone: emp.telefone || '',
      email: emp.email || '',
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao guardar config.', detalhe: err.message });
  }
});

// POST /api/admin/seed-checklists — corre o seed de checklists para a empresa
// do admin (ou todas se não tiver empresa_id). Cria os 2 modelos e associa
// o Modelo 1 às propriedades sem modelo.
router.post('/seed-checklists', async (req, res) => {
  try {
    const ModeloChecklist = require('../models/ModeloChecklist');
    const Propriedade = require('../models/Propriedade');
    const Empresa = require('../models/Empresa');

    let empresaId = req.body?.empresa_id || (req.user && req.user.empresa_id);
    if (!empresaId || empresaId === 'undefined') {
      const primeiraEmpresa = await Empresa.findOne().sort({ createdAt: 1 }).lean();
      if (!primeiraEmpresa) {
        return res.status(404).json({ erro: 'Nenhuma empresa encontrada na BD.' });
      }
      empresaId = String(primeiraEmpresa._id);
    }

    const LIMPEZA_STANDARD = {
      nome: 'Limpeza Standard',
      descricao: 'Checklist de limpeza de checkout para garantir o padrão de excelência.',
      seccoes: [
        { nome: 'Quartos', items: [
          'Verificar o estado dos resguardos de colchão e almofadas.',
          'Substituir roupa de cama (lençóis, fronhas, capas) e esticar bem.',
          'Limpar pó de mesas de cabeceira, candeeiros e topo da cabeceira.',
          'Verificar interior de roupeiros e gavetas (remover lixo/esquecidos).',
          'Aspirar debaixo da cama e cantos do teto (teias de aranha).',
        ]},
        { nome: 'Cozinha', items: [
          'Limpar interior e exterior de micro-ondas, frigorífico e forno.',
          'Lavar loiça restante e limpar gaveta de talheres (migalhas).',
          'Desinfetar banca, torneira e placa de fogão.',
          'Esvaziar lixo, desinfetar balde e colocar saco novo.',
        ]},
        { nome: 'Casa de Banho', items: [
          'Desinfetar sanita, lavatório e zona de duche (atenção aos cabelos).',
          'Limpar espelho e vidros do poliban sem deixar manchas.',
          'Repor papel higiénico (com selo) e consumíveis (shampoo/gel).',
          'Substituir toalhas de banho e de rosto por limpas.',
        ]},
        { nome: 'Sala / Áreas Comuns', items: [
          'Aspirar sofás (entre almofadas) e limpar comando da TV.',
          'Limpar pó de prateleiras, mesas e rodapés.',
          'Verificar se o guia do hóspede e senha Wi-Fi estão no lugar.',
        ]},
        { nome: 'Geral / Manutenção', items: [
          'Testar todas as lâmpadas e pilhas de comandos.',
          'Verificar danos ou manchas e reportar imediatamente.',
          'Garantir que janelas e porta principal estão trancadas ao sair.',
        ]},
      ],
    };

    const LIMPEZA_DETALHADA_V2 = {
      nome: 'Limpeza Detalhada V2',
      descricao: 'Checklist expandida que garante que nenhum detalhe passa despercebido.',
      seccoes: [
        { nome: 'Quartos (Dormitórios)', items: [
          'Retirar roupa de cama usada e verificar se o protetor de colchão/almofada tem manchas.',
          'Colocar lençóis lavados, garantindo que estão esticados e sem cabelos ou fiapos.',
          'Limpar o pó de molduras, quadros, rodapés e parte superior de espelhos.',
          'Limpar o interior de todas as gavetas e prateleiras dos roupeiros.',
          'Verificar se existem objetos esquecidos (carregadores, roupa) debaixo da cama.',
          'Desinfetar comandos de AC e interruptores de luz.',
        ]},
        { nome: 'Casa de Banho (Sanitários)', items: [
          'Desinfetar sanita (incluindo base e atrás da tampa) e colocar selo de higienização.',
          'Remover calcário de torneiras e chuveiro até brilharem.',
          'Limpar ralo do duche e remover quaisquer cabelos.',
          'Limpar azulejos da zona de banho para remover marcas de água e sabão.',
          'Repor: 2 rolos de papel higiénico (mínimo), sabonete, shampoo e gel de banho.',
          'Verificar se o caixote do lixo está vazio, limpo e com saco novo.',
        ]},
        { nome: 'Cozinha e Zona de Refeições', items: [
          'Limpar frigorífico: remover restos, limpar prateleiras e gaveta de vegetais.',
          'Limpar migalhas da torradeira e interior do micro-ondas.',
          'Verificar se a loiça na máquina ou armários está seca e sem manchas.',
          'Limpar e desinfetar a banca e o escorredor de loiça.',
          'Repor kit de boas-vindas: café, chá, açúcar, sal, azeite e esponja de loiça nova.',
        ]},
        { nome: 'Sala e Áreas de Estar', items: [
          'Limpar o ecrã da TV (apenas com pano seco/próprio) e o comando.',
          'Aspirar fendas do sofá e sacudir almofadas decorativas.',
          'Limpar marcas de dedos em vidros, janelas e mesas de centro.',
          'Organizar revistas, manuais da casa e comandos de forma ordenada.',
        ]},
        { nome: 'Verificação Final (Protocolo de Saída)', items: [
          'Testar todas as lâmpadas e o sinal do Wi-Fi.',
          'Garantir que não há odores desagradáveis (usar neutralizador se necessário).',
          'Verificar se o AC/Aquecimento está desligado ou na temperatura de boas-vindas.',
          'Trancar todas as janelas e a porta principal.',
        ]},
      ],
    };

    let modelo1 = await ModeloChecklist.findOneAndUpdate(
      { empresa_id: empresaId, nome: 'Limpeza Standard' },
      { $set: { ...LIMPEZA_STANDARD, empresa_id: empresaId } },
      { upsert: true, new: true }
    ).lean();

    let modelo2 = await ModeloChecklist.findOneAndUpdate(
      { empresa_id: empresaId, nome: 'Limpeza Detalhada V2' },
      { $set: { ...LIMPEZA_DETALHADA_V2, empresa_id: empresaId } },
      { upsert: true, new: true }
    ).lean();

    const resultado = await Propriedade.updateMany(
      {
        empresa_id: empresaId,
        $or: [
          { modelo_checklist_id: null },
          { modelo_checklist_id: { $exists: false } },
        ],
      },
      { $set: { modelo_checklist_id: modelo1._id } }
    );

    return res.status(200).json({
      message: 'Seed de checklists concluído.',
      modelos: [
        { _id: String(modelo1._id), nome: modelo1.nome, seccoes: modelo1.seccoes.length },
        { _id: String(modelo2._id), nome: modelo2.nome, seccoes: modelo2.seccoes.length },
      ],
      propriedades_associadas: resultado.modifiedCount,
    });
  } catch (err) {
    console.error('❌ seed-checklists:', err.message);
    return res.status(500).json({ erro: 'Erro ao executar seed.', detalhe: err.message });
  }
});

// Monitor de Webhooks (Caixa Negra).

// GET /api/admin/webhook-logs — lista todos os logs de webhooks (cross-tenant).
router.get('/webhook-logs', async (req, res) => {
  try {
    const WebhookLog = require('../models/WebhookLog');
    const { status, limit, empresa_id } = req.query;
    const filtro = {};
    if (status && ['recebido', 'processado', 'erro'].includes(status)) {
      filtro.status = status;
    }
    if (empresa_id) {
      filtro.empresa_id = empresa_id;
    }
    const maxLimit = Math.min(Number(limit) || 100, 500);
    const logs = await WebhookLog.find(filtro)
      .sort({ createdAt: -1 })
      .limit(maxLimit)
      .lean();

    return res.status(200).json({ logs, total: logs.length });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// DELETE /api/admin/webhook-logs/limpar — elimina logs com mais de 30 dias.
router.delete('/webhook-logs/limpar', async (req, res) => {
  try {
    const WebhookLog = require('../models/WebhookLog');
    const limite = new Date();
    limite.setDate(limite.getDate() - 30);

    const resultado = await WebhookLog.deleteMany({ createdAt: { $lt: limite } });

    console.log(`🧹 Limpeza de webhook logs: ${resultado.deletedCount} registos com mais de 30 dias apagados.`);
    return res.status(200).json({
      message: 'Logs antigos limpos com sucesso.',
      apagados: resultado.deletedCount,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao limpar logs.', detalhe: err.message });
  }
});

module.exports = router;
