/**
 * Rota de Migração — Unificação de Propriedades no Tenant Principal
 *
 * TEMPORÁRIO — Rota one-off para unificar todas as propriedades sob a mesma
 * empresa do Super Admin, refletindo o modelo de negócio clarificado:
 * a operação de limpezas é centralizada e single-tenant para a equipa
 * operacional. Nomes como 'Particulares' ou 'Sweet Apartments' são apenas
 * referências de parceiros, NÃO tenants isolados.
 *
 * Lógica executada num único pedido GET:
 *
 *   1. Encontra o utilizador `admin@makigero.com` (Super Admin) e extrai o
 *      seu `empresa_id` (tenant principal).
 *
 *   2. Procura TODAS as Propriedades cujo `empresa_id` seja diferente do
 *      `empresa_id` do admin (propriedades em tenants "parceiros").
 *
 *   3. Para cada propriedade encontrada:
 *      a. Descobre o nome da empresa antiga a que pertencia (lookup por
 *         `_id` na coleção `Empresa`).
 *      b. Adiciona essa informação ao campo `observacoes` (notas), no
 *         formato: `\nParceiro Associado: [nome da empresa antiga]`.
 *         Se já tiver esta linha (idempotência), não duplica.
 *      c. Atualiza o `empresa_id` da propriedade para ser igual ao
 *         `empresa_id` do admin.
 *      d. Guarda a propriedade (`.save()`).
 *
 *   4. Após mover as propriedades, apaga as empresas redundantes que ficaram
 *      vazias (sem propriedades associadas). Nomes a apagar (case-insensitive):
 *        - 'Particulares'
 *        - 'Sweet Apartments - Rui Leal'
 *        - 'All2gether'
 *      ⚠️ NÃO apaga 'All2gether (Sistema)' (empresa-sistema que ancora o
 *      admin cross-tenant) nem a empresa principal do admin (que é a mesma).
 *
 *   5. Devolve JSON: { sucesso: true, propriedades_movidas: count, ... }
 *
 * SEGURANÇA — PROTEÇÃO OPCIONAL VIA TOKEN:
 *   Esta rota é pública por defeito (não exige JWT). Para evitar que alguém
 *   mova propriedades sem autorização, define a variável de ambiente
 *   `SETUP_EMERGENCIA_TOKEN` em produção. Se definida, a rota exige o query
 *   param `?token=<valor>` com comparação timing-safe. Se a env var não
 *   estiver definida (dev), a rota permite mas inclui um aviso na resposta.
 *
 *   ⚠️ AVISO CRÍTICO: Esta rota deve ser REMOVIDA do repositório logo que
 *   o cliente a executar em produção. Não faças commit para main com ela.
 *
 * Uso:
 *   GET /api/fix-migracao                  (se SETUP_EMERGENCIA_TOKEN não definida)
 *   GET /api/fix-migracao?token=<valor>    (se SETUP_EMERGENCIA_TOKEN definida)
 *
 * Comunicação e comentários em Português de Portugal (pt-PT).
 */

const express = require('express');
const crypto = require('crypto');

const Utilizador = require('../models/Utilizador');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */
const ADMIN_EMAIL = 'admin@makigero.com';

// Nomes de empresas a apagar após mover as propriedades (case-insensitive,
// comparados por normalização lowercase + trim). Estas são as empresas
// "parceiro" criadas pela importação que não devem existir como tenants.
const EMPRESAS_PARCEIRAS_PARA_APAGAR = [
  'particulares',
  'sweet apartments - rui leal',
  'all2gether',
];

// Nome da empresa-sistema que NUNCA deve ser apagada (ancora o admin
// cross-tenant — ver seed-admin.js / setupRoutes.js).
const EMPRESA_SISTEMA_NOME = 'All2gether (Sistema)';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compara dois strings em tempo constante (proteção contra timing attacks).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifica se uma propriedade já tem a linha "Parceiro Associado:" nas
 * observações (para idempotência — não duplicar se a rota for corrida 2x).
 *
 * @param {string} observacoes
 * @param {string} nomeEmpresaAntiga
 * @returns {boolean}
 */
function jaTemParceiroAssociado(observacoes, nomeEmpresaAntiga) {
  if (!observacoes || !nomeEmpresaAntiga) return false;
  // Procura pela linha "Parceiro Associado: [nome]" (case-insensitive).
  // Não valida o nome exato — se já tem QUALQUER linha de parceiro associado,
  // consideramos que já foi migrada para não duplicar.
  const obsLower = String(observacoes).toLowerCase();
  return obsLower.includes('parceiro associado:');
}

/**
 * Constrói o novo texto de observações com a linha de parceiro associado
 * adicionada (sem duplicar se já existir).
 *
 * @param {string} observacoesAtuais
 * @param {string} nomeEmpresaAntiga
 * @returns {string}
 */
