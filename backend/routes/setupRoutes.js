/**
 * Rota de Setup Emergencial — All2gether
 *
 * TEMPORÁRIO — Rota one-off para executar o setup inicial em produção quando
 * não há acesso a terminais Cloud (limitação de tier gratuito) nem ambiente
 * local configurado. Faz duas coisas num único pedido GET:
 *
 *   A) UPSERT do Super Admin (admin@makigero.com):
 *      - Resolve (find-or-create) a empresa-sistema "All2gether (Sistema)"
 *        que ancora o admin cross-tenant (igual ao seed-admin.js).
 *      - Gera uma password aleatória alfanumérica de 12 caracteres.
 *      - Faz o hash bcrypt (cost 10) e guarda em `password_hash`.
 *      - Cria o admin se não existir, ou atualiza a password se já existir.
 *      - Devolve a password em texto limpo na resposta JSON (para o operador
 *        a copiar do browser).
 *
 *   B) IMPORTAÇÃO dos 47 clientes (JSON embutido):
 *      - Para cada cliente: resolve (find-or-create) a Empresa por nome
 *        (case-insensitive); cria a Propriedade associada.
 *      - Mapeamento: titulo→nome, morada→morada, nome_responsavel→
 *        nome_responsavel, contacto→contacto, frequencia+gps→observacoes.
 *      - Idempotência parcial: empresas não duplicam; propriedades duplicadas
 *        (mesmo nome + empresa + morada) são saltadas (não contam como erro
 *        nem como inserida).
 *
 * SEGURANÇA — PROTEÇÃO OPCIONAL VIA TOKEN:
 *   Esta rota é pública por defeito (não exige JWT). Para evitar que alguém
 *   reescreva a password do admin sem autorização, define a variável de
 *   ambiente `SETUP_EMERGENCIA_TOKEN` em produção. Se definida, a rota passa
 *   a exigir o query param `?token=<valor>` com comparação timing-safe.
 *   Se a env var não estiver definida (dev), a rota permite mas inclui um
 *   aviso na resposta.
 *
 *   ⚠️ AVISO CRÍTICO: Esta rota deve ser REMOVIDA do repositório logo que
 *   o setup esteja confirmado. Não faças commit para main com ela ativa.
 *
 * Uso:
 *   GET /api/setup-emergencia                  (se SETUP_EMERGENCIA_TOKEN não definida)
 *   GET /api/setup-emergencia?token=<valor>    (se SETUP_EMERGENCIA_TOKEN definida)
 *
 * Comunicação e comentários em Português de Portugal (pt-PT).
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const Utilizador = require('../models/Utilizador');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Constantes do Super Admin (iguais ao seed-admin.js)                */
/* ------------------------------------------------------------------ */
const ADMIN_EMAIL = 'admin@makigero.com';
const ADMIN_NOME = 'Super Admin';
const ADMIN_ROLE = 'admin'; // Super Admin da PLATAFORMA (cross-tenant)

// Empresa-sistema que ancora o admin (NÃO é a empresa operacional
// "All2gether" dos clientes — são entidades distintas). Igual ao seed-admin.
const EMPRESA_SISTEMA_NOME = 'All2gether (Sistema)';
const EMPRESA_SISTEMA_NIF = 'SISTEMA';

// Custo do bcrypt (igual ao resto do codebase).
const BCRYPT_COST = 10;

