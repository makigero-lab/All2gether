/**
 * Seed do Super Admin — All2gether
 *
 * Cria (ou atualiza) o utilizador Super Admin da plataforma, que é a conta
 * utilizada pelo Single Sign-On (SSO) com o portal Autocell para iniciar
 * sessão no painel /admin em produção.
 *
 *   O endpoint GET /api/auth/sso procura o admin por:
 *       Utilizador.findOne({ email, role: 'admin' })
 *   Logo, para o SSO funcionar, TEM de existir na BD um utilizador com:
 *       - email  = admin@makigero.com
 *       - role   = 'admin'  (Super Admin da PLATAFORMA — cross-tenant)
 *       - ativo  = true
 *
 * AUTOMATIZAÇÃO NO ARRANQUE (Render free, sem shell):
 *   O script é corrido automaticamente antes do servidor através do script
 *   `start` do package.json:  "node seed-admin.js && node server.js".
 *   Como o Render free reinicia/redeploya periodicamente, o script corre em
 *   CADA arranque. Por isso:
 *     • É IDEMPOTENTE (upsert) — re-executar não causa danos.
 *     • MANTÉM a password existente se o admin já tiver hash (não regenera
 *       a cada arranque, para não invalidar sessões/fallback de login).
 *     • Tem RETRY de conexão ao MongoDB (cold starts do Atlas no Render free
 *       podem fazer a 1ª tentativa falhar transitóriamente).
 *     • Modo CONCISO: quando o admin já existe e está correto, emite apenas
 *       uma linha de log (reduz ruído nos logs de arranque do Render).
 *
 * Notas arquitecturais:
 *   - O modelo Utilizador exige `empresa_id` (required: true). Contudo, o
 *     Super Admin é cross-tenant ("não tem empresa_id de operações" — ver
 *     docs/ARQUITETURA.md §3). Para satisfazer o modelo sem associar o admin
 *     a um tenant real de cliente, é usada uma empresa-sistema dedicada
 *     "All2gether (Sistema)" (NIF 'SISTEMA'), criada automaticamente se não
 *     existir. O operador pode forçar outra empresa via variável EMPRESA_ID.
 *   - `password_hash` é opcional no modelo (permite migrar utilizadores sem
 *     password), mas o SSO exige uma sessão válida. Ainda que o SSO NÃO use
 *     a password (autentica por JWT externo do Autocell), define-se sempre
 *     uma password bcrypt para que o admin possa também entrar pelo login
 *     normal (POST /api/auth/login) como fallback de emergência.
 *
 * Uso (manual):
 *   node seed-admin.js
 *   (ou: npm run seed:admin)
 *
 * Uso (automático no arranque do Render):
 *   npm start   →  "node seed-admin.js && node server.js"
 *
 * Variáveis de ambiente:
 *   - MONGODB_URI       — URI de ligação ao MongoDB (OBRIGATÓRIA)
 *   - ADMIN_PASSWORD    — password em claro do Super Admin (OPCIONAL).
 *                         Se não definida, é gerada uma password aleatória
 *                         segura e impressa UMA ÚNICA VEZ na consola.
 *   - EMPRESA_ID        — ID da empresa âncora do admin (OPCIONAL).
 *                         Se não definida, usa/encontra a empresa-sistema
 *                         "All2gether (Sistema)".
 *   - SEED_ADMIN_RETRIES — nº de tentativas de ligação ao MongoDB em caso
 *                         de falha transitória (default: 3). Entre tentativas
 *                         há backoff exponencial (1s, 2s, 4s, ...).
 */

require('dotenv').config();

const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Utilizador = require('./models/Utilizador');
const Empresa = require('./models/Empresa');

// ── Constantes do Super Admin ────────────────────────────────────────
const ADMIN_EMAIL = 'admin@makigero.com';
const ADMIN_NOME = 'Super Admin';
const ADMIN_ROLE = 'admin'; // Super Admin da PLATAFORMA (cross-tenant)

// Empresa-sistema que ancora o admin (não é um tenant de cliente).
const EMPRESA_SISTEMA_NOME = 'All2gether (Sistema)';
const EMPRESA_SISTEMA_NIF = 'SISTEMA';

// Custo do bcrypt (igual ao resto do codebase — ver authController /
// superAdminController, ambos usam bcrypt.hash(pw, 10)).
const BCRYPT_COST = 10;

