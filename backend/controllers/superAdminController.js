/**
 * Super Admin Controller — Autocell
 *
 * Endpoints exclusivos do Super Admin (role 'admin').
 *
 * Funcionalidades:
 *   - listarEmpresas: lista todas as empresas com o gestor principal de cada uma.
 *   - impersonarGestor: gera um token JWT do gestor de uma empresa, permitindo
 *     ao Super Admin "entrar" como esse gestor para suporte/debug.
 *   - listarUtilizadoresEmpresa (Prompt 101): lista todos os utilizadores
 *     (gestores + staff) de uma empresa terceira.
 *   - criarUtilizadorEmpresa (Prompt 101): cria um gestor/staff numa empresa
 *     terceira (para empresas que ficaram sem gestor).
 *   - alternarEstadoUtilizadorEmpresa (Prompt 101): ativa/desativa um
 *     utilizador de uma empresa terceira.
 *
 * Segurança: todas as rotas usam auth + isAdmin (só role 'admin' passa).
 */

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const WebhookLog = require('../models/WebhookLog');
const { JWT_SECRET } = require('../middleware/auth');
const { registarAuditoria } = require('../utils/auditoria');

const TOKEN_EXPIRACAO = process.env.JWT_EXPIRACAO || '7d';

/* ------------------------------------------------------------------ */
/* GET /api/admin/empresas — listar empresas com gestor principal      */
/* ------------------------------------------------------------------ */

/**
 * Lista todas as empresas (cross-tenant) com gestor principal + estatísticas.
 *
 * Prompt 112 — Adicionadas contagens de Propriedades e Tarefas.
 *
 * Resposta 200: { empresas: [{ _id, nome, nif, plano_ativo, createdAt,
 *   gestor: { id, nome, email } | null,
 *   num_propriedades: number,
 *   num_tarefas: number }] }
 */
