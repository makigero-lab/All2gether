/**
 * Seed de Modelos de Checklist — FisioCell
 *
 * Prompt 135 — Cria dois ModeloChecklist na BD a partir dos documentos Word:
 *   1. "Limpeza Standard" — checklist básica de checkout
 *   2. "Limpeza Detalhada V2" — checklist expandida com mais items
 *
 * Associa o Modelo 1 (Limpeza Standard) a todas as propriedades existentes
 * que ainda não têm modelo_checklist_id definido.
 *
 * Uso: node scripts/seedChecklists.js
 *   (ou: npm run seed:checklists)
 *
 * Variáveis de ambiente necessárias:
 *   - MONGODB_URI — URI de ligação ao MongoDB
 *   - EMPRESA_ID  — ID da empresa principal (opcional; se não definido,
 *                   usa a primeira empresa da BD)
 */

require('dotenv').config();

const mongoose = require('mongoose');
const ModeloChecklist = require('../models/ModeloChecklist');
const Propriedade = require('../models/Propriedade');
const Empresa = require('../models/Empresa');

// ── Modelo 1: Limpeza Standard ──────────────────────────────────────
const LIMPEZA_STANDARD = {
  nome: 'Limpeza Standard',
  descricao: 'Checklist de limpeza de checkout para garantir o padrão de excelência e a satisfação do hóspede.',
  seccoes: [
    {
      nome: 'Quartos',
      items: [
        'Verificar o estado dos resguardos de colchão e almofadas.',
        'Substituir roupa de cama (lençóis, fronhas, capas) e esticar bem.',
        'Limpar pó de mesas de cabeceira, candeeiros e topo da cabeceira.',
        'Verificar interior de roupeiros e gavetas (remover lixo/esquecidos).',
        'Aspirar debaixo da cama e cantos do teto (teias de aranha).',
      ],
    },
    {
      nome: 'Cozinha',
      items: [
        'Limpar interior e exterior de micro-ondas, frigorífico e forno.',
        'Lavar loiça restante e limpar gaveta de talheres (migalhas).',
        'Desinfetar banca, torneira e placa de fogão.',
        'Esvaziar lixo, desinfetar balde e colocar saco novo.',
      ],
    },
    {
      nome: 'Casa de Banho',
      items: [
        'Desinfetar sanita, lavatório e zona de duche (atenção aos cabelos).',
        'Limpar espelho e vidros do poliban sem deixar manchas.',
        'Repor papel higiénico (com selo) e consumíveis (shampoo/gel).',
        'Substituir toalhas de banho e de rosto por limpas.',
      ],
    },
    {
      nome: 'Sala / Áreas Comuns',
      items: [
        'Aspirar sofás (entre almofadas) e limpar comando da TV.',
        'Limpar pó de prateleiras, mesas e rodapés.',
        'Verificar se o guia do hóspede e senha Wi-Fi estão no lugar.',
      ],
    },
    {
      nome: 'Geral / Manutenção',
      items: [
        'Testar todas as lâmpadas e pilhas de comandos.',
        'Verificar danos ou manchas e reportar imediatamente.',
        'Garantir que janelas e porta principal estão trancadas ao sair.',
      ],
    },
  ],
};

