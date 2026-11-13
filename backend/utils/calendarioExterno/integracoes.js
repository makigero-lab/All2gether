/**
 * Área «Integrações» do gestor — vistas agregadas e decisões em lote (All2gether).
 *
 * `resumoIntegracoes`: uma linha por proprietário (com a mini-barra de casas e os canais por casa), calculada com
 * poucas consultas (proprietários, casas, fontes, contagem de períodos por confirmar e acordos): sem N+1.
 * `contagemErros`: o n.º do selo vermelho da barra lateral.
 * `decidirLote`: confirmar ou marcar como bloqueio vários períodos de uma vez (lista única da empresa).
 * Tudo limitado à empresa do gestor. A API nunca devolve links: só a máscara.
 */
const mongoose = require('mongoose');
const FonteCalendario = require('../../models/FonteCalendario');
const ReservaExterna = require('../../models/ReservaExterna');
const Propriedade = require('../../models/Propriedade');
const Utilizador = require('../../models/Utilizador');
const H = require('../horario');
const { acordoObrigatorio, aceitacoesVigentes } = require('../acordoRgpd');
const { chavesConfiguradas } = require('./cifra');
const { modoTesteAtivo } = require('./seguranca');
const { mensagemErro, MENSAGENS_ESTADO, textoMuitosNovos, eErroTemporario, canalTexto } = require('./mensagens');
const { notificarSino } = require('../notificar');
const { semUrl } = require('./cifra');
const D = require('./decisoes');
const Rv = require('./reservas');

const resp = (status, body) => ({ status, body });
const MAX_LOTE = 200;
/** Tempo máximo de um pedido de lote: o que não couber fica para o pedido seguinte (nunca chega ao limite do proxy). */
const ORCAMENTO_LOTE_MS = 20000;

/** Estado simples de uma fonte para a interface (e o texto de erro em linguagem simples). */
function celula(f, semAcordo) {
  let estado = f.estado;
  let motivo = f.motivo_estado || null;
  if (semAcordo && estado === 'ativa') { estado = 'pausada'; motivo = 'acordo_por_aceitar'; }
  return {
    fonte_id: String(f._id), canal: f.canal, canal_texto: canalTexto(f.canal, f.rotulo),
    estado, motivo_estado: motivo, estado_texto: motivo ? MENSAGENS_ESTADO[motivo] || null : null,
    url_mascara: f.url_mascara || null, ultima_leitura_em: f.ultima_leitura_em || null, ultimo_sucesso_em: f.ultimo_sucesso_em || null,
    em_validacao: !!f.aviso_muitos_novos_em,
    aviso_validacao: f.aviso_muitos_novos_em ? textoMuitosNovos(f.ultimo_n_futuros || 0, true) : null,
    erro: estado === 'erro' && f.ultimo_erro && f.ultimo_erro.codigo
      ? { codigo: f.ultimo_erro.codigo, temporario: eErroTemporario(f.ultimo_erro.codigo), mensagem: semUrl(mensagemErro(f.ultimo_erro.codigo, { canal: canalTexto(f.canal, f.rotulo) })), em: f.ultimo_erro.em || null }
      : null,
  };
}