exports.listarEmpresas = async (req, res) => {
  try {
    const empresas = await Empresa.find().sort({ createdAt: -1 }).lean();

    // Para cada empresa, procura o gestor + contagens em paralelo.
    const empresasComDados = await Promise.all(
      empresas.map(async (emp) => {
        const [gestor, numPropriedades, numTarefas] = await Promise.all([
          Utilizador.findOne({
            empresa_id: emp._id,
            role: 'gestor',
            eliminado_em: null,
          })
            .select('nome email')
            .lean(),
          Propriedade.countDocuments({ empresa_id: emp._id }),
          Tarefa.countDocuments({ empresa_id: emp._id }),
        ]);

        return {
          ...emp,
          gestor: gestor
            ? { id: String(gestor._id), nome: gestor.nome, email: gestor.email }
            : null,
          num_propriedades: numPropriedades,
          num_tarefas: numTarefas,
        };
      })
    );

    return res.status(200).json({ empresas: empresasComDados });
  } catch (err) {
    console.error('❌ listarEmpresas:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/admin/empresas/:id/impersonar — login como gestor         */
/* ------------------------------------------------------------------ */

/**
 * Permite ao Super Admin "fazer login como" o gestor de uma empresa.
 *
 * Recebe o ID da empresa nos parâmetros. Encontra o utilizador principal
 * dessa empresa (role 'gestor') e gera um NOVO token JWT com os dados
 * desse gestor — exatamente igual à função de Login normal.
 *
 * Prompt 100 (correção) — Override do admin quando não há gestor ativo:
 *   Se a empresa não tiver um gestor ativo (role 'gestor', ativo, não
 *   eliminado), o Super Admin (role 'admin') que faz o pedido tem
 *   OVERRIDE TOTAL: o sistema NÃO bloqueia. Em vez disso, gera um token
 *   com o próprio admin (id/nome/email do req.user) mas com o empresa_id
 *   da empresa alvo e role 'admin'. Como o middleware isGestor permite
 *   'admin' e 'gestor', o admin consegue aceder a todos os endpoints do
 *   painel /gestor/* (dashboard, propriedades, tarefas, etc.) baseando-se
 *   apenas no empresa_id, ignorando a necessidade de existir um gestor.
 *
 * O frontend pode usar este token para entrar no painel do gestor.
 *
 * Resposta 200: { token, utilizador, empresa, impersonado: true }
 *   - token: JWT (do gestor se existir, ou do admin com empresa_id override)
 *   - utilizador: { id, nome, email, role, empresa_id }
 *   - empresa: { id, nome }
 *   - impersonado: true (para o frontend saber que é uma sessão de impersonation)
 *
 * Erros:
 *   404 — empresa não encontrada
 *   500 — erro interno
 */
exports.impersonarGestor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ erro: 'ID de empresa inválido.' });
    }

    // Encontra a empresa.
    const empresa = await Empresa.findById(id).lean();
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }

    // Encontra o gestor principal dessa empresa.
    const gestor = await Utilizador.findOne({
      empresa_id: id,
      role: 'gestor',
      eliminado_em: null,
      ativo: true,
    }).lean();

    // Prompt 100 — Override do admin: se não há gestor ativo, o Super Admin
    // que faz o pedido (req.user, role 'admin') gera um token com o seu
    // próprio id/nome/email mas com o empresa_id da empresa alvo e role
    // 'gestor' (o admin está a IMPERSONAR um gestor dessa empresa). Como o
    // middleware isGestor permite 'gestor', o token funciona no painel
    // /gestor. O id real do admin fica no token para auditoria.
    let tokenUser;
    if (gestor) {
      tokenUser = {
        id: String(gestor._id),
        nome: gestor.nome,
        email: gestor.email,
        role: gestor.role,
        empresa_id: String(gestor.empresa_id),
      };
    } else {
      // Carrega o admin (req.user) para ter nome/email reais.
      const admin = await Utilizador.findById(req.user.id).select('nome email').lean();
      if (!admin) {
        return res.status(404).json({ erro: 'Conta de admin não encontrada.' });
      }
      tokenUser = {
        id: String(admin._id),
        nome: admin.nome,
        email: admin.email,
        // Role 'gestor' para o frontend middleware deixar entrar no /gestor
        // e para o isGestor do backend autorizar. O id real do admin fica
        // no token para auditoria (registarAuditoria usa req.user.id).
        role: 'gestor',
        empresa_id: String(empresa._id),
      };
      console.log(
        `ℹ️  [impersonarGestor] Empresa "${empresa.nome}" sem gestor ativo — ` +
          `admin "${admin.email}" a aceder em modo override (empresa_id=${empresa._id}).`
      );
    }

    // Gera um NOVO token JWT (igual ao login normal).
    const token = jwt.sign(
      {
        id: tokenUser.id,
        role: tokenUser.role,
        empresa_id: tokenUser.empresa_id,
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRACAO }
    );

    return res.status(200).json({
      token,
      utilizador: tokenUser,
      empresa: {
        id: String(empresa._id),
        nome: empresa.nome,
      },
      impersonado: true,
    });
  } catch (err) {
    console.error('❌ impersonarGestor:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* Prompt 101 — Gestão de utilizadores de empresas terceiras           */
/* (Super Admin pode gerir qualquer empresa)                           */
/* ------------------------------------------------------------------ */

/**
 * Valida que a empresa existe e devolve-a (lean). Usado pelos 3 endpoints
 * abaixo para evitar repetição.
 */
async function carregarEmpresa(empresaId) {
  if (!mongoose.isValidObjectId(empresaId)) return null;
  return Empresa.findById(empresaId).lean();
}

/**
 * GET /api/admin/empresas/:empresaId/utilizadores
 *
 * Lista TODOS os utilizadores (gestores + staff) de uma empresa terceira.
 * O Super Admin usa isto no modal "Gerir Utilizadores" do painel /admin.
 *
 * Resposta 200: { utilizadores: [{ _id, nome, email, role, ativo, createdAt }] }
 */
exports.listarUtilizadoresEmpresa = async (req, res) => {
  try {
    const { empresaId } = req.params;
    const empresa = await carregarEmpresa(empresaId);
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }

    const utilizadores = await Utilizador.find({
      empresa_id: empresaId,
      eliminado_em: null,
    })
      .select('-password_hash')
      .sort({ role: 1, nome: 1 })
      .lean();

    return res.status(200).json({ utilizadores });
  } catch (err) {
    console.error('❌ listarUtilizadoresEmpresa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * POST /api/admin/empresas/:empresaId/utilizadores
 *
 * Cria um utilizador (gestor ou staff) numa empresa terceira. Caso de uso
 * principal: empresa que ficou com 0 gestores — o admin cria um novo gestor
 * diretamente.
 *
 * Body: { nome, email, password, role?, telefone?, dias_folga? }
 *
 * Regras de segurança:
 *   - Não é possível criar role 'admin' (só via setup/bootstrap).
 *   - Email único global.
 *   - empresa_id vem do URL (não do body), garantindo associação correta.
 *
 * Resposta 201: { utilizador }
 */
exports.criarUtilizadorEmpresa = async (req, res) => {
  try {
    const { empresaId } = req.params;
    const empresa = await carregarEmpresa(empresaId);
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }

    const { nome, email, password, role, telefone, dias_folga } = req.body || {};

    // Validações de presença.
    if (!nome || !email || !password) {
      return res.status(400).json({
        erro: 'Campos obrigatórios em falta: nome, email e password.',
      });
    }

    // Validação da password (mínimo 6 caracteres).
    if (String(password).length < 6) {
      return res.status(400).json({
        erro: 'A password deve ter pelo menos 6 caracteres.',
      });
    }

    // Validação do role (default 'gestor' — caso de uso principal).
    const roleFinal = role || 'gestor';

    // SEGURANÇA: Não é possível criar utilizadores com role 'admin'.
    // (Verificado antes da validação genérica de role para devolver 403
    // específico em vez de 400.)
    if (roleFinal === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível criar utilizadores com role "admin".',
      });
    }

    if (!['gestor', 'staff'].includes(roleFinal)) {
      return res.status(400).json({
        erro: 'Role inválido. Valores permitidos: gestor, staff.',
      });
    }

    // Validação de unicidade do email (único global).
    const emailNormalizado = String(email).toLowerCase().trim();
    const existente = await Utilizador.findOne({ email: emailNormalizado });
    if (existente) {
      return res.status(409).json({
        erro: `Já existe um utilizador com o email "${emailNormalizado}".`,
      });
    }

    // Valida dias_folga se vier (array de inteiros 0-6).
    let diasFolgaFinal = [];
    if (dias_folga !== undefined && dias_folga !== null) {
      if (!Array.isArray(dias_folga)) {
        return res.status(400).json({ erro: 'dias_folga deve ser um array de inteiros (0-6).' });
      }
      diasFolgaFinal = dias_folga.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    }

    // Hash da password com bcrypt.
    const password_hash = await bcrypt.hash(String(password), 10);

    const novo = await Utilizador.create({
      nome: String(nome).trim(),
      email: emailNormalizado,
      password_hash,
      empresa_id: empresaId, // association correta via URL
      role: roleFinal,
      dias_folga: diasFolgaFinal,
      telefone: telefone ? String(telefone).trim() : '',
      ativo: true,
    });

    // Resposta sem password_hash.
    const utilizador = novo.toObject();
    delete utilizador.password_hash;

    // Auditoria (empresa_id da empresa alvo, não a do admin).
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Super Admin',
      empresa_id: empresaId,
      acao: 'criar_utilizador_empresa',
      recurso: 'utilizador',
      recurso_id: utilizador._id,
      descricao: `Super Admin criou "${utilizador.nome}" (${roleFinal}) na empresa "${empresa.nome}"`,
      detalhes: { email: utilizador.email, role: utilizador.role, empresa: empresa.nome },
    });

    return res.status(201).json({ utilizador });
  } catch (err) {
    console.error('❌ criarUtilizadorEmpresa:', err.message);
    if (err.code === 11000) {
      return res.status(409).json({
        erro: 'Já existe um utilizador com este email.',
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: err.message });
    }
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/**
 * PATCH /api/admin/empresas/:empresaId/utilizadores/:utilizadorId/estado
 *
 * Alterna o estado ativo/inativo de um utilizador de uma empresa terceira.
 * O Super Admin usa isto no modal "Gerir Utilizadores".
 *
 * Body (opcional): { ativo: boolean } — se não vier, alterna.
 *
 * Regras de segurança:
 *   - Não é possível modificar o estado de um admin (403).
 *   - O utilizador tem de pertencer à empresaId do URL.
 *
 * Resposta 200: { utilizador, ativo }
 */
exports.alternarEstadoUtilizadorEmpresa = async (req, res) => {
  try {
    const { empresaId, utilizadorId } = req.params;
    const empresa = await carregarEmpresa(empresaId);
    if (!empresa) {
      return res.status(404).json({ erro: 'Empresa não encontrada.' });
    }

    if (!mongoose.isValidObjectId(utilizadorId)) {
      return res.status(400).json({ erro: 'ID de utilizador inválido.' });
    }

    const utilizador = await Utilizador.findOne({
      _id: utilizadorId,
      empresa_id: empresaId,
    });
    if (!utilizador) {
      return res.status(404).json({
        erro: 'Utilizador não encontrado (ou não pertence a esta empresa).',
      });
    }

    // SEGURANÇA: Não é possível desativar/ativar um administrador.
    if (utilizador.role === 'admin') {
      return res.status(403).json({
        erro: 'Não é possível modificar o estado de um administrador.',
      });
    }

    // Se vier `ativo` no body, usa-o; senão alterna.
    const novoEstado =
      typeof req.body?.ativo === 'boolean' ? req.body.ativo : !utilizador.ativo;

    utilizador.ativo = novoEstado;
    await utilizador.save();

    const resp = utilizador.toObject();
    delete resp.password_hash;

    // Auditoria.
    registarAuditoria({
      utilizador_id: req.user.id,
      utilizador_nome: req.user.nome || 'Super Admin',
      empresa_id: empresaId,
      acao: 'alternar_estado_utilizador_empresa',
      recurso: 'utilizador',
      recurso_id: utilizador._id,
      descricao: `Super Admin ${novoEstado ? 'ativou' : 'desativou'} "${utilizador.nome}" na empresa "${empresa.nome}"`,
      detalhes: { email: utilizador.email, ativo: novoEstado },
    });

    return res.status(200).json({ utilizador: resp, ativo: novoEstado });
  } catch (err) {
    console.error('❌ alternarEstadoUtilizadorEmpresa:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};
