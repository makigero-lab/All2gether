/**
 * Rotas do Painel do Gestor de Operações — All2gether
 *
 * Prefixo montado em server.js: /api/gestor
 *
 * Endpoints:
 *   GET    /propriedades                   — lista propriedades/salas da empresa (PROTEGIDO)
 *   POST   /propriedades                   — cria propriedade/sala (PROTEGIDO)
 *   PUT    /propriedades/:id               — atualiza propriedade/sala (PROTEGIDO)
 *   PATCH  /propriedades/:id/estado        — alterna ativo/desativo (PROTEGIDO)
 *   GET    /equipa                         — lista utilizadores da empresa (PROTEGIDO)
 *   POST   /equipa                         — cria utilizador (PROTEGIDO)
 *   PUT    /equipa/:id                     — atualiza utilizador (PROTEGIDO)
 *   PATCH  /equipa/:id/estado              — alterna ativo/desativo (PROTEGIDO)
 *   DELETE /equipa/:id                     — elimina utilizador (PROTEGIDO)
 *   GET    /setup                          — bootstrap do "Cliente Zero" (PÚBLICO)
 *
 * Autenticação:
 *   - As rotas de propriedades e equipa são protegidas pelo middleware `auth`
 *     (JWT, com fallback legacy x-empresa-id durante a transição).
 *   - A rota /setup é PÚBLICA de propósito: é o endpoint de bootstrap que
 *     cria o primeiro utilizador (ainda não há token para a chamar). Em
 *     produção, deve ser desativada ou protegida por outro mecanismo após
 *     o setup inicial.
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const { isGestor } = require('../middleware/requireRole');
const {
  getDashboard,
  getPropriedades,
  criarPropriedade,
  atualizarPropriedade,
  alternarEstadoPropriedade,
  eliminarPropriedade,
  getTarefas,
  getDadosCalendario,
  getEquipa,
  criarMembroEquipa,
  atualizarMembroEquipa,
  alternarEstadoMembro,
  eliminarMembroEquipa,
  reportarFaltaSubita,
  registarBaixaProlongada,
  exportarTarefasCSV,
  getAuditoria,
  getWebhooks,
  reprocessarWebhook,
  setupClienteZero,
  // FIX (gestão de parceiros) — novo controller para listar parceiros B2B.
  getParceiros,
} = require('../controllers/gestorController');
const { reportarAtrasoTarefa, criarTarefa, atribuirTarefa, reatribuirTarefa, atualizarEstadoTarefa, apagarTarefasFuturas, listarIndisponiveisData, autoAtribuirTarefas, criarTarefaEspontanea } = require('../controllers/tarefaController');
// CRUD de Modelos de Checklist (futuro: Modelos de Protocolo Clínico)
const { listarModelos, criarModelo, obterModelo, atualizarModelo, apagarModelo } = require('../controllers/checklistController');
// Smoobu — importação/sincronização de propriedades (HF5) + reservas (HF7).
const { getPropriedadesSmoobu, importarPropriedades, sincronizarReservas } = require('../controllers/smoobuController');

// Bootstrap do ambiente de testes — Cliente Zero. PÚBLICO (sem auth).
router.get('/setup', setupClienteZero);

// Dashboard com dados reais.
router.get('/dashboard', auth, isGestor, getDashboard);

// Gestão de propriedades/salas da empresa. PROTEGIDO por JWT.
router.get('/propriedades', auth, isGestor, getPropriedades);
router.post('/propriedades', auth, isGestor, criarPropriedade);
router.put('/propriedades/:id', auth, isGestor, atualizarPropriedade);
router.patch('/propriedades/:id/estado', auth, isGestor, alternarEstadoPropriedade);
// FIX (hard-delete para admin) — DELETE com ?hard=true para hard-delete (só admin).
router.delete('/propriedades/:id', auth, isGestor, eliminarPropriedade);

// Aplica um checklist padrão a TODAS as propriedades ativas da empresa.
router.post('/propriedades/default-checklist', auth, isGestor, async (req, res) => {
  try {
    const Propriedade = require('../models/Propriedade');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    const CHECKLIST_PADRAO = [
      'Esvaziar lixo',
      'Trocar roupa da cama',
      'Trocar Toalhas',
      'Limpar chão',
      'Limpar vidros',
      'Limpar pó',
    ];

    const resultado = await Propriedade.updateMany(
      { empresa_id: empresaId },
      { $set: { checklist: CHECKLIST_PADRAO } }
    );

    return res.status(200).json({
      sucesso: true,
      message: `Checklist padrão aplicada a ${resultado.modifiedCount} propriedade(s).`,
      checklist: CHECKLIST_PADRAO,
      modificadas: resultado.modifiedCount,
      correspondidas: resultado.matchedCount,
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// Smoobu — importação/sincronização de propriedades (HF5) + reservas (HF7).
// GET  /api/gestor/smoobu/propriedades — lista apartamentos do Smoobu (dropdown).
// POST /api/gestor/smoobu/propriedades — upsert em massa (cria novas + atualiza
//        morada/capacidade das existentes). Popula Propriedade.smoobu_id, essencial
//        para o webhook (HF4) fazer match de reservas → propriedades.
// POST /api/gestor/smoobu/sincronizar — backfill em massa de reservas (HF7):
//        puxa TODAS as reservas futuras do Smoobu (REST API + paginação) e
//        processa cada uma via processarReservaSmoobu (cria tarefas, cancela
//        reservas canceladas, idempotente). É o "motor" de sincronização.
router.get('/smoobu/propriedades', auth, isGestor, getPropriedadesSmoobu);
router.post('/smoobu/propriedades', auth, isGestor, importarPropriedades);
router.post('/smoobu/sincronizar', auth, isGestor, sincronizarReservas);

// Calendário Geral de Operações — lista tarefas com filtro de datas.
router.get('/tarefas', auth, isGestor, getTarefas);

// Calendário Visual Avançado — endpoint unificado com filtros + populate.
router.get('/calendario/dados', auth, isGestor, getDadosCalendario);

// Exportação CSV de tarefas.
router.get('/tarefas/export', auth, isGestor, exportarTarefasCSV);

// Reportar atraso numa tarefa.
router.post('/tarefas/:id/atraso', auth, isGestor, reportarAtrasoTarefa);

// Gestão manual de tarefas.
router.post('/tarefas', auth, isGestor, criarTarefa);
router.post('/tarefas/espontanea', auth, isGestor, criarTarefaEspontanea);
router.patch('/tarefas/:id/atribuir', auth, isGestor, atribuirTarefa);
router.patch('/tarefas/:id/reatribuir', auth, isGestor, reatribuirTarefa);
router.patch('/tarefas/:id/estado', auth, isGestor, atualizarEstadoTarefa);

// Apagar tarefas futuras não concluídas (reset do calendário).
router.delete('/tarefas/futuras', auth, isGestor, apagarTarefasFuturas);

// Auto-atribuição em lote (corre o load balancer para todas as tarefas
// órfãs a partir de hoje).
router.post('/tarefas/auto-atribuir', auth, isGestor, autoAtribuirTarefas);

// Staff indisponíveis (férias/doença) numa data.
router.get('/tarefas/indisponiveis', auth, isGestor, listarIndisponiveisData);

// Gestão de equipa (utilizadores) da empresa. PROTEGIDO por JWT.
router.get('/equipa', auth, isGestor, getEquipa);
router.post('/equipa', auth, isGestor, criarMembroEquipa);
// FIX (gestão de parceiros) — rota dedicada para parceiros B2B.
router.get('/parceiros', auth, isGestor, getParceiros);
router.put('/equipa/:id', auth, isGestor, atualizarMembroEquipa);
router.patch('/equipa/:id/estado', auth, isGestor, alternarEstadoMembro);
router.delete('/equipa/:id', auth, isGestor, eliminarMembroEquipa);

// Falta súbita — reatribuição de emergência.
router.post('/equipa/:id/falta-subita', auth, isGestor, reportarFaltaSubita);

// Baixa prolongada / férias — redistribuição de tarefas futuras.
router.post('/equipa/:id/baixa', auth, isGestor, registarBaixaProlongada);

// CRUD de Modelos de Checklist (futuro: Modelos de Protocolo Clínico).
router.get('/checklists', auth, isGestor, listarModelos);
router.post('/checklists', auth, isGestor, criarModelo);
router.get('/checklists/:id', auth, isGestor, obterModelo);
router.put('/checklists/:id', auth, isGestor, atualizarModelo);
router.delete('/checklists/:id', auth, isGestor, apagarModelo);

// Auditoria.
router.get('/auditoria', auth, isGestor, getAuditoria);

// Webhooks — logs de integrações externas (lista + reproccessamento manual).
router.get('/webhooks', auth, isGestor, getWebhooks);
router.post('/webhooks/:id/reprocessar', auth, isGestor, reprocessarWebhook);

// Configurações do Gestor (tenant local).

// GET /api/gestor/configuracoes — devolve a configuração da empresa do gestor.
router.get('/configuracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
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

// PUT /api/gestor/configuracoes — atualiza a configuração da empresa.
router.put('/configuracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
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

// POST /api/gestor/configuracoes/forcar-daily-briefing — dispara para a empresa do gestor.
router.post('/configuracoes/forcar-daily-briefing', auth, isGestor, async (req, res) => {
  try {
    const { executarBriefing } = require('../jobs/dailyBriefing');
    await executarBriefing();
    return res.status(200).json({ message: 'Daily Briefing executado.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar.', detalhe: err.message });
  }
});

// POST /api/gestor/configuracoes/forcar-agenda-amanha — dispara para a empresa do gestor.
router.post('/configuracoes/forcar-agenda-amanha', auth, isGestor, async (req, res) => {
  try {
    const { executarAgendaAmanha } = require('../jobs/agendaAmanha');
    await executarAgendaAmanha();
    return res.status(200).json({ message: 'Agenda de Amanhã executada.' });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao executar.', detalhe: err.message });
  }
});

// ----------------------------------------------------------------
// HF6 — Configurações de Integrações e Rotinas (descentralizadas).
// ----------------------------------------------------------------
// A gestão da integração Smoobu (api_key, ativo) e das rotinas de
// sincronização (frequência, estado) passou a viver no All2gether.
// Estes endpoints permitem ao gestor configurar tudo no painel local,
// sem depender da Nave-Mãe (Autocell).

/**
 * Máscara a API key para o GET (nunca expor em claro).
 * Mostra só os últimos 4 chars: "••••••••1234".
 */