// Comprimento da password aleatória gerada (em bytes antes de base64url).
const RANDOM_PASSWORD_BYTES = 24;

// ── Retry de ligação ao MongoDB (robustez para arranque no Render free) ──
const RETRY_TENTATIVAS = Math.max(1, parseInt(process.env.SEED_ADMIN_RETRIES || '3', 10) || 3);
const RETRY_BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, ...

/**
 * Espera N milissegundos (para backoff entre tentativas de ligação).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Liga ao MongoDB com retry e backoff exponencial.
 *
 * No Render free, o MongoDB Atlas pode ter cold starts ou flutuações
 * momentâneas de rede. Sem retry, a 1ª tentativa pode falhar e o servidor
 * nunca arranca (porque o script `start` usa `&&` — fail-fast). Com retry,
 * toleramos flutuações transitórias sem desativar o fail-fast para falhas
 * persistentes.
 *
 * @param {string} uri
 * @returns {Promise<void>}
 */
async function ligarMongoComRetry(uri) {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= RETRY_TENTATIVAS; tentativa++) {
    try {
      await mongoose.connect(uri);
      return; // sucesso
    } catch (err) {
      ultimoErro = err;
      if (tentativa < RETRY_TENTATIVAS) {
        const espera = RETRY_BACKOFF_BASE_MS * Math.pow(2, tentativa - 1);
        console.warn(
          `⚠️  Ligação ao MongoDB falhou (tentativa ${tentativa}/${RETRY_TENTATIVAS}): ${err.message}.`
        );
        console.warn(`   A tentar novamente em ${espera}ms...`);
        await sleep(espera);
      }
    }
  }
  // Esgotadas as tentativas — lança o último erro (fail-fast no `&&`).
  throw ultimoErro;
}

/**
 * Gera uma password aleatória segura (base64url, sem caracteres problemáticos).
 * @returns {string} password em claro
 */
function gerarPasswordAleatoria() {
  return crypto.randomBytes(RANDOM_PASSWORD_BYTES).toString('base64url');
}

/**
 * Resolve o empresa_id âncora do Super Admin.
 *
 * Ordem de precedência:
 *   1. EMPRESA_ID (env) — override explícito do operador.
 *   2. Empresa-sistema "All2gether (Sistema)" (find-or-create).
 *
 * @returns {Promise<{ empresaId: string, empresaNome: string, criada: boolean }>}
 */
async function resolverEmpresaAncora() {
  // 1. Override explícito via env (mesma convenção do seedChecklists.js).
  if (process.env.EMPRESA_ID) {
    const overrideId = String(process.env.EMPRESA_ID).trim();
    if (!mongoose.isValidObjectId(overrideId)) {
      throw new Error(`EMPRESA_ID inválido (não é um ObjectId válido): "${overrideId}"`);
    }
    const emp = await Empresa.findById(overrideId).lean();
    if (!emp) {
      throw new Error(`EMPRESA_ID="${overrideId}" não corresponde a nenhuma empresa existente.`);
    }
    return { empresaId: String(emp._id), empresaNome: emp.nome, criada: false };
  }

  // 2. Find-or-create da empresa-sistema.
  const existente = await Empresa.findOne({ nif: EMPRESA_SISTEMA_NIF }).lean();
  if (existente) {
    return { empresaId: String(existente._id), empresaNome: existente.nome, criada: false };
  }

  const nova = await Empresa.create({
    nome: EMPRESA_SISTEMA_NOME,
    nif: EMPRESA_SISTEMA_NIF,
    // Empresa-sistema: ativa (não bloqueia nada) e não apagada.
    // Não tem propriedades/tarefas — serve apenas de âncora para o admin.
    ativa: true,
    apagada: false,
  });
  console.log(`✨ Empresa-sistema criada: "${nova.nome}" (${nova._id})`);
  return { empresaId: String(nova._id), empresaNome: nova.nome, criada: true };
}