function adicionarParceiroAssociado(observacoesAtuais, nomeEmpresaAntiga) {
  const obs = String(observacoesAtuais || '').trim();
  const linhaParceiro = `Parceiro Associado: ${nomeEmpresaAntiga}`;
  if (!obs) return linhaParceiro;
  return `${obs}\n${linhaParceiro}`;
}

/* ------------------------------------------------------------------ */
/* Rota GET / — Unificação de propriedades no tenant principal          */
/* ------------------------------------------------------------------ */
router.get('/', async (req, res) => {
  const inicio = Date.now();
  console.log('🔧 [fix-migracao] Início da unificação de propriedades...');

  // ── Proteção opcional via token (igual ao setupRoutes) ───────────
  const tokenEsperado = process.env.SETUP_EMERGENCIA_TOKEN;
  const tokenRecebido = req.query.token;
  const rotaProtegida = !!tokenEsperado;

  if (rotaProtegida) {
    if (!tokenRecebido || !timingSafeEqualStr(tokenRecebido, tokenEsperado)) {
      console.warn('⚠️  [fix-migracao] Token inválido/ausente — acesso recusado.');
      return res.status(401).json({
        sucesso: false,
        erro: 'Token de fix inválido ou ausente. Define ?token=<valor>.',
      });
    }
  } else {
    console.warn(
      '⚠️  [fix-migracao] SETUP_EMERGENCIA_TOKEN não definida — rota desprotegida. ' +
        'Define esta env var em produção para exigir ?token=...'
    );
  }

  try {
    /* -------------------------------------------------------------- */
    /* 1. Encontrar o Super Admin e o seu empresa_id                  */
    /* -------------------------------------------------------------- */
    console.log(`👤 [fix-migracao] A procurar o Super Admin <${ADMIN_EMAIL}>...`);
    const admin = await Utilizador.findOne({ email: ADMIN_EMAIL }).lean();
    if (!admin) {
      console.error(`❌ [fix-migracao] Admin <${ADMIN_EMAIL}> não encontrado.`);
      return res.status(404).json({
        sucesso: false,
        erro: `Super Admin <${ADMIN_EMAIL}> não encontrado. Corre primeiro o setup emergencial em /api/setup-emergencia.`,
      });
    }
    const empresaIdAdmin = admin.empresa_id;
    if (!empresaIdAdmin) {
      console.error(`❌ [fix-migracao] Admin não tem empresa_id associado.`);
      return res.status(500).json({
        sucesso: false,
        erro: 'Super Admin não tem empresa_id associado. Corre o setup emergencial primeiro.',
      });
    }

    // Carrega a empresa do admin para mostrar o nome na resposta.
    const empresaAdmin = await Empresa.findById(empresaIdAdmin).lean();
    if (!empresaAdmin) {
      console.error(`❌ [fix-migracao] Empresa do admin não encontrada (id=${empresaIdAdmin}).`);
      return res.status(500).json({
        sucesso: false,
        erro: 'Empresa principal do admin não encontrada na BD.',
      });
    }

    console.log(
      `✅ Admin encontrado: "${admin.email}" → empresa_id=${empresaIdAdmin} ` +
        `("${empresaAdmin.nome}")`
    );

    /* -------------------------------------------------------------- */
    /* 2. Procurar propriedades cujo empresa_id ≠ empresa_id do admin */
    /* -------------------------------------------------------------- */
    console.log('🏠 [fix-migracao] A procurar propriedades em tenants parceiros...');
    const propriedadesParaMover = await Propriedade.find({
      empresa_id: { $ne: empresaIdAdmin },
    });

    console.log(
      `📦 Encontradas ${propriedadesParaMover.length} propriedade(s) para mover ` +
        `para o tenant "${empresaAdmin.nome}".`
    );

    /* -------------------------------------------------------------- */
    /* 3. Loop: mover cada propriedade para o tenant do admin          */
    /* -------------------------------------------------------------- */
    let propriedadesMovidas = 0;
    let propriedadesSaltadas = 0;
    const detalhes = [];

    // Pré-carrega todas as empresas parceiras num mapa (id → nome) para
    // evitar N queries (uma por propriedade).
    const empresasMap = new Map();
    for (const prop of propriedadesParaMover) {
      const empIdStr = String(prop.empresa_id);
      if (!empresasMap.has(empIdStr)) {
        const emp = await Empresa.findById(prop.empresa_id).lean();
        empresasMap.set(empIdStr, emp ? emp.nome : '(empresa desconhecida)');
      }
    }

    for (const prop of propriedadesParaMover) {
      const nomeEmpresaAntiga = empresasMap.get(String(prop.empresa_id)) || '(empresa desconhecida)';

      try {
        // a. Adiciona a info do parceiro associado às observações (idempotente).
        const observacoesAtuais = prop.observacoes || '';
        if (!jaTemParceiroAssociado(observacoesAtuais, nomeEmpresaAntiga)) {
          prop.observacoes = adicionarParceiroAssociado(observacoesAtuais, nomeEmpresaAntiga);
        }

        // b. Atualiza o empresa_id para o do admin.
        prop.empresa_id = empresaIdAdmin;

        // c. Guarda a propriedade.
        await prop.save();

        propriedadesMovidas++;
        detalhes.push({
          propriedade_id: String(prop._id),
          nome: prop.nome,
          empresa_antiga: nomeEmpresaAntiga,
          empresa_nova: empresaAdmin.nome,
        });

        console.log(
          `  📦 Propriedade movida: "${prop.nome}" ` +
            `(de "${nomeEmpresaAntiga}" → "${empresaAdmin.nome}")`
        );
      } catch (err) {
        propriedadesSaltadas++;
        console.error(
          `  ❌ Erro ao mover propriedade "${prop.nome}" (${prop._id}): ${err.message}`
        );
        detalhes.push({
          propriedade_id: String(prop._id),
          nome: prop.nome,
          erro: err.message,
        });
      }
    }

    /* -------------------------------------------------------------- */
    /* 4. Apagar empresas parceiras vazias                            */
    /* -------------------------------------------------------------- */
    console.log('🗑️  [fix-migracao] A verificar empresas parceiras vazias para apagar...');

    const empresasApagadas = [];
    const empresasNaoApagadas = [];

    for (const nomeParaApagar of EMPRESAS_PARCEIRAS_PARA_APAGAR) {
      // Procura por nome (case-insensitive).
      const escapeRegex = nomeParaApagar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const empresasMatch = await Empresa.find({
        nome: { $regex: `^${escapeRegex}$`, $options: 'i' },
      }).lean();

      for (const emp of empresasMatch) {
        // ⚠️ NUNCA apagar a empresa-sistema (ancora o admin).
        if (String(emp.nome).toLowerCase() === EMPRESA_SISTEMA_NOME.toLowerCase()) {
          empresasNaoApagadas.push({
            nome: emp.nome,
            id: String(emp._id),
            motivo: 'Empresa-sistema (protegida — ancora o Super Admin)',
          });
          continue;
        }

        // ⚠️ NUNCA apagar a empresa principal do admin (mesmo que o nome
        // coincida — ex: se o admin estiver numa empresa chamada "All2gether").
        if (String(emp._id) === String(empresaIdAdmin)) {
          empresasNaoApagadas.push({
            nome: emp.nome,
            id: String(emp._id),
            motivo: 'Empresa principal do admin (não pode ser apagada)',
          });
          continue;
        }

        // Verifica se a empresa tem propriedades associadas.
        const countProps = await Propriedade.countDocuments({ empresa_id: emp._id });
        if (countProps > 0) {
          empresasNaoApagadas.push({
            nome: emp.nome,
            id: String(emp._id),
            motivo: `Ainda tem ${countProps} propriedade(s) associada(s)`,
          });
          continue;
        }

        // Tudo OK — apaga a empresa.
        await Empresa.deleteOne({ _id: emp._id });
        empresasApagadas.push({ nome: emp.nome, id: String(emp._id) });
        console.log(`  🗑️  Empresa apagada: "${emp.nome}" (${emp._id})`);
      }
    }

    const duracaoMs = Date.now() - inicio;
    console.log(
      `🎉 [fix-migracao] Concluído em ${duracaoMs}ms. ` +
        `${propriedadesMovidas} propriedade(s) movida(s), ` +
        `${propriedadesSaltadas} saltada(s) por erro, ` +
        `${empresasApagadas.length} empresa(s) apagada(s), ` +
        `${empresasNaoApagadas.length} empresa(s) protegida(s)/não vazia(s).`
    );

    /* -------------------------------------------------------------- */
    /* Resposta JSON final                                            */
    /* -------------------------------------------------------------- */
    return res.json({
      sucesso: true,
      propriedades_movidas: propriedadesMovidas,
      mensagem: 'Unificação concluída',
      // Campos extra (úteis para diagnóstico):
      admin_email: admin.email,
      admin_empresa_id: String(empresaIdAdmin),
      admin_empresa_nome: empresaAdmin.nome,
      propriedades_encontradas: propriedadesParaMover.length,
      propriedades_saltadas_erro: propriedadesSaltadas,
      empresas_apagadas: empresasApagadas,
      empresas_nao_apagadas: empresasNaoApagadas,
      detalhes,
      duracao_ms: duracaoMs,
      rota_protegida_por_token: rotaProtegida,
      aviso:
        '⚠️ Endpoint TEMPORÁRIO de migração. Todas as propriedades foram movidas para o tenant ' +
        `principal do admin ("${empresaAdmin.nome}"). ` +
        'REMOVE esta rota (routes/fixMigracaoRoutes.js + mounting em server.js) após confirmação.',
    });
  } catch (err) {
    console.error('❌ [fix-migracao] Erro fatal:', err.message);
    if (process.env.NODE_ENV !== 'production' && err.stack) {
      console.error(err.stack);
    }
    return res.status(500).json({
      sucesso: false,
      erro: err.message,
    });
  }
});

module.exports = router;
