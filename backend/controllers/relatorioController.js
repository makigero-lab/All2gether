/**
 * Relatório Controller — Autocell
 *
 * Endpoints de analytics / relatórios de produtividade.
 *
 * Autenticação: obrigatória (middleware `auth` aplicado nas rotas).
 * O `empresa_id` é lido do JWT (req.user.empresa_id).
 */

const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const { obterEmpresaId } = require('./gestorController');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normaliza um parâmetro de data (string ISO ou yyyy-mm-dd) para meia-noite
 * UTC. Devolve null se inválido.
 */
function normalizarDataUTC(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

/**
 * Arredonda para 1 casa decimal (percentagens).
 */
function round1(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* GET /api/admin/relatorios/produtividade                             */
/* ------------------------------------------------------------------ */

/**
 * Relatório de produtividade da empresa num intervalo de datas.
 *
 * Query params:
 *   - inicio (yyyy-mm-dd | ISO) — início do período. Default: há 30 dias.
 *   - fim    (yyyy-mm-dd | ISO) — fim do período (inclusive). Default: hoje.
 *
 * Resposta 200:
 *   {
 *     periodo: { inicio, fim },
 *     resumo: {
 *       totalTarefas,           // exclui canceladas
 *       concluidas,
 *       taxaConclusao,          // 0..1
 *       emAtraso,               // tarefas não concluídas cuja data já passou
 *       taxaAtraso,             // 0..1 (emAtraso / total)
 *       cargaTotalMinutos,      // soma de tempo_limpeza_minutos (exclui canceladas)
 *       tempoMedioMinutos,      // média de tempo estimado das concluídas (= tempoEstimadoMedioMinutos)
 *       tempoEstimadoMedioMinutos, // alias de tempoMedioMinutos
 *       tempoRealMedioMinutos   // média de (hora_conclusao - data) das concluídas, em minutos
 *     },
 *     porStaff: [{ utilizador_id, nome, total, concluidas, carga_minutos, taxaConclusao }],
 *     porDia:   [{ data, total, concluidas, carga_minutos }],
 *     porEstado:[{ estado, total }],
 *     porPropriedade: [{ propriedade_id, nome, total, carga_minutos }]
 *   }
 */
exports.getRelatorioProdutividade = async (req, res) => {
  try {
    const { ok, empresaId } = obterEmpresaId(req, res);
    if (!ok) return;

    // Período — default: últimos 30 dias.
    const agora = new Date();
    const hojeFim = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()) +
        24 * 60 * 60 * 1000
    ); // amanhã 00:00 UTC (exclusive)
    const fim = normalizarDataUTC(req.query.fim) || hojeFim;
    const inicio =
      normalizarDataUTC(req.query.inicio) ||
      new Date(fim.getTime() - 30 * 24 * 60 * 60 * 1000);

    // O intervalo é [inicio, fim[ (fim exclusive — já é meia-noite do dia
    // seguinte se vier de normalizarDataUTC; se for hojeFim também).
    const matchBase = {
      empresa_id: new mongoose.Types.ObjectId(empresaId),
      data: { $gte: inicio, $lt: fim },
    };

    /* ---- Resumo (contagens + somas em paralelo) ---- */
    const [
      totalTarefas,
      concluidas,
      emAtraso,
      cargaTotal,
      tempoMedioAgg,
      porEstadoAgg,
      tempoRealAgg,
    ] = await Promise.all([
      // Total (exclui canceladas).
      Tarefa.countDocuments({ ...matchBase, estado: { $ne: 'cancelada' } }),
      // Concluídas.
      Tarefa.countDocuments({ ...matchBase, estado: 'concluida' }),
      // Em atraso: não concluídas nem canceladas cuja data já passou.
      Tarefa.countDocuments({
        ...matchBase,
        estado: { $nin: ['concluida', 'cancelada'] },
        data: { $gte: inicio, $lt: new Date() },
      }),
      // Carga total (minutos) — exclui canceladas.
      Tarefa.aggregate([
        { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
        { $group: { _id: null, total: { $sum: '$tempo_limpeza_minutos' } } },
      ]),
      // Tempo médio estimado das concluídas.
      Tarefa.aggregate([
        { $match: { ...matchBase, estado: 'concluida' } },
        { $group: { _id: null, media: { $avg: '$tempo_limpeza_minutos' } } },
      ]),
      // Distribuição por estado.
      Tarefa.aggregate([
        { $match: matchBase },
        { $group: { _id: '$estado', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      // Tempo real médio: média da diferença entre hora_conclusao e data
      // (em minutos) das tarefas concluídas com hora_conclusao definida.
      Tarefa.aggregate([
        {
          $match: {
            ...matchBase,
            estado: 'concluida',
            hora_conclusao: { $ne: null, $type: 'date' },
          },
        },
        {
          $group: {
            _id: null,
            media: {
              $avg: {
                $divide: [
                  { $subtract: ['$hora_conclusao', '$data'] },
                  60 * 1000, // ms → minutos
                ],
              },
            },
          },
        },
      ]),
    ]);

    const cargaTotalMinutos = cargaTotal[0]?.total || 0;
    const tempoMedioMinutos = tempoMedioAgg[0]?.media
      ? Math.round(tempoMedioAgg[0].media)
      : 0;
    // Tempo real médio em minutos — arredondado. Se não houver tarefas
    // concluídas com hora_conclusao, devolve 0.
    const tempoRealMedioMinutos = tempoRealAgg[0]?.media
      ? Math.round(tempoRealAgg[0].media)
      : 0;

    /* ---- Por staff (produtividade individual) ---- */
    const porStaffAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: '$utilizador_id',
          total: { $sum: 1 },
          concluidas: {
            $sum: { $cond: [{ $eq: ['$estado', 'concluida'] }, 1, 0] },
          },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { total: -1 } },
    ]);

    // Popula nomes (inclui tarefas por atribuir — utilizador_id null → "Por atribuir").
    const staffIds = porStaffAgg
      .filter((s) => s._id)
      .map((s) => s._id);
    const staffInfo = await Utilizador.find({ _id: { $in: staffIds } })
      .select('nome')
      .lean();
    const staffMap = new Map(staffInfo.map((s) => [String(s._id), s.nome]));

    const porStaff = porStaffAgg.map((s) => ({
      utilizador_id: s._id ? String(s._id) : null,
      nome: s._id ? staffMap.get(String(s._id)) ?? 'Desconhecido' : 'Por atribuir',
      total: s.total,
      concluidas: s.concluidas,
      carga_minutos: s.carga_minutos,
      taxaConclusao: s.total > 0 ? round1(s.concluidas / s.total) : 0,
    }));

    /* ---- Por dia (série temporal) ---- */
    const porDiaAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$data' },
          },
          total: { $sum: 1 },
          concluidas: {
            $sum: { $cond: [{ $eq: ['$estado', 'concluida'] }, 1, 0] },
          },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const porDia = porDiaAgg.map((d) => ({
      data: d._id,
      total: d.total,
      concluidas: d.concluidas,
      carga_minutos: d.carga_minutos,
    }));

    /* ---- Por propriedade ---- */
    const porPropriedadeAgg = await Tarefa.aggregate([
      { $match: { ...matchBase, estado: { $ne: 'cancelada' } } },
      {
        $group: {
          _id: '$propriedade_id',
          total: { $sum: 1 },
          carga_minutos: { $sum: '$tempo_limpeza_minutos' },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const propIds = porPropriedadeAgg.map((p) => p._id);
    const propInfo = await Propriedade.find({ _id: { $in: propIds } })
      .select('nome')
      .lean();
    const propMap = new Map(propInfo.map((p) => [String(p._id), p.nome]));

    const porPropriedade = porPropriedadeAgg.map((p) => ({
      propriedade_id: String(p._id),
      nome: propMap.get(String(p._id)) ?? 'Desconhecida',
      total: p.total,
      carga_minutos: p.carga_minutos,
    }));

    /* ---- Resposta final ---- */
    const porEstado = porEstadoAgg.map((e) => ({ estado: e._id, total: e.total }));

    return res.status(200).json({
      periodo: { inicio: inicio.toISOString(), fim: fim.toISOString() },
      resumo: {
        totalTarefas,
        concluidas,
        taxaConclusao: totalTarefas > 0 ? round1(concluidas / totalTarefas) : 0,
        emAtraso,
        taxaAtraso: totalTarefas > 0 ? round1(emAtraso / totalTarefas) : 0,
        cargaTotalMinutos,
        tempoMedioMinutos,
        tempoEstimadoMedioMinutos: tempoMedioMinutos,
        tempoRealMedioMinutos,
      },
      porStaff,
      porDia,
      porEstado,
      porPropriedade,
    });
  } catch (err) {
    console.error('❌ getRelatorioProdutividade:', err.message);
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/gestor/relatorios/ai-summary                              */
/* ------------------------------------------------------------------ */
/**
 * Gera um "Resumo Executivo" com IA a partir dos dados do relatório
 * (limpezas totais, horas, faltas, produtividade por staff, etc.).
 *
 * Estratégia (best-effort, Prompt 125):
 *   1. Se GEMINI_API_KEY existir  → chama Google Gemini (@google/generative-ai SDK).
 *   2. Else se OPENAI_API_KEY existir → chama OpenAI (gpt-4o-mini).
 *   3. Se nenhuma chave existir OU a chamada falhar → devolve um
 *      placeholder estruturado gerado localmente a partir dos dados
 *      (com secções "Visão Geral", "Tendências", "Recomendações").
 *
 * Body: payload do relatório (resumo + porStaff + porDia + ...).
 * Resposta 200: { resumo: "..." }
 */
exports.getResumoIA = async (req, res) => {
  try {
    const dados = req.body || {};

    // Payload normalizado para construir o prompt / o placeholder.
    const contexto = construirContexto(dados);

    /* ---- Tentativa LLM (best-effort) — Prompt 125: Gemini tem prioridade ---- */
    let resumoLLM = null;

    if (process.env.GEMINI_API_KEY) {
      try {
        resumoLLM = await chamarGemini(contexto);
      } catch (err) {
        console.warn('⚠️  Gemini falhou, a usar placeholder:', err.message);
      }
    } else if (process.env.OPENAI_API_KEY) {
      try {
        resumoLLM = await chamarOpenAI(contexto);
      } catch (err) {
        console.warn('⚠️  OpenAI falhou, a usar placeholder:', err.message);
      }
    }

    const resumo = resumoLLM || gerarPlaceholder(contexto);

    return res.status(200).json({ resumo });
  } catch (err) {
    console.error('❌ getResumoIA:', err.message);
    // Prompt 128 — Em caso de erro inesperado, devolve SEMPRE 200 OK com
    // um placeholder utilizável. Nunca devolve 500 — o frontend precisa de
    // um resumo para gerar o PDF, mesmo que seja o placeholder.
    try {
      const contexto = construirContexto(req.body || {});
      return res.status(200).json({ resumo: gerarPlaceholder(contexto) });
    } catch (err2) {
      // Último recurso: placeholder hardcoded (não depende de construirContexto).
      console.error('❌ getResumoIA fallback também falhou:', err2.message);
      return res.status(200).json({
        resumo: '## Visão Geral\n\nNão foi possível gerar o resumo executivo automaticamente. Consulte as métricas detalhadas abaixo para análise manual.\n\n## Recomendações\n\n- Verifique a configuração das chaves de API (GEMINI_API_KEY ou OPENAI_API_KEY).\n- Tente novamente mais tarde.',
      });
    }
  }
};

/* ------------------------------------------------------------------ */
/* Helpers — getResumoIA                                               */
/* ------------------------------------------------------------------ */

/**
 * Constrói um objecto normalizado a partir do body do pedido.
 * Suporta tanto a estrutura completa do /produtividade como um
 * subconjunto parcial (apenas resumo). Tudo é opcional e tem defaults.
 */
function construirContexto(dados) {
  const r = dados.resumo || {};
  const periodo = dados.periodo || {};

  return {
    periodoInicio: periodo.inicio || null,
    periodoFim: periodo.fim || null,
    totalTarefas: r.totalTarefas ?? dados.totalTarefas ?? 0,
    concluidas: r.concluidas ?? dados.concluidas ?? 0,
    taxaConclusao: r.taxaConclusao ?? dados.taxaConclusao ?? 0,
    emAtraso: r.emAtraso ?? dados.emAtraso ?? 0,
    taxaAtraso: r.taxaAtraso ?? dados.taxaAtraso ?? 0,
    cargaTotalMinutos: r.cargaTotalMinutos ?? dados.cargaTotalMinutos ?? 0,
    tempoMedioMinutos:
      r.tempoMedioMinutos ?? r.tempoEstimadoMedioMinutos ?? dados.tempoMedioMinutos ?? 0,
    tempoRealMedioMinutos:
      r.tempoRealMedioMinutos ?? dados.tempoRealMedioMinutos ?? 0,
    porStaff: Array.isArray(dados.porStaff) ? dados.porStaff : [],
    porPropriedade: Array.isArray(dados.porPropriedade)
      ? dados.porPropriedade
      : [],
    porDia: Array.isArray(dados.porDia) ? dados.porDia : [],
    porEstado: Array.isArray(dados.porEstado) ? dados.porEstado : [],
  };
}

/**
 * Constrói um prompt em português europeu focado em gestão
 * (tendências e eficiência), a partir do contexto normalizado.
 */
function construirPrompt(contexto) {
  const pctConclusao = Math.round(contexto.taxaConclusao * 100);
  const pctAtraso = Math.round(contexto.taxaAtraso * 100);
  const horasTotal = (contexto.cargaTotalMinutos / 60).toFixed(1);
  const tempoMedio = (contexto.tempoMedioMinutos / 60).toFixed(2);
  const tempoReal = (contexto.tempoRealMedioMinutos / 60).toFixed(2);

  const topStaff = [...contexto.porStaff]
    .sort((a, b) => b.taxaConclusao - a.taxaConclusao)
    .slice(0, 5)
    .map(
      (s) =>
        `- ${s.nome}: ${s.concluidas}/${s.total} concluídas (${Math.round(
          s.taxaConclusao * 100
        )}%), carga ${Math.round(s.carga_minutos / 60 * 10) / 10}h`
    )
    .join('\n') || '- (sem dados de staff)';

  const topProps = [...contexto.porPropriedade]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(
      (p) =>
        `- ${p.nome}: ${p.total} tarefas, carga ${
          Math.round((p.carga_minutos / 60) * 10) / 10
        }h`
    )
    .join('\n') || '- (sem dados de propriedades)';

  return `És um analista de operações de uma empresa de Alojamento Local (Autocell).
Escreve um "Resumo Executivo" em português de Portugal, focado em gestão
(tendências e eficiência), a partir dos seguintes dados do período.

Dados:
- Total de tarefas: ${contexto.totalTarefas}
- Tarefas concluídas: ${contexto.concluidas} (${pctConclusao}%)
- Tarefas em atraso: ${contexto.emAtraso} (${pctAtraso}%)
- Carga total estimada: ${horasTotal}h
- Tempo médio estimado por tarefa: ${tempoMedio}h
- Tempo real médio por tarefa (concluídas): ${tempoReal}h

Top staff (por taxa de conclusão):
${topStaff}

Top propriedades (por nº de tarefas):
${topProps}

Estrutura obrigatória (usa exactamente estes títulos em markdown):
## Visão Geral
(parágrafo curto com os números-chave)

## Tendências
(2-4 bullets sobre padrões: picos de carga, atrasos, eficiência real vs estimada)

## Recomendações
(3-4 bullets acionáveis focados em gestão: redistribuição de carga,
formação, revisão de estimativas, etc.)

Máximo 350 palavras. Tom profissional, conciso, sem clichés.`;
}

/**
 * Chama a API da OpenAI (gpt-4o-mini) e devolve o texto do resumo.
 * Lança erro se a resposta não for bem-sucedida.
 */
async function chamarOpenAI(contexto) {
  const prompt = construirPrompt(contexto);

  const resposta = await fetch(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'És um assistente de análise de operações para gestão de Alojamento Local. Responde sempre em português de Portugal.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 700,
      }),
    }
  );

  if (!resposta.ok) {
    const txt = await resposta.text().catch(() => '');
    throw new Error(`OpenAI ${resposta.status}: ${txt.slice(0, 200)}`);
  }

  const json = await resposta.json();
  const texto = json?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('OpenAI: resposta vazia.');
  return texto;
}

/**
 * Chama a API do Google Gemini (generateContent) e devolve o texto.
 * Modelo: gemini-1.5-flash (rápido e barato, equivalente ao gpt-4o-mini).
 *
 * Prompt 125 — refactorizada para usar o SDK oficial @google/generative-ai
 * em vez do `fetch` cru. O SDK trata autenticação, retries e parsing.
 */
async function chamarGemini(contexto) {
  const prompt = construirPrompt(contexto);

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Gemini 2.0 Flash (free tier, disponível em todas as contas).
  // gemini-1.5-flash foi descontinuado — retorna 404.
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
  });

  const texto = result?.response?.text?.()?.trim();
  if (!texto) throw new Error('Gemini: resposta vazia.');
  return texto;
}

/**
 * Gera um resumo executivo estruturado localmente, sem chamar qualquer
 * API externa. Sempre útil e profissional (não é uma mensagem de erro).
 */
function gerarPlaceholder(contexto) {
  const pctConclusao = Math.round(contexto.taxaConclusao * 100);
  const pctAtraso = Math.round(contexto.taxaAtraso * 100);
  const horasTotal = (contexto.cargaTotalMinutos / 60).toFixed(1);
  const tempoMedio = (contexto.tempoMedioMinutos / 60).toFixed(2);
  const tempoReal = (contexto.tempoRealMedioMinutos / 60).toFixed(2);

  const periodoTxt =
    contexto.periodoInicio && contexto.periodoFim
      ? `no período de ${contexto.periodoInicio.slice(0, 10)} a ${contexto.periodoFim.slice(0, 10)}`
      : 'no período selecionado';

  /* ---- Visão Geral ---- */
  const visaoGeral = `Foram processadas **${contexto.totalTarefas} tarefas** ${periodoTxt}, das quais **${contexto.concluidas} foram concluídas** (taxa de conclusão de ${pctConclusao}%). Registaram-se **${contexto.emAtraso} tarefas em atraso** (${pctAtraso}% do total). A carga total estimada foi de **${horasTotal}h**, com um tempo médio estimado de ${tempoMedio}h por tarefa${
    contexto.tempoRealMedioMinutos > 0
      ? ` e um tempo real médio de ${tempoReal}h nas concluídas`
      : ''
  }.`;

  /* ---- Tendências ---- */
  const tendencias = [];

  if (pctConclusao >= 90) {
    tendencias.push(
      `- **Alta taxa de conclusão (${pctConclusao}%)**: a equipa está a cumprir a maioria das tarefas planeadas, indicando boa capacidade de execução.`
    );
  } else if (pctConclusao >= 70) {
    tendencias.push(
      `- **Taxa de conclusão moderada (${pctConclusao}%)**: há espaço para otimização do fluxo de trabalho e melhor distribuição de carga.`
    );
  } else if (contexto.totalTarefas > 0) {
    tendencias.push(
      `- **Taxa de conclusão baixa (${pctConclusao}%)**: prioritário rever planeamento, atribuições e possíveis bloqueios operacionais.`
    );
  }

  if (pctAtraso > 15) {
    tendencias.push(
      `- **Taxa de atraso elevada (${pctAtraso}%)**: sinal de alerta — rever prazos, estimativas e capacidade da equipa.`
    );
  } else if (pctAtraso > 0) {
    tendencias.push(
      `- **Atrasos contidos (${pctAtraso}%)**: dentro de margens aceitáveis, mas convém monitorizar os casos pontuais.`
    );
  }

  if (
    contexto.tempoRealMedioMinutos > 0 &&
    contexto.tempoMedioMinutos > 0
  ) {
    const diff = contexto.tempoRealMedioMinutos - contexto.tempoMedioMinutos;
    const diffPct = Math.round((diff / contexto.tempoMedioMinutos) * 100);
    if (diff <= 0) {
      tendencias.push(
        `- **Eficiência acima do estimado**: o tempo real médio (${tempoReal}h) foi **${Math.abs(
          diffPct
        )}% inferior** ao estimado (${tempoMedio}h) — as estimativas podem estar conservadoras.`
      );
    } else {
      tendencias.push(
        `- **Tempo real acima do estimado** (${tempoReal}h vs ${tempoMedio}h, +${diffPct}%): rever precisão das estimativas ou identificar causas (formação, logística, propriedades mais exigentes).`
      );
    }
  }

  // Tendência de carga por staff (concentração).
  if (contexto.porStaff.length > 1) {
    const cargas = contexto.porStaff
      .filter((s) => s.total > 0)
      .map((s) => s.total);
    if (cargas.length > 1) {
      const max = Math.max(...cargas);
      const min = Math.min(...cargas);
      if (max > min * 2) {
        tendencias.push(
          `- **Distribuição de carga desequilibrada**: o staff com mais tarefas tem ${max} e o com menos tem ${min} — possível sobrecarga pontual.`
        );
      }
    }
  }

  if (tendencias.length === 0) {
    tendencias.push(
      `- Sem dados suficientes para identificar tendências significativas neste período.`
    );
  }

  /* ---- Recomendações ---- */
  const recomendacoes = [];

  if (pctConclusao < 90 && contexto.totalTarefas > 0) {
    recomendacoes.push(
      `Reforçar o acompanhamento das ${contexto.totalTarefas - contexto.concluidas} tarefas não concluídas: identificar bloqueios e reatribuir sempre que necessário.`
    );
  } else {
    recomendacoes.push(
      `Manter o ritmo de execução atual e continuar a monitorizar indicadores de qualidade (não apenas volume).`
    );
  }

  if (pctAtraso > 10) {
    recomendacoes.push(
      `Implementar revisão semanal de atrasos: analisar causas raiz (subdimensionamento de equipa, estimativas irrealistas, logística) e ajustar planeamento.`
    );
  }

  if (
    contexto.tempoRealMedioMinutos > 0 &&
    contexto.tempoRealMedioMinutos > contexto.tempoMedioMinutos * 1.1
  ) {
    recomendacoes.push(
      `Recalcular as estimativas de tempo de limpeza por propriedade com base no tempo real observado — os valores atuais estão subestimados.`
    );
  } else if (
    contexto.tempoRealMedioMinutos > 0 &&
    contexto.tempoRealMedioMinutos < contexto.tempoMedioMinutos * 0.85
  ) {
    recomendacoes.push(
      `Rever as estimativas de tempo (atualmente conservadoras) para otimizar o agendamento e a utilização da equipa.`
    );
  }

  if (contexto.porStaff.length > 1) {
    recomendacoes.push(
      `Avaliar redistribuição de carga entre staff: equilibrar tarefas por capacidade e experiência, garantindo cobertura adequada das propriedades com maior volume.`
    );
  }

  if (contexto.porPropriedade.length > 0) {
    const topProp = [...contexto.porPropriedade].sort(
      (a, b) => b.total - a.total
    )[0];
    recomendacoes.push(
      `Focar otimização na propriedade "${topProp.nome}" (maior volume: ${topProp.total} tarefas) — padronizar checklist e antecedar agendamentos.`
    );
  }

  // Limita a 4 recomendações.
  const recFinal = recomendacoes.slice(0, 4);

  return [
    '## Visão Geral',
    visaoGeral,
    '',
    '## Tendências',
    tendencias.join('\n'),
    '',
    '## Recomendações',
    recFinal.map((r) => `- ${r}`).join('\n'),
  ].join('\n');
}