/**
 * Decide a password a usar para o admin nesta execução.
 *
 *   - Se ADMIN_PASSWORD (env) estiver definida → usa-a (operator quer definir
 *    /resetar a password explicitamente).
 *   - Senão, se o admin já existir E já tiver password_hash → mantém a
 *     password atual (NÃO regenera — evita mudar a password a cada execução).
 *   - Senão (admin novo ou sem password) → gera uma aleatória segura e
 *     marca para impressão única na consola.
 *
 * @param {Object|null} adminExistente - documento Utilizador já existente (ou null)
 * @returns {{ password: string|null, imprimirPassword: boolean }}
 */
function decidirPassword(adminExistente) {
  const envPassword = process.env.ADMIN_PASSWORD
    ? String(process.env.ADMIN_PASSWORD).trim()
    : '';

  if (envPassword) {
    // Operator definiu a password explicitamente → usar e NÃO imprimir
    // (já é conhecida; imprimir expô-la-ia nos logs).
    return { password: envPassword, imprimirPassword: false };
  }

  if (adminExistente && adminExistente.password_hash) {
    // Admin já existe e já tem password → manter (não mexer).
    return { password: null, imprimirPassword: false };
  }

  // Admin novo OU sem password → gerar aleatória e imprimir uma vez.
  return { password: gerarPasswordAleatoria(), imprimirPassword: true };
}

/**
 * Verifica se o admin existente já está exatamente no estado pretendido.
 * Usado para o modo conciso: se nada mudou, emite só uma linha de log
 * (reduz ruído nos arranques repetidos do Render free).
 *
 * @param {Object} admin - documento Utilizador existente (lean)
 * @param {string} empresaId - empresa_id pretendida
 * @returns {boolean} true se o admin já está correto (sem alterações)
 */
function adminEstaCorreto(admin, empresaId) {
  return (
    admin.nome === ADMIN_NOME &&
    admin.role === ADMIN_ROLE &&
    String(admin.empresa_id) === String(empresaId) &&
    admin.ativo === true &&
    admin.eliminado_em === null &&
    !!admin.password_hash
  );
}