function mascararApiKey(chave) {
  if (!chave || typeof chave !== 'string') return '';
  if (chave.length <= 4) return '••••';
  return '••••••••' + chave.slice(-4);
}

// GET /api/gestor/configuracoes/integracoes — lê as configurações atuais.
router.get('/configuracoes/integracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const empresa = await Empresa.findById(empresaId)
      .select('integracoes rotinas')
      .lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }
    const smoobu = empresa.integracoes?.smoobu || {};
    const rotinas = empresa.rotinas || {};
    return res.status(200).json({
      smoobu: {
        // NUNCA devolver a chave em claro — só mascarada + booleano `configurado`.
        api_key_mascarada: mascararApiKey(smoobu.api_key),
        configurado: Boolean(smoobu.api_key && smoobu.api_key.trim()),
        ativo: Boolean(smoobu.ativo),
        ultima_sincronizacao: smoobu.ultima_sincronizacao || null,
      },
      rotinas: {
        sincronizacao_automatica: Boolean(rotinas.sincronizacao_automatica),
        frequencia_horas: Number(rotinas.frequencia_horas) || 24,
      },
      // Indica se a env var fallback está ativa (para o frontend mostrar aviso
      // de que a chave da BD tem prioridade).
      env_var_ativa: Boolean(process.env.SMOOBU_API_KEY),
      // FIX (status smoobu real) — Estado real da integração Smoobu: considera
      // configurada se houver chave na BD OU env var SMOOBU_API_KEY. O frontend
      // usa este booleano para mostrar a bolinha verde/vermelha de estado.
      smoobu_ativo: Boolean(
        (smoobu.api_key && smoobu.api_key.trim()) || process.env.SMOOBU_API_KEY
      ),
      // FIX (google maps integration) — Indica se o Google Maps está configurado
      // (env var GOOGLE_MAPS_API_KEY no Render). O frontend usa este booleano
      // para mostrar/ocultar botões "Abrir no Google Maps" e links de navegação.
      google_maps_ativo: require('../utils/geocoding').googleMapsAtivo(),
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

// PUT /api/gestor/configuracoes/integracoes — atualiza as configurações.
//
// Body:
//   {
//     smoobu: {
//       api_key?: string,        // nova chave (opcional — se undefined, mantém)
//                               // se string vazia, limpa a chave.
//       ativo?: boolean,
//     },
//     rotinas: {
//       sincronizacao_automatica?: boolean,
//       frequencia_horas?: number,  // 1, 6, 12, 24
//     }
//   }
router.put('/configuracoes/integracoes', auth, isGestor, async (req, res) => {
  try {
    const Empresa = require('../models/Empresa');
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const { smoobu, rotinas } = req.body || {};

    const update = {};
    if (smoobu) {
      if (typeof smoobu.api_key === 'string') {
        update['integracoes.smoobu.api_key'] = smoobu.api_key.trim();
      }
      if (typeof smoobu.ativo === 'boolean') {
        update['integracoes.smoobu.ativo'] = smoobu.ativo;
      }
    }
    if (rotinas) {
      if (typeof rotinas.sincronizacao_automatica === 'boolean') {
        update['rotinas.sincronizacao_automatica'] = rotinas.sincronizacao_automatica;
      }
      if (rotinas.frequencia_horas !== undefined) {
        const freq = Number(rotinas.frequencia_horas);
        if (!Number.isFinite(freq) || freq < 1) {
          return res.status(400).json({ erro: 'frequencia_horas inválida (mínimo 1).' });
        }
        update['rotinas.frequencia_horas'] = Math.floor(freq);
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
    }

    const empresa = await Empresa.findByIdAndUpdate(
      empresaId,
      { $set: update },
      { new: true }
    )
      .select('integracoes rotinas')
      .lean();

    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }

    const smoobuAtualizado = empresa.integracoes?.smoobu || {};
    const rotinasAtualizadas = empresa.rotinas || {};
    return res.status(200).json({
      message: 'Configurações de integrações guardadas com sucesso.',
      smoobu: {
        api_key_mascarada: mascararApiKey(smoobuAtualizado.api_key),
        configurado: Boolean(smoobuAtualizado.api_key && smoobuAtualizado.api_key.trim()),
        ativo: Boolean(smoobuAtualizado.ativo),
        ultima_sincronizacao: smoobuAtualizado.ultima_sincronizacao || null,
      },
      rotinas: {
        sincronizacao_automatica: Boolean(rotinasAtualizadas.sincronizacao_automatica),
        frequencia_horas: Number(rotinasAtualizadas.frequencia_horas) || 24,
      },
    });
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: err.message });
  }
});

module.exports = router;
