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
 * Uso:
 *   node seed-admin.js
 *   (ou: npm run seed:admin)
 *
 * Variáveis de ambiente:
 *   - MONGODB_URI       — URI de ligação ao MongoDB (OBRIGATÓRIA)
 *   - ADMIN_PASSWORD    — password em claro do Super Admin (OPCIONAL).
 *                         Se não definida, é gerada uma password aleatória
 *                         segura e impressa UMA ÚNICA VEZ na consola.
 *   - EMPRESA_ID        — ID da empresa âncora do admin (OPCIONAL).
 *                         Se não definida, usa/encontra a empresa-sistema
 *                         "All2gether (Sistema)".
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
    console.log(`📋 Empresa âncora (via EMPRESA_ID): "${emp.nome}" (${emp._id})`);
    return { empresaId: String(emp._id), empresaNome: emp.nome, criada: false };
  }

  // 2. Find-or-create da empresa-sistema.
  const existente = await Empresa.findOne({ nif: EMPRESA_SISTEMA_NIF }).lean();
  if (existente) {
    console.log(`📋 Empresa-sistema encontrada: "${existente.nome}" (${existente._id})`);
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

async function main() {
  // ── 1. Validar MONGODB_URI ───────────────────────────────────────
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI não definida no ambiente (.env).');
    console.error('   Copia backend/.env.example para .env e preenche a MONGODB_URI.');
    process.exit(1);
  }

  // ── 2. Ligar ao MongoDB ──────────────────────────────────────────
  console.log('🔌 A ligar ao MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Ligado.');

  // ── 3. Resolver a empresa âncora (find-or-create da sistema) ─────
  const { empresaId, empresaNome } = await resolverEmpresaAncora();

  // ── 4. Procurar admin existente (por email único) ────────────────
  const adminExistente = await Utilizador.findOne({ email: ADMIN_EMAIL }).lean();

  // ── 5. Decidir a password ────────────────────────────────────────
  const { password, imprimirPassword } = decidirPassword(adminExistente);

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
    console.log(`✅ Super Admin ${acao}: "${admin.nome}" <${admin.email}>`);
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
    console.log(`✅ Super Admin ${acao}: "${admin.nome}" <${admin.email}>`);
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

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erro no seed do Super Admin:', err.message);
  if (err.stack) {
    console.error('\n' + err.stack);
  }
  // Garante fecho da ligação mesmo em caso de erro.
  mongoose.disconnect().finally(() => process.exit(1));
});
