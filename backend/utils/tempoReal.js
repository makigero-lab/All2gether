/**
 * Tempo real vs estimado por casa (All2gether)
 *
 * Duração real de uma limpeza = hora de conclusão - início. O início só é fiável quando:
 *   - o staff carregou em «Comecei» (`inicio_origem: 'botao'`, usa `iniciada_em`); ou
 *   - marcou itens da checklist (usa `primeiro_item_checklist_em`).
 * Inícios AUTOMÁTICOS sem checklist ficam de fora: a hora marcada não prova que alguém chegou.
 * Sem ajustes automáticos: só se calcula uma sugestão, que o gestor aplica à mão.
 */

const MIN_MINUTOS = 5;
const MAX_MINUTOS = 12 * 60;
/** Amostras mínimas e diferença mínima (fração do estimado) para sugerir um ajuste. */
const MIN_AMOSTRAS_SUGESTAO = 3;
const DIFERENCA_MINIMA = 0.15;

/** Início fiável de uma tarefa (Date) ou null. */
function inicioFiavel(t) {
  if (t.inicio_origem === 'botao' && t.iniciada_em) return new Date(t.iniciada_em);
  if (t.primeiro_item_checklist_em) return new Date(t.primeiro_item_checklist_em);
  return null;
}

/** Minutos reais de uma tarefa concluída, ou null se não conta. */
function duracaoRealMinutos(t) {
  const fim = t.hora_conclusao || t.concluida_em;
  const ini = inicioFiavel(t);
  if (!fim || !ini) return null;
  const min = (new Date(fim).getTime() - ini.getTime()) / 60000;
  if (!Number.isFinite(min) || min < MIN_MINUTOS || min > MAX_MINUTOS) return null;
  return min;
}

const arred5 = (n) => Math.max(5, Math.round(n / 5) * 5);

/**
 * @param {Array} tarefas concluídas (lean) com propriedade_id (ObjectId) e campos de início
 * @param {Map<string,{nome:string,tempo:number}>} propriedades
 */
function calcularPorCasa(tarefas, propriedades) {
  const grupos = new Map();
  let excluidas = 0;
  for (const t of tarefas) {
    // As sugestões são para a limpeza normal da casa (profunda, intermédia e preparação têm outro tempo).
    if (t.tipo_limpeza && t.tipo_limpeza !== 'normal') continue;
    const real = duracaoRealMinutos(t);
    if (real === null) {
      excluidas++;
      continue;
    }
    const k = String(t.propriedade_id);
    if (!grupos.has(k)) grupos.set(k, { reais: [], estimados: [], botao: 0, checklist: 0 });
    const g = grupos.get(k);
    g.reais.push(real);
    g.estimados.push(Number(t.tempo_limpeza_minutos) || 0);
    if (t.inicio_origem === 'botao' && t.iniciada_em) g.botao++;
    else g.checklist++;
  }
  const media = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const casas = [];
  for (const [k, g] of grupos) {
    const p = propriedades.get(k);
    const realMedio = media(g.reais);
    const estimadoMedio = media(g.estimados);
    const atual = p ? Number(p.tempo) || estimadoMedio : estimadoMedio;
    const diferenca = realMedio - atual;
    let sugestao = null;
    if (g.reais.length >= MIN_AMOSTRAS_SUGESTAO && atual > 0 && Math.abs(diferenca) / atual >= DIFERENCA_MINIMA) {
      sugestao = arred5(realMedio);
      if (sugestao === Math.round(atual)) sugestao = null;
    }
    casas.push({
      propriedade_id: k,
      nome: p ? p.nome : 'Desconhecida',
      amostras: g.reais.length,
      por_botao: g.botao,
      por_checklist: g.checklist,
      real_medio_min: Math.round(realMedio),
      estimado_medio_min: Math.round(estimadoMedio),
      tempo_atual_casa_min: Math.round(atual),
      diferenca_min: Math.round(diferenca),
      sugestao_min: sugestao,
    });
  }
  casas.sort((a, b) => Math.abs(b.diferenca_min) - Math.abs(a.diferenca_min));
  return { casas, excluidas };
}

module.exports = { inicioFiavel, duracaoRealMinutos, calcularPorCasa, MIN_AMOSTRAS_SUGESTAO, DIFERENCA_MINIMA };