/** @returns {Promise<{status:number, body:object}>} */
async function resumoIntegracoes({ empresaId, incluirInativos = false }) {
  const filtroDono = { empresa_id: empresaId, role: 'parceiro', eliminado_em: null, ...(incluirInativos ? {} : { ativo: { $ne: false } }) };
  const donos = await Utilizador.find(filtroDono).select('nome email ativo').sort({ nome: 1 }).lean();
  const ids = donos.map((d) => d._id);
  const hoje = Rv.dataDe(H.hojeLisboa());
  const [casas, fontes, porConf, aceites, inativasPorDono] = await Promise.all([
    Propriedade.find({ empresa_id: empresaId, parceiro_id: { $in: ids }, ...(incluirInativos ? {} : { ativo: { $ne: false } }) }).select('nome ativo parceiro_id smoobu_id').sort({ nome: 1 }).lean(),
    FonteCalendario.find({ empresa_id: empresaId, parceiro_id: { $in: ids }, removida: false }).select('propriedade_id parceiro_id canal rotulo canal_chave aviso_muitos_novos_em ultimo_n_futuros estado motivo_estado url_mascara ultima_leitura_em ultimo_sucesso_em ultimo_erro').lean(),
    ReservaExterna.aggregate([
      { $match: { empresa_id: new mongoose.Types.ObjectId(String(empresaId)), parceiro_id: { $in: ids }, estado: 'por_confirmar', check_out: { $gte: hoje } } },
      { $group: { _id: '$propriedade_id', n: { $sum: 1 } } },
    ]),
    aceitacoesVigentes(ids.map(String)),
    // Casas inativas (não aparecem na matriz): contam-se para o assistente explicar porque não há casas para ligar.
    incluirInativos ? [] : Propriedade.aggregate([{ $match: { empresa_id: new mongoose.Types.ObjectId(String(empresaId)), parceiro_id: { $in: ids }, ativo: false } }, { $group: { _id: '$parceiro_id', n: { $sum: 1 } } }]),
  ]);
  const nInativas = new Map(inativasPorDono.map((x) => [String(x._id), x.n]));
  const obrigatorio = acordoObrigatorio();
  const nPorCasa = new Map(porConf.map((x) => [String(x._id), x.n]));
  const fontesPorCasa = new Map();
  for (const f of fontes) {
    const k = String(f.propriedade_id);
    if (!fontesPorCasa.has(k)) fontesPorCasa.set(k, []);
    fontesPorCasa.get(k).push(f);
  }
  const casasPorDono = new Map();
  for (const c of casas) {
    const k = String(c.parceiro_id);
    if (!casasPorDono.has(k)) casasPorDono.set(k, []);
    casasPorDono.get(k).push(c);
  }
  const totais = { erros: 0, por_confirmar: 0, sem_ligacao: 0, em_pausa: 0, por_aceitar: 0 };
  const proprietarios = donos.map((d) => {
    const id = String(d._id);
    const acordo = !obrigatorio ? 'nao_exigido' : aceites.has(id) ? 'aceite' : 'por_aceitar';
    const semAcordo = acordo === 'por_aceitar';
    let nErros = 0; let nValid = 0; let nPausa = 0; let nLigadas = 0; let ultima = null; let primeiroErro = null; let nPorConf = 0;
    const lista = (casasPorDono.get(id) || []).map((c) => {
      const cs = (fontesPorCasa.get(String(c._id)) || []).map((f) => celula(f, semAcordo));
      const pc = nPorCasa.get(String(c._id)) || 0;
      nPorConf += pc;
      for (const x of cs) {
        if (x.estado === 'erro') { nErros += 1; if (!primeiroErro) primeiroErro = { casa: c.nome, canal: x.canal_texto, fonte_id: x.fonte_id, ...x.erro }; }
        else if (x.estado === 'pausada' || x.estado === 'suspensa') nPausa += 1;
        if (x.em_validacao && x.estado !== 'erro' && !primeiroErro) primeiroErro = { casa: c.nome, canal: x.canal_texto, fonte_id: x.fonte_id, codigo: 'muitos_novos', mensagem: x.aviso_validacao, em: x.ultima_leitura_em };
        if (x.em_validacao && x.estado !== 'erro') nValid += 1;
        if (x.estado === 'ativa') nLigadas += 1;
        if (x.ultima_leitura_em && (!ultima || new Date(x.ultima_leitura_em) > new Date(ultima))) ultima = x.ultima_leitura_em;
      }
      return {
        _id: String(c._id), nome: c.nome, ativo: c.ativo !== false, smoobu: !!c.smoobu_id, por_confirmar: pc,
        airbnb: cs.find((x) => x.canal === 'airbnb') || null,
        booking: cs.find((x) => x.canal === 'booking') || null,
        outros: cs.filter((x) => x.canal !== 'airbnb' && x.canal !== 'booking'),
      };
    });
    const ligacoes = lista.reduce((n, c) => n + [c.airbnb, c.booking].filter(Boolean).length + c.outros.length, 0);
    const estado = nErros || nValid ? 'erro' : semAcordo ? 'por_aceitar' : nPausa ? 'pausada' : ligacoes === 0 ? 'sem_ligacao' : 'ok';
    if (d.ativo !== false) {
      totais.erros += nErros + nValid; totais.por_confirmar += nPorConf;
      if (estado === 'sem_ligacao') totais.sem_ligacao += 1;
      if (estado === 'pausada' || estado === 'por_aceitar') totais.em_pausa += 1;
      if (semAcordo) totais.por_aceitar += 1;
    }
    return {
      _id: id, nome: d.nome, email: d.email, ativo: d.ativo !== false, acordo, estado, n_erros: nErros + nValid, n_ligadas: nLigadas, n_ligacoes: ligacoes,
      n_por_confirmar: nPorConf, n_casas_inativas: nInativas.get(id) || 0, ultima_leitura_em: ultima, primeiro_erro: primeiroErro, casas: lista,
    };
  });
  return resp(200, { proprietarios, totais, ligado: chavesConfiguradas(), modo_teste: modoTesteAtivo(), acordo_obrigatorio: obrigatorio });
}