/* ------------------------------------------------------------------ */
/* JSON dos 47 clientes a importar                                     */
/* ------------------------------------------------------------------ */
const CLIENTES = [
  { titulo: 'Karin - Lapa', empresa: 'Particulares', nome_responsavel: 'Karin* inglês', contacto: '+972 54-738-7588', morada: 'Rua São João da mata 112c 2a Lapa', frequencia: '2feira - Às 09h-11h30 (2 horas) começa dia 31' },
  { titulo: 'D. Helena - Estoril', empresa: 'Particulares', nome_responsavel: 'D. Helena', contacto: '961 128 088', morada: 'Rua do Moinho 1(lote 5), r/c dto Galiza 2765-339', frequencia: '15 em 15dias' },
  { titulo: 'Rita - Benfica', empresa: 'Particulares', nome_responsavel: 'Rita', contacto: '926 053 563', morada: 'Calçada do Tojal 115, 6F Benfica', frequencia: 'Toda terça-feira' },
  { titulo: 'Avital - Lapa', empresa: 'Particulares', nome_responsavel: 'Avital Ingles (Mike)', contacto: '910 116 849', morada: 'R.da Arriaga 8, 1E Lapa', frequencia: 'Toda terça-feira' },
  { titulo: 'D. Paula', empresa: 'Particulares', nome_responsavel: '', contacto: '933 968 978', morada: 'R Nau de Catrineta 4, 2D 1990-165', frequencia: 'Toda quarta-feira' },
  { titulo: 'Pais D. Paula', empresa: 'Particulares', nome_responsavel: '', contacto: '', morada: 'Passeio Adamastor 6, 4B - Intercomunicador 042', frequencia: 'Toda quarta-feira' },
  { titulo: 'Ana M. Restelo', empresa: 'Particulares', nome_responsavel: 'Ana Mendes', contacto: '962 936 036', morada: 'Rua Pêro de Alenquer 46/48 2M - Restelo', frequencia: 'Toda quarta-feira' },
  { titulo: 'Maria Lucília - 7rios', empresa: 'Particulares', nome_responsavel: 'Maria Lucília', contacto: '965 409 994', morada: 'Rua Doutor Antônio Martins 40, 4D 1070-094', frequencia: '15 em 15 dias *quinta' },
  { titulo: 'Lior Pick - Saldanha', empresa: 'Particulares', nome_responsavel: 'Lior Pick', contacto: '+351 935 545 448', morada: 'Rua Antonio Enes 10, 2dto, Saldanha', frequencia: '15 em 15 dias - 1h30 de limpeza' },
  { titulo: 'Lior Pick', empresa: 'Particulares', nome_responsavel: 'Lior Pick', contacto: '+351 935 545 448', morada: 'Av 24 de Julho 114 1° andar', frequencia: '1x por semana (Segunda) 11h  1h/1h30 de limpeza' },
  { titulo: 'Lior Pick Studio', empresa: 'Particulares', nome_responsavel: 'Lior Pick', contacto: '+351 935 545 448', morada: 'Rua Fernandes Tomás 2, Lisboa', frequencia: '' },
  { titulo: 'Escritório Laranjeiras', empresa: 'Particulares', nome_responsavel: 'Tânia', contacto: '21 802 9424', morada: 'Estrada da Luz 90, 1?', frequencia: '' },
  { titulo: 'Sta Apolónia', empresa: 'Particulares', nome_responsavel: 'D. Maria Gama', contacto: '961464401', morada: 'Rua Cruzado Osberno 9, 2d', frequencia: '' },
  { titulo: 'D. Isabel - Parque das Nações', empresa: 'Particulares', nome_responsavel: '', contacto: '935142674', morada: 'Rua da Ilha dos Amores 22, 4 dt/ Pizzaria Luzzo Parque da,s Nações', frequencia: 'Quintas feiras +-2horas' },
  { titulo: 'Sara Choen- Parque das Nações', empresa: 'Particulares', nome_responsavel: 'Sara Choen', contacto: '915984828', morada: 'Alameda dos oceanos 29 6A (Predio do edosuchi)', frequencia: '' },
  { titulo: 'Marisa Sacavem', empresa: 'Particulares', nome_responsavel: 'Marisa', contacto: '965250884', morada: 'Tv dos Combatentes da Grande Guerra 1, cave drto', frequencia: '' },
  { titulo: 'Carmo - Contesse Lisbone', empresa: 'All2gether', morada: 'Rua da Condessa 24', gps: '' },
  { titulo: 'Graça - Rita & Marino Apartment', empresa: 'All2gether', morada: 'Escadinhas de Damasceno Monteiro 12, 1º Andar, Graça', gps: 'R damasceno Monteiro 76' },
  { titulo: 'Santos - Neighborhood Apartment', empresa: 'All2gether', morada: 'Beco do Olival 1, 1200-737', gps: 'Rua do Olival 119' },
  { titulo: 'Estácio - All2gether Apartment', empresa: 'All2gether', morada: 'Rua Estácio da Veiga 19, Cv/Esq 1170-120 Penha de França', gps: '' },
  { titulo: 'M. Escadinhas - Loft Mouraria', empresa: 'All2gether', morada: 'Beco dos Surradores 10, 2/Esq Lisboa', gps: 'Poço do Borratém 25, Lisboa' },
  { titulo: 'Sacavém - Charmoso Apartamento', empresa: 'All2gether', morada: 'Rua Manuel Teixeira Gomes 20, Rc/Dir', gps: '' },
  { titulo: 'Oeiras - Maison Soleil', empresa: 'All2gether', morada: 'Rua Abel Manta 24, 1/Esq 2780-174 Oeiras', gps: '' },
  { titulo: 'Amadora Goa - Apartamento Goa', empresa: 'All2gether', morada: 'Praceta de Goa 6, 2/Esq 2700-425 Amadora', gps: '' },
  { titulo: 'Amadora Flat 3 - Amadora Apartments 3', empresa: 'All2gether', morada: 'Avenida dos Combatentes da Grande Guerra 42, apto3. 2700-418 Amadora', gps: '' },
  { titulo: 'Amadora Sofia Flat 5 - Amadora Apartments 5', empresa: 'All2gether', morada: 'Avenida dos Combatentes da Grande Guerra 42, apto 5. 2700-418 Amadora', gps: '' },
  { titulo: 'Mem Martins -  Wicalia Shortstays', empresa: 'All2gether', morada: 'Rua Antero Quental 11, 6/A 2725-581 Mem Martins', gps: 'Rua Professor Agostinho da Silva 26, Mem Martins' },
  { titulo: 'Yellow House', empresa: 'All2gether', morada: 'Rua da Palmeira 46, 1/Esq 1200-314', gps: '' },
  { titulo: 'Suprema (1, 2 e 3) - Suprema Lofts', empresa: 'All2gether', morada: 'Rua das Farinhas 5, Mouraria 1100-179', gps: 'Estacinamento Chão do Loureiro' },
  { titulo: 'Santos Brunos -', empresa: 'All2gether', morada: 'Tv dos Brunos 25, 3ºAndar', gps: '' },
  { titulo: 'Cortes Reais Guesthouse', empresa: 'All2gether', morada: 'Rua dos Cortes Reais 9 1170-395 São Vicente', gps: '' },
  { titulo: 'Estela', empresa: 'All2gether', morada: 'Rua da Condessa 46 1esq', gps: '' },
  { titulo: 'Vera', empresa: 'All2gether', morada: 'Rua da Condessa 46 5dt', gps: '' },
  { titulo: 'Alfama', empresa: 'All2gether', morada: 'Rua das Escolas Gerais 2, Alfama', gps: 'Rua das Escolas Gerais 57, Alfama' },
  { titulo: 'Alta de Lisboa - Alta de Lisboa Apartment', empresa: 'All2gether', morada: 'Av Sergio Vieira de Mello 4, Rc/B 1750-341', gps: '' },
  { titulo: 'Parede -', empresa: 'All2gether', morada: 'Av. da República 13, bloco B 1⁰C 2775-271 Parede', gps: '' },
  { titulo: 'Escritório Amadora ?', empresa: 'All2gether', nome_responsavel: 'Natacha Nepomuceno', contacto: '914325507', morada: '', frequencia: '' },
  { titulo: 'Leonor Benfica ?', empresa: 'All2gether', nome_responsavel: '', contacto: '+244 923 833 665/ +351 962 378 396', morada: 'Largo Conde Bonfim n 3, 1° Direito 1500-200 Lisboa', frequencia: 'Quinzenal (2h)' },
  { titulo: 'Escritorio', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua de Arroios 84, Arroios', gps: 'Rua Marquês da Silva 99' },
  { titulo: 'Good Vibes', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua Maria 67, Rc 1170-287 Anjos', gps: '' },
  { titulo: 'Rising Sun', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua Rui Barbosa 11, 2/dir 1170-376 São Vicente', gps: '' },
  { titulo: 'Happy Days', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua Fernão de Magalhães 43, 2º São Vicente', gps: '' },
  { titulo: 'Carpe Dien/ Sweet Dreams', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua do Passadiço 47 1150-255 Lisboa', gps: '' },
  { titulo: 'Cozy Garden', empresa: 'Sweet Apartments - Rui Leal', morada: 'Rua Dr Teofilo Braga 52, 2/dir 1200-654 Lapa', gps: '' },
  { titulo: 'Lovely Home', empresa: 'Sweet Apartments - Rui Leal', morada: 'Av Almirante Reis 160, Rc/Dir 1900-214 Arroios', gps: '' },
  { titulo: 'Free Spirit', empresa: 'Sweet Apartments - Rui Leal', morada: 'Travessa Verbena 6 1300-566 Ajuda', gps: '' },
  { titulo: 'Lisbon Enjoy', empresa: 'Sweet Apartments - Rui Leal', morada: 'Travessa Verbena 8, 2/Dir 1300-566 Ajuda', gps: '' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Gera uma password aleatória alfanumérica (A-Za-z0-9) de `tamanho` caracteres.
 * Usa crypto.randomBytes (CSPRNG) e mapeia para o charset sem viés modular
 * significativo (charset tem 62 chars; bytes[i] % 62 é aceitável para 12 chars).
 *
 * Alfanumérico evita caracteres especiais que confundem em copy-paste
 * (ex.: O vs 0, I vs l, - vs _).
 *
 * @param {number} tamanho
 * @returns {string} password em texto limpo
 */
function gerarPasswordAleatoria(tamanho = 12) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(tamanho);
  let pwd = '';
  for (let i = 0; i < tamanho; i++) {
    pwd += charset[bytes[i] % charset.length];
  }
  return pwd;
}

/**
 * Normaliza o nome da empresa (trim). Usado para lookup case-insensitive.
 * @param {string} nome
 * @returns {string}
 */
function normalizarNomeEmpresa(nome) {
  return String(nome || '').trim();
}

/**
 * Resolve (ou cria) uma Empresa pelo nome (case-insensitive), com cache.
 * Idempotente: se a empresa já existir, reutiliza-a (não duplica).
 *
 * @param {string} nomeEmpresa
 * @param {Map<string, {empresa: any, criada: boolean}>} cache
 * @returns {Promise<{ empresa: any, criada: boolean }>}
 */
async function resolverOuCriarEmpresa(nomeEmpresa, cache) {
  const chave = nomeEmpresa.toLowerCase();
  if (cache.has(chave)) return cache.get(chave);

  // Lookup case-insensitive via regex escapado.
  const escapeRegex = nomeEmpresa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existente = await Empresa.findOne({
    nome: { $regex: `^${escapeRegex}$`, $options: 'i' },
  }).lean();

  let resultado;
  if (existente) {
    resultado = { empresa: existente, criada: false };
  } else {
    const nova = await Empresa.create({
      nome: nomeEmpresa,
      ativa: true,
      apagada: false,
    });
    resultado = { empresa: nova, criada: true };
  }
  cache.set(chave, resultado);
  return resultado;
}

/**
 * Constrói o texto das notas (observacoes) com a frequência e o GPS.
 * @param {{ frequencia?: string, gps?: string }} c
 * @returns {string}
 */
function construirNotas(c) {
  const linhas = [];
  if (c.frequencia && String(c.frequencia).trim()) {
    linhas.push(`Frequência: ${String(c.frequencia).trim()}`);
  }
  if (c.gps && String(c.gps).trim()) {
    linhas.push(`GPS: ${String(c.gps).trim()}`);
  }
  return linhas.join('\n');
}

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

/* ------------------------------------------------------------------ */
/* Rota GET / — Setup emergencial (admin + importação de clientes)     */
/* ------------------------------------------------------------------ */
router.get('/', async (req, res) => {
  const inicio = Date.now();
  console.log('🔧 [setup-emergencia] Início do setup emergencial...');

  // ── Proteção opcional via token ──────────────────────────────────
  const tokenEsperado = process.env.SETUP_EMERGENCIA_TOKEN;
  const tokenRecebido = req.query.token;
  const rotaProtegida = !!tokenEsperado;

  if (rotaProtegida) {
    if (!tokenRecebido || !timingSafeEqualStr(tokenRecebido, tokenEsperado)) {
      console.warn('⚠️  [setup-emergencia] Token inválido/ausente — acesso recusado.');
      return res.status(401).json({
        sucesso: false,
        erro: 'Token de setup inválido ou ausente. Define ?token=<valor>.',
      });
    }
  } else {
    console.warn(
      '⚠️  [setup-emergencia] SETUP_EMERGENCIA_TOKEN não definida — rota desprotegida. ' +
        'Define esta env var em produção para exigir ?token=...'
    );
  }

  try {
    /* -------------------------------------------------------------- */
    /* A) UPSERT do Super Admin                                       */
    /* -------------------------------------------------------------- */
    console.log('👤 [setup-emergencia] A) Upsert do Super Admin...');

    // A.1. Resolve (find-or-create) a empresa-sistema "All2gether (Sistema)".
    let empresaSistema = await Empresa.findOne({ nif: EMPRESA_SISTEMA_NIF }).lean();
    let empresaSistemaCriada = false;
    if (!empresaSistema) {
      empresaSistema = await Empresa.create({
        nome: EMPRESA_SISTEMA_NOME,
        nif: EMPRESA_SISTEMA_NIF,
        ativa: true,
        apagada: false,
      });
      empresaSistemaCriada = true;
      console.log(`✨ Empresa-sistema criada: "${empresaSistema.nome}" (${empresaSistema._id})`);
    }

    // A.2. Gera password aleatória (12 chars alfanuméricos).
    const novaPassword = gerarPasswordAleatoria(12);
    const passwordHash = await bcrypt.hash(novaPassword, BCRYPT_COST);

    // A.3. Upsert do admin (cria se não existir; atualiza password se existir).
    const adminExistente = await Utilizador.findOne({ email: ADMIN_EMAIL }).lean();
    let admin;
    let acaoAdmin;

    if (!adminExistente) {
      admin = await Utilizador.create({
        nome: ADMIN_NOME,
        email: ADMIN_EMAIL,
        password_hash: passwordHash,
        empresa_id: empresaSistema._id,
        role: ADMIN_ROLE,
        ativo: true,
      });
      acaoAdmin = 'criado';
      console.log(`✅ Admin criado: ${admin.email}`);
    } else {
      // Atualiza a password (setup emergencial redefine sempre).
      admin = await Utilizador.findByIdAndUpdate(
        adminExistente._id,
        {
          $set: {
            nome: ADMIN_NOME,
            role: ADMIN_ROLE,
            empresa_id: empresaSistema._id,
            ativo: true,
            password_hash: passwordHash,
            eliminado_em: null,
          },
        },
        { new: true }
      ).lean();
      acaoAdmin = 'atualizado';
      console.log(`✅ Admin atualizado (nova password): ${admin.email}`);
    }

    /* -------------------------------------------------------------- */
    /* B) IMPORTAÇÃO dos 47 clientes                                  */
    /* -------------------------------------------------------------- */
    console.log(`🏠 [setup-emergencia] B) Importação de ${CLIENTES.length} clientes...`);

    const cacheEmpresas = new Map();
    // Set de nomes únicos de empresas CRIADAS (evita contar a mesma empresa
    // múltiplas vezes quando vários clientes usam a mesma empresa).
    const empresasCriadasNomes = new Set();
    let propriedadesInseridas = 0;
    let propriedadesDuplicadas = 0;
    let errosImport = 0;
    const errosDetalhe = [];

    for (let i = 0; i < CLIENTES.length; i++) {
      const c = CLIENTES[i];
      const titulo = String(c.titulo || '').trim();
      const morada = String(c.morada || '').trim();
      const nomeEmpresa = normalizarNomeEmpresa(c.empresa);

      try {
        // Validações mínimas.
        if (!titulo) throw new Error('Campo "titulo" em falta (mapeia para nome da propriedade).');
        if (!morada) throw new Error('Campo "morada" em falta (required pelo schema Propriedade).');
        if (!nomeEmpresa) throw new Error('Campo "empresa" em falta.');

        // B.1. Resolve (ou cria) a empresa — com cache.
        // Captura se a empresa já estava em cache ANTES de chamar, para
        // podermos logar apenas as criações novas (não em cada reutilização).
        const jaEmCache = cacheEmpresas.has(nomeEmpresa.toLowerCase());
        const { empresa, criada } = await resolverOuCriarEmpresa(nomeEmpresa, cacheEmpresas);
        if (criada) {
          // Conta o nome único da empresa criada (não duplica na contagem
          // se múltiplos clientes usam a mesma empresa — o cache evita
          // re-criar a empresa na BD, mas o contador tem de refletir isso).
          empresasCriadasNomes.add(empresa.nome.toLowerCase());
          // Loga apenas quando a empresa é NOVA (não estava no cache antes
          // desta chamada). Evita spam de "Empresa criada" para cada cliente
          // que reutiliza a mesma empresa.
          if (!jaEmCache) {
            console.log(`  🏢 Empresa criada: "${empresa.nome}" (${empresa._id})`);
          }
        }

        // B.2. Idempotência: verifica se já existe propriedade com o mesmo
        //      nome + empresa + morada (evita duplicar se a rota for corrida
        //      múltiplas vezes). Não conta como erro nem como inserida.
        const duplicada = await Propriedade.findOne({
          nome: titulo,
          empresa_id: empresa._id,
          morada,
        })
          .select('_id')
          .lean();
        if (duplicada) {
          propriedadesDuplicadas++;
          continue; // saltar — já existe
        }

        // B.3. Cria a propriedade.
        const notas = construirNotas(c);
        await Propriedade.create({
          nome: titulo,
          morada,
          empresa_id: empresa._id,
          nome_responsavel: c.nome_responsavel ? String(c.nome_responsavel).trim() : '',
          contacto: c.contacto ? String(c.contacto).trim() : '',
          observacoes: notas,
          // Defaults do schema:
          ativo: true,
          origem: 'manual',
          tempo_limpeza_minutos: 45,
          staff_necessario: 1,
          frequencia_limpeza: 'semanal',
        });
        propriedadesInseridas++;
      } catch (err) {
        errosImport++;
        errosDetalhe.push({
          index: i + 1,
          titulo: titulo || `(item ${i + 1})`,
          empresa: nomeEmpresa || '(vazia)',
          erro: err.message,
        });
        console.error(`  ❌ [${i + 1}/${CLIENTES.length}] Erro em "${titulo}": ${err.message}`);
      }
    }

    const duracaoMs = Date.now() - inicio;
    const totalEmpresasCriadas = empresasCriadasNomes.size;
    console.log(
      `🎉 [setup-emergencia] Concluído em ${duracaoMs}ms. ` +
        `Admin ${acaoAdmin}, ${totalEmpresasCriadas} empresa(s) criada(s), ` +
        `${propriedadesInseridas} propriedade(s) inserida(s), ` +
        `${propriedadesDuplicadas} duplicada(s) saltada(s), ` +
        `${errosImport} erro(s).`
    );

    /* -------------------------------------------------------------- */
    /* Resposta JSON final                                            */
    /* -------------------------------------------------------------- */
    return res.json({
      sucesso: true,
      email: admin.email,
      novaPassword,
      total_propriedades_inseridas: propriedadesInseridas,
      // Campos extra (úteis para diagnóstico):
      admin_id: admin._id,
      admin_acao: acaoAdmin,
      empresa_sistema_admin: empresaSistema.nome,
      empresa_sistema_criada: empresaSistemaCriada,
      total_clientes_json: CLIENTES.length,
      total_empresas_criadas: totalEmpresasCriadas,
      total_propriedades_duplicadas_saltadas: propriedadesDuplicadas,
      total_erros_importacao: errosImport,
      erros: errosDetalhe,
      duracao_ms: duracaoMs,
      rota_protegida_por_token: rotaProtegida,
      aviso:
        '⚠️ Endpoint TEMPORÁRIO de setup. A password do admin está visível em texto limpo nesta resposta. ' +
        'Guarda-a AGORA em segurança e REMOVE esta rota (routes/setupRoutes.js + mounting em server.js) logo que o setup esteja confirmado. ' +
        (rotaProtegida
          ? 'Rota protegida por SETUP_EMERGENCIA_TOKEN.'
          : 'Rota DESPROTEGIDA — define SETUP_EMERGENCIA_TOKEN para exigir ?token=...'),
    });
  } catch (err) {
    console.error('❌ [setup-emergencia] Erro fatal:', err.message);
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