async function main() {
  // ── 1. Validar MONGODB_URI ───────────────────────────────────────
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI não definida no ambiente. Copia backend/.env.example para .env e preenche a MONGODB_URI.'
    );
  }

  // ── 2. Ligar ao MongoDB (com retry para cold starts do Render free) ──
  console.log('🔌 [seed-admin] A ligar ao MongoDB...');
  await ligarMongoComRetry(uri);
  console.log('✅ [seed-admin] Ligado ao MongoDB.');

  // ── 3. Resolver a empresa âncora (find-or-create da sistema) ─────
  const { empresaId, empresaNome } = await resolverEmpresaAncora();

  // ── 4. Procurar admin existente (por email único) ────────────────
  const adminExistente = await Utilizador.findOne({ email: ADMIN_EMAIL }).lean();

  // ── 5. Decidir a password ────────────────────────────────────────
  const { password, imprimirPassword } = decidirPassword(adminExistente);

  // ── 5b. Modo conciso: se o admin já existe e está correto (e o
  //       operador não forçou redefinição via ADMIN_PASSWORD), não há
  //       nada a escrever na BD — saímos em silêncio para não poluir os
  //       logs de arranque do Render free.
  if (adminExistente && !password && adminEstaCorreto(adminExistente, empresaId)) {
    console.log(
      `ℹ️  [seed-admin] Super Admin já existe e está correto — sem alterações (${ADMIN_EMAIL}).`
    );
    return; // main() termina; o fecho da BD fica a cargo do run().
  }

  // ── 6. Calcular hash bcrypt (se houver password nova) ────────────
  let passwordHash = adminExistente ? adminExistente.password_hash : null;
  if (password) {
    passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  }

  // ── 7. Upsert (criar ou atualizar) ───────────────────────────────
  let admin;
  let acao;

  if (!adminExistente) {
    // CRIAR novo Super Admin.
    admin = await Utilizador.create({
      nome: ADMIN_NOME,
      email: ADMIN_EMAIL,
      password_hash: passwordHash,
      empresa_id: empresaId,
      role: ADMIN_ROLE,
      ativo: true,
    });
    acao = 'criado';
    console.log(`✅ [seed-admin] Super Admin ${acao}: "${admin.nome}" <${admin.email}>`);
  } else {
    // ATUALIZAR Super Admin existente (upsert).
    // Garante nome, role, empresa_id, ativo e password_hash corretos.
    const atualizado = await Utilizador.findByIdAndUpdate(
      adminExistente._id,
      {
        $set: {
          nome: ADMIN_NOME,
          role: ADMIN_ROLE,
          empresa_id: empresaId,
          ativo: true,
          // Só reescreve a hash se veio password nova (caso contrário
          // mantém a hash existente — ver decidirPassword).
          ...(passwordHash ? { password_hash: passwordHash } : {}),
          // Reativa se tiver sido soft-deleted anteriormente.
          eliminado_em: null,
        },
      },
      { new: true }
    ).lean();
    admin = atualizado;
    acao = 'atualizado';
    console.log(`✅ [seed-admin] Super Admin ${acao}: "${admin.nome}" <${admin.email}>`);
  }

  // ── 8. Resumo (SEM expor a hash nem a password) ──────────────────
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('📋 Resumo do Super Admin:');
  console.log(`   • ID         : ${admin._id}`);
  console.log(`   • Nome       : ${admin.nome}`);
  console.log(`   • Email      : ${admin.email}`);
  console.log(`   • Role       : ${admin.role}`);
  console.log(`   • Empresa    : "${empresaNome}" (${empresaId})`);
  console.log(`   • Ativo      : ${admin.ativo ? 'sim' : 'não'}`);
  console.log(`   • Password   : ${admin.password_hash ? 'definida (bcrypt)' : '❌ NÃO definida'}`);
  console.log(`   • Ação       : ${acao}`);
  console.log('─────────────────────────────────────────────────────────');

  // ── 9. Imprimir password gerada (apenas se auto-gerada) ──────────
  if (imprimirPassword && password) {
    console.log('\n🔐 PASSWORD ALEATÓRIA GERADA (guarda AGORA em segurança):');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`   ${password}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log('⚠️  Esta password NÃO voltará a ser mostrada.');
    console.log('   Para definir uma password à tua escolha, define a variável');
    console.log('   de ambiente ADMIN_PASSWORD antes de correr o script.');
    console.log('');
    console.log('   Nota: o SSO (Autocell) NÃO usa esta password — autentica-se');
    console.log('   via JWT externo. A password serve apenas como fallback de');
    console.log('   emergência pelo login normal (POST /api/auth/login).');
  } else if (acao === 'atualizado' && !password) {
    console.log('\nℹ️  Password mantida (admin já existia com password definida).');
    console.log('   Para a redefinir, define ADMIN_PASSWORD no ambiente e re-corre.');
  }

  console.log('\n🎉 Seed do Super Admin concluído com sucesso!');
}

/**
 * Wrapper que garante o FECHO da ligação à BD em TODOS os caminhos:
 *   - Sucesso → disconnect + exit(0).
 *   - Erro (validação, conexão, runtime) → disconnect + exit(1).
 *
 * Isto é crítico porque o script corre como subprocesso do `npm start`
 * ("node seed-admin.js && node server.js"). Se a ligação não for fechada,
 * o processo `node seed-admin.js` não termina e o `&&` nunca passa para
 * o `node server.js` → o servidor nunca arranca.
 *
 * O `finally` garante o fecho mesmo se main() lançar de forma inesperada.
 */
async function run() {
  try {
    await main();
  } catch (err) {
    console.error('❌ [seed-admin] Erro no seed do Super Admin:', err.message);
    if (err.stack && process.env.NODE_ENV !== 'production') {
      console.error('\n' + err.stack);
    }
    throw err; // re-lança para o catch externo fazer exit(1)
  } finally {
    // Garante SEMPRE o fecho da ligação à BD (sucesso OU erro), mesmo
    // que main() tenha lançado antes de algumas operações.
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (disconnectErr) {
      // Ignora erros no disconnect — o process.exit() força o fecho.
      console.error('⚠️  [seed-admin] Erro ao fechar a ligação à BD:', disconnectErr.message);
    }
  }
}

run().then(
  () => {
    // Sucesso: o `&&` do package.json prossegue para `node server.js`.
    process.exit(0);
  },
  (err) => {
    // Erro: o `&&` NÃO prossegue → o servidor não arranca (fail-fast).
    // Isto é intencional: se o seed falhar persistentemente, é melhor
    // o deploy falhar alto (visível nos logs) do que arrancar sem admin.
    void err; // já loggado no run()
    process.exit(1);
  }
);