/**
 * N.º de ligações com erro para o selo da barra lateral. Mesma regra da vista geral e do painel «Precisam de atenção»:
 * só contam ligações de casas ativas de proprietários ativos (as inativas não aparecem nem se corrigem).
 */
async function contagemErros({ empresaId }) {
  const donosAtivos = await Utilizador.find({ empresa_id: empresaId, role: 'parceiro', eliminado_em: null, ativo: { $ne: false } }).select('_id').lean();
  const casasAtivas = await Propriedade.find({ empresa_id: empresaId, parceiro_id: { $in: donosAtivos.map((d) => d._id) }, ativo: { $ne: false } }).select('_id').lean();
  const erros = await FonteCalendario.countDocuments({
    empresa_id: empresaId, removida: false, $or: [{ estado: 'erro' }, { aviso_muitos_novos_em: { $ne: null } }], propriedade_id: { $in: casasAtivas.map((c) => c._id) },
  });
  return resp(200, { erros });
}

/**
 * Confirmar ou marcar como bloqueio vários períodos (gestor, da sua empresa).
 * Sequencial (cada confirmação cria reserva e limpeza e entra na distribuição da equipa) mas com tempo contado: ao
 * fim de `orcamentoMs` pára e devolve os ids que ficaram por tratar (`nao_tratados`) para o ecrã os enviar a seguir,
 * por isso nenhum pedido chega ao limite de tempo do proxy. O proprietário recebe UM aviso por lote, não um por reserva.
 */
async function decidirLote({ ids, acao, empresaId, ator, orcamentoMs = Number(process.env.LOTE_ORCAMENTO_MS) || ORCAMENTO_LOTE_MS, relogio = Date.now }) {
  if (!['confirmar', 'bloqueio'].includes(acao)) return resp(400, { erro: 'Ação inválida.' });
  if (!Array.isArray(ids) || ids.length === 0) return resp(400, { erro: 'Escolhe pelo menos um período.' });
  if (ids.length > MAX_LOTE) return resp(400, { erro: `No máximo ${MAX_LOTE} períodos de cada vez.` });
  const unicos = [...new Set(ids.map(String))];
  const inicio = relogio();
  const resultados = [];
  const porDono = new Map();
  let i = 0;
  for (; i < unicos.length; i += 1) {
    if (i > 0 && relogio() - inicio >= orcamentoMs) break;
    const id = unicos[i];
    // eslint-disable-next-line no-await-in-loop
    const r = acao === 'confirmar'
      ? await D.confirmarExterna({ externaId: id, empresaId, parceiroId: null, ator, dados: {}, semAvisoDono: true })
      : await D.marcarBloqueio({ externaId: id, empresaId, parceiroId: null, ator });
    const ok = r.status >= 200 && r.status < 300;
    resultados.push({ id, ok, status: r.status, erro: r.status >= 300 ? (r.body && r.body.erro) || 'Falhou.' : null });
    if (ok && acao === 'confirmar' && r.body && r.body.externa && r.body.externa.parceiro_id) {
      const k = String(r.body.externa.parceiro_id);
      porDono.set(k, (porDono.get(k) || 0) + 1);
    }
  }
  for (const [donoId, n] of porDono) {
    // eslint-disable-next-line no-await-in-loop
    await notificarSino(donoId, `A All2gether confirmou ${n === 1 ? '1 reserva tua' : `${n} reservas tuas`} dos calendários ligados: as limpezas já estão marcadas.`, { tipo: 'aviso', url: '/parceiro/reservas', empresa_id: empresaId });
  }
  const ok = resultados.filter((r) => r.ok).length;
  const naoTratados = unicos.slice(i);
  return resp(200, { ok, falhas: resultados.length - ok, resultados, nao_tratados: naoTratados, incompleto: naoTratados.length > 0 });
}

module.exports = { resumoIntegracoes, contagemErros, decidirLote, MAX_LOTE };
