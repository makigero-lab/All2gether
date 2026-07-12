/**
 * Rotas de Relatórios / Analytics — Autocell
 *
 * Prefixo montado em server.js: /api/gestor/relatorios
 *
 * Endpoints:
 *   GET  /api/gestor/relatorios/produtividade — métricas de produtividade
 *     Query: ?inicio=yyyy-mm-dd&fim=yyyy-mm-dd (default: últimos 30 dias)
 *
 *   POST /api/gestor/relatorios/ai-summary — gera um "Resumo Executivo"
 *     com IA (OpenAI / Gemini) a partir dos dados do relatório enviados
 *     no body. Best-effort: se não houver chaves de API ou a chamada
 *     falhar, devolve um placeholder estruturado gerado localmente.
 *
 * Autenticação: obrigatória (middleware `auth`).
 */
const express = require('express');
const router = express.Router();

const { auth } = require('../middleware/auth');
const {
  getRelatorioProdutividade,
  getResumoIA,
} = require('../controllers/relatorioController');

router.get('/produtividade', auth, getRelatorioProdutividade);
router.post('/ai-summary', auth, getResumoIA);

module.exports = router;