// ── Modelo 2: Limpeza Detalhada V2 ──────────────────────────────────
const LIMPEZA_DETALHADA_V2 = {
  nome: 'Limpeza Detalhada V2',
  descricao: 'Checklist expandida que garante que nenhum detalhe passa despercebido. Um alojamento impecável é a garantia de uma avaliação de 5 estrelas.',
  seccoes: [
    {
      nome: 'Quartos (Dormitórios)',
      items: [
        'Retirar roupa de cama usada e verificar se o protetor de colchão/almofada tem manchas.',
        'Colocar lençóis lavados, garantindo que estão esticados e sem cabelos ou fiapos.',
        'Limpar o pó de molduras, quadros, rodapés e parte superior de espelhos.',
        'Limpar o interior de todas as gavetas e prateleiras dos roupeiros.',
        'Verificar se existem objetos esquecidos (carregadores, roupa) debaixo da cama.',
        'Desinfetar comandos de AC e interruptores de luz.',
      ],
    },
    {
      nome: 'Casa de Banho (Sanitários)',
      items: [
        'Desinfetar sanita (incluindo base e atrás da tampa) e colocar selo de higienização.',
        'Remover calcário de torneiras e chuveiro até brilharem.',
        'Limpar ralo do duche e remover quaisquer cabelos.',
        'Limpar azulejos da zona de banho para remover marcas de água e sabão.',
        'Repor: 2 rolos de papel higiénico (mínimo), sabonete, shampoo e gel de banho.',
        'Verificar se o caixote do lixo está vazio, limpo e com saco novo.',
      ],
    },
    {
      nome: 'Cozinha e Zona de Refeições',
      items: [
        'Limpar frigorífico: remover restos, limpar prateleiras e gaveta de vegetais.',
        'Limpar migalhas da torradeira e interior do micro-ondas.',
        'Verificar se a loiça na máquina ou armários está seca e sem manchas.',
        'Limpar e desinfetar a banca e o escorredor de loiça.',
        'Repor kit de boas-vindas: café, chá, açúcar, sal, azeite e esponja de loiça nova.',
      ],
    },
    {
      nome: 'Sala e Áreas de Estar',
      items: [
        'Limpar o ecrã da TV (apenas com pano seco/próprio) e o comando.',
        'Aspirar fendas do sofá e sacudir almofadas decorativas.',
        'Limpar marcas de dedos em vidros, janelas e mesas de centro.',
        'Organizar revistas, manuais da casa e comandos de forma ordenada.',
      ],
    },
    {
      nome: 'Verificação Final (Protocolo de Saída)',
      items: [
        'Testar todas as lâmpadas e o sinal do Wi-Fi.',
        'Garantir que não há odores desagradáveis (usar neutralizador se necessário).',
        'Verificar se o AC/Aquecimento está desligado ou na temperatura de boas-vindas.',
        'Trancar todas as janelas e a porta principal.',
      ],
    },
  ],
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI não definida no .env');
    process.exit(1);
  }

  console.log('🔌 A ligar ao MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Ligado.');

  // Determina o empresa_id.
  let empresaId = process.env.EMPRESA_ID;
  if (!empresaId) {
    const primeiraEmpresa = await Empresa.findOne().sort({ createdAt: 1 }).lean();
    if (!primeiraEmpresa) {
      console.error('❌ Nenhuma empresa encontrada na BD. Cria uma empresa primeiro.');
      process.exit(1);
    }
    empresaId = String(primeiraEmpresa._id);
    console.log(`📋 Usando a primeira empresa: ${primeiraEmpresa.nome} (${empresaId})`);
  } else {
    console.log(`📋 Usando EMPRESA_ID do .env: ${empresaId}`);
  }

  // Verifica se os modelos já existem (idempotente).
  const existentes = await ModeloChecklist.find({ empresa_id: empresaId }).lean();
  const nomesExistentes = existentes.map((m) => m.nome);

  // Cria Modelo 1: Limpeza Standard
  let modelo1 = existentes.find((m) => m.nome === 'Limpeza Standard');
  if (!modelo1) {
    modelo1 = await ModeloChecklist.create({
      ...LIMPEZA_STANDARD,
      empresa_id: empresaId,
    });
    console.log(`✅ Modelo 1 criado: "${modelo1.nome}" (${modelo1._id})`);
  } else {
    console.log(`ℹ️  Modelo 1 já existe: "${modelo1.nome}" (${modelo1._id})`);
  }

  // Cria Modelo 2: Limpeza Detalhada V2
  let modelo2 = existentes.find((m) => m.nome === 'Limpeza Detalhada V2');
  if (!modelo2) {
    modelo2 = await ModeloChecklist.create({
      ...LIMPEZA_DETALHADA_V2,
      empresa_id: empresaId,
    });
    console.log(`✅ Modelo 2 criado: "${modelo2.nome}" (${modelo2._id})`);
  } else {
    console.log(`ℹ️  Modelo 2 já existe: "${modelo2.nome}" (${modelo2._id})`);
  }

  // Associa o Modelo 1 (Limpeza Standard) a todas as propriedades sem modelo.
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

  console.log(`🔗 ${resultado.modifiedCount} propriedade(s) associada(s) ao Modelo "${modelo1.nome}".`);
  console.log('\n🎉 Seed concluído com sucesso!');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erro no seed:', err.message);
  process.exit(1);
});
