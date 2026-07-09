/**
 * Super Admin Controller — Autocell
 *
 * Endpoints exclusivos do Super Admin (role 'admin').
 *
 * Funcionalidades:
 *   - listarEmpresas: lista todas as empresas com o gestor principal de cada uma.
 *   - impersonarGestor: gera um token JWT do gestor de uma empresa, permitindo
 *     ao Super Admin "entrar" como esse gestor para suporte/debug.
 *
 * Segurança: todas as rotas usam auth + isAdmin (só role 'admin' passa).
 */

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const { JWT_SECRET } = require('../middleware/auth');

const TOKEN_EXPIRACAO = process.env.JWT_EXPIRACAO || '7d';

/* ------------------------------------------------------------------ */
/* GET /api/admin/empresas — listar empresas com gestor principal      */
/* ------------------------------------------------------------------ */

/**
 * Lista todas as empresas (cross-tenant), cruzando com o modelo Utilizador
 * para encontrar o Gestor principal (role 'gestor') de cada uma.
 *
 * Resposta 200: { empresas: [{ _id, nome, nif, plano_ativo, createdAt, gestor: { id, nome, email } | null }] }
 */
exports.listarEmpresas = async (req, res) => {
  try {
    const empresas = await Empresa.find().sort({ createdAt: -1 }).lean();

    // Para cada empresa, procura o gestor principal.
    const empresasComGestor = await Promise.all(
      empresas.map(async (emp) => {
        const gestor = await Utilizador.findOne({
          empresa_id: emp._id,
          role: 'gestor',
          eliminado_em: null,
        })
          .select('nome email')
          .lean();

        return {
          ...emp,
          gestor: gestor
            ? { id: String(gestor._id), nome: gestor.nome, email: gestor.email }
            : null,
        };
      })
    );

    return res.status(200).json({ empresas: empresasComGestor });
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
