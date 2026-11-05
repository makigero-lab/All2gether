/**
 * Excel Controller — Importação e Exportação de Reservas/Tarefas via Excel.
 *
 * Permite ao gestor exportar todas as tarefas (com dados de reserva) para um
 * ficheiro .xlsx, e importar reservas em massa a partir de um Excel (fazendo
 * match do nome da propriedade). O parceiro faz o mesmo apenas nas suas casas.
 *
 * Rotas (gestor: /api/gestor/reservas ; parceiro: /api/parceiro/reservas):
 *   GET  /exportar-excel    — download direto de .xlsx
 *   POST /importar-excel    — upload de .xlsx (body RAW, ver express.raw nas rotas)
 *
 * Segurança: o ficheiro é validado (tamanho, assinatura ZIP 'PK', máx. linhas)
 * antes de ser lido; nunca se devolve err.message ao cliente.
 */

const ExcelJS = require('exceljs');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const ReservaManual = require('../models/ReservaManual');
const { planearAtribuicao } = require('../utils/atribuicaoAutomatica');
const { verificarTamanhoXlsx } = require('../utils/xlsxLimites');
const { obterLock, libertarLock } = require('../utils/lockEmpresa');
const { notificarUtilizador, avisarGestores } = require('../utils/notificar');

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_LINHAS_IMPORT = 2000;
// Tempo máximo que o pedido espera pela atribuição automática. O que não couber
// continua em segundo plano e o resultado diz quantas ficaram a atribuir.
const orcamentoAtribuicaoMs = () => Number(process.env.IMPORT_ORCAMENTO_ATRIBUICAO_MS) || 20000;
const MOTIVO_A_ATRIBUIR = 'Atribuição automática em curso';
const MAX_DETALHE_NAO_ATRIBUIDAS = 50;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Formata uma Data (UTC) como dd/mm/aaaa — independente do locale/ICU do Node. */
function formatarDataPT(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
}

/** Date (UTC) -> 'aaaa-mm-dd'. */
function paraISO(d) {
  return d.toISOString().slice(0, 10);
}

/** Cria uma data UTC validando dia/mês (rejeita 31/02, 32/13, etc.). */
function criarDataUTC(ano, mes, dia) {
  if (![ano, mes, dia].every(Number.isInteger)) return null;
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return d;
}

/**
 * Converte um valor de célula Excel numa Data UTC (meia-noite) ou null.
 * Aceita: número serial do Excel, Date, 'dd/mm/aaaa', 'aaaa-mm-dd' (ISO).
 */
function parseDataExcel(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime())
      ? null
      : criarDataUTC(valor.getUTCFullYear(), valor.getUTCMonth() + 1, valor.getUTCDate());
  }
  const texto = typeof valor === 'number' ? null : String(valor).trim();
  // Número serial do Excel (dias desde 1899-12-30).
  let serial = null;
  if (typeof valor === 'number') serial = valor;
  else if (/^\d{5}(\.\d+)?$/.test(texto)) serial = Number(texto);
  if (serial !== null) {
    if (serial < 36526 || serial > 73415) return null; // 2000-01-01 .. 2100-12-31
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    return criarDataUTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
  if (m) return criarDataUTC(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(texto);
  if (m) return criarDataUTC(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** Primeiro valor não vazio entre vários nomes possíveis de coluna. */
function col(linha, ...nomes) {
  for (const n of nomes) {
    const v = linha[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Normaliza o valor de uma célula ExcelJS (texto rico, fórmula, link, data...). */
function valorCelula(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return valorCelula(v.result);
    if ('text' in v) return valorCelula(v.text);
    if ('error' in v) return '';
    return '';
  }
  return v;
}

/**
 * Lê e valida o .xlsx enviado em req.body (Buffer). Devolve { linhas } ou
 * { status, erro }. A 1.ª linha da 1.ª folha são os cabeçalhos.
 */
async function lerLinhasExcel(req) {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { status: 400, erro: 'Ficheiro Excel em falta. Envie o .xlsx no body do pedido.' };
  }
  if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
    return { status: 400, erro: 'Ficheiro inválido: não é um .xlsx.' };
  }
  // Antes de descomprimir: um xlsx pequeno pode ocultar centenas de milhares de linhas.
  const tam = verificarTamanhoXlsx(body);
  if (!tam.ok) {
    return tam.motivo === 'grande'
      ? { status: 400, erro: `O ficheiro é demasiado grande (o limite é de ${MAX_LINHAS_IMPORT} linhas). Divide-o em ficheiros mais pequenos.` }
      : { status: 400, erro: 'Ficheiro inválido: não foi possível ler o .xlsx.' };
  }
  let ws;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body);
    ws = wb.worksheets[0];
  } catch {
    return { status: 400, erro: 'Ficheiro inválido: não foi possível ler o .xlsx.' };
  }
  if (!ws) return { status: 400, erro: 'Sheet vazio ou inválido.' };
  if (ws.actualRowCount - 1 > MAX_LINHAS_IMPORT) {
    return { status: 400, erro: `O ficheiro excede o máximo de ${MAX_LINHAS_IMPORT} linhas.` };
  }

  const cabecalhos = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, n) => {
    cabecalhos[n] = String(valorCelula(cell.value)).trim();
  });

  const linhas = [];
  ws.eachRow({ includeEmpty: false }, (row, numero) => {
    if (numero === 1) return;
    const obj = {};
    let temDados = false;
    cabecalhos.forEach((nome, n) => {
      if (!nome) return;
      const v = valorCelula(row.getCell(n).value);
      obj[nome] = v;
      if (v !== '') temDados = true;
    });
    if (temDados) linhas.push(obj);
  });

  if (linhas.length === 0) {
    return { status: 400, erro: 'O ficheiro Excel não tem linhas de dados.' };
  }
  return { linhas };
}

function mapaPorNome(propriedades) {
  const mapa = new Map();
  for (const p of propriedades) mapa.set(p.nome.toLowerCase().trim(), p);
  return mapa;
}

async function enviarXlsx(res, linhas, nomeFicheiro) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reservas');
  const colunas = Object.keys(linhas[0] || {});
  ws.columns = colunas.map((c) => ({ header: c, key: c, width: Math.max(14, c.length + 4) }));
  ws.getRow(1).font = { bold: true };
  for (const l of linhas) ws.addRow(l);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', MIME_XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${nomeFicheiro}"`);
  return res.send(buffer);
}

/**
 * Atribui, uma a uma (a carga de cada uma conta para a seguinte), as tarefas
 * acabadas de criar. Espera no máximo orcamentoAtribuicaoMs(); o resto continua
 * em segundo plano. No fim avisa cada pessoa UMA vez e os gestores UMA vez.
 * Nunca lança.
 */
async function atribuirLote(itens, empresaId) {
  const resultado = { atribuidas: 0, emSegundoPlano: 0, detalheNaoAtribuidas: [] };
  if (itens.length === 0) return resultado;

  const porPessoa = new Map(); // idStr -> [rotulos]
  let naoAtribuidas = 0;
  const livre = (item) => ({ _id: item.tarefa._id, estado: 'por_atribuir', utilizador_id: null });

  const processar = async (item, ctx) => {
    try {
      const plano = await planearAtribuicao({
        empresaId,
        propriedade: item.propriedade,
        dia: item.tarefa.data,
        tempoLimpeza: item.tarefa.tempo_limpeza_minutos,
      });
      if (plano.estado === 'atribuida') {
        // Só grava se ninguém mexeu na tarefa entretanto (ex.: gestor a atribuir à mão).
        const r = await Tarefa.updateOne(livre(item), {
          $set: {
            utilizador_id: plano.utilizador_id,
            equipa_atribuida: plano.equipa_atribuida,
            data: plano.data,
            tempo_viagem_minutos: plano.tempo_viagem_minutos,
            estado: 'atribuida',
            motivo_nao_atribuicao: null,
            pessoas_em_falta: plano.faltam,
          },
        });
        if (r.modifiedCount === 1) {
          ctx.atribuidas++;
          for (const id of plano.equipa_atribuida) {
            const k = String(id);
            if (!porPessoa.has(k)) porPessoa.set(k, []);
            porPessoa.get(k).push(item.rotulo);
          }
        }
        return;
      }
      await Tarefa.updateOne(livre(item), {
        $set: { estado: plano.estado, motivo_nao_atribuicao: plano.motivo_nao_atribuicao },
      });
      naoAtribuidas++;
      ctx.detalhe.push(`Linha ${item.linha}: ${item.rotulo}: ${plano.motivo_nao_atribuicao || 'por atribuir'}`);
    } catch (err) {
      console.error('⚠️  excel.atribuirLote:', err.message);
      await Tarefa.updateOne(livre(item), {
        $set: { motivo_nao_atribuicao: 'Erro na auto-atribuição' },
      }).catch(() => {});
      naoAtribuidas++;
      ctx.detalhe.push(`Linha ${item.linha}: ${item.rotulo}: Erro na auto-atribuição`);
    }
  };

  const finalizar = async () => {
    try {
      for (const [idStr, rotulos] of porPessoa) {
        await notificarUtilizador(
          idStr,
          '🧹 Novas limpezas atribuídas',
          rotulos.length === 1
            ? `Foste escalado para limpar a ${rotulos[0]}.`
            : `Foste escalado para ${rotulos.length} limpezas (importação de Excel). Vê a tua agenda.`,
          '/staff',
          { tipo: 'tarefa_atribuida', empresa_id: String(empresaId), criarInApp: true }
        );
      }
      if (naoAtribuidas > 0) {
        await avisarGestores(
          empresaId,
          '⚠️ Limpezas por atribuir',
          `A importação de Excel deixou ${naoAtribuidas} limpeza(s) por atribuir (sem equipa disponível). Vê o motivo em cada tarefa.`,
          '/gestor/tarefas'
        );
      }
    } catch (e) {
      console.error('⚠️  excel.finalizar:', e.message);
    }
  };

  const ctx = { atribuidas: 0, detalhe: resultado.detalheNaoAtribuidas };
  const limite = Date.now() + orcamentoAtribuicaoMs();
  let i = 0;
  for (; i < itens.length; i++) {
    if (Date.now() > limite) break;
    await processar(itens[i], ctx);
  }
  resultado.atribuidas = ctx.atribuidas;

  if (i < itens.length) {
    // Continua em segundo plano: o pedido responde já.
    const restantes = itens.slice(i);
    resultado.emSegundoPlano = restantes.length;
    setImmediate(async () => {
      const ctxBg = { atribuidas: 0, detalhe: [] };
      for (const item of restantes) await processar(item, ctxBg);
      await finalizar();
    });
  } else {
    await finalizar();
  }
  return resultado;
}

/**
 * Núcleo comum da importação (gestor e parceiro).
 *  - Match de propriedade por nome (case-insensitive) via `mapaProps`.
 *  - Fallback de hóspedes para a capacidade da propriedade.
 *  - Idempotente: ignora se já existe limpeza na mesma casa e data.
 */
/** "Ana, Bruno": responsável primeiro, sem repetidos. */
function nomesDaEquipa(t) {
  if (!t.utilizador_id) return '';
  const vistos = new Set();
  const nomes = [];
  for (const m of [t.utilizador_id, ...(t.equipa_atribuida || [])]) {
    if (!m || !m.nome || vistos.has(String(m._id))) continue;
    vistos.add(String(m._id));
    nomes.push(m.nome);
  }
  return nomes.join(', ');
}

const TEMPO_ESPERA_LOCK_MS = Number(process.env.IMPORT_LOCK_ESPERA_MS) || 30000;

async function importarLinhas({
  linhas,
  mapaProps,
  empresaId,
  utilizadorId,
  origemParceiro,
  msgNaoEncontrada,
}) {
  let criadas = 0;
  let ignoradas = 0;
  let erros = 0;
  const detalheErros = [];
  const chavesVistas = new Set();
  const porAtribuirLista = [];

  // Lock por empresa (com expiração) só durante a CRIAÇÃO: duas importações
  // simultâneas esperam uma pela outra, e a 2.ª já vê as limpezas da 1.ª
  // (fica tudo "ignorado" em vez de duplicado). A atribuição corre fora do lock.
  const chaveLock = `import:${empresaId}`;
  const donoLock = await obterLock(chaveLock, { ttlMs: 120000, esperaMs: TEMPO_ESPERA_LOCK_MS });
  if (!donoLock) {
    const e = new Error('Há outra importação em curso para esta empresa. Tenta outra vez dentro de instantes.');
    e.status = 409;
    throw e;
  }
  try {
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    const nLinha = i + 2;
    try {
      const nomeProp = String(col(linha, 'Propriedade', 'propriedade', 'Nome', 'nome') ?? '').trim();
      const hospedes = col(linha, 'Hóspedes', 'hospedes', 'Hospedes');
      const checkInRaw = col(linha, 'Check-in', 'check_in', 'checkin');
      const checkOutRaw = col(linha, 'Check-out', 'check_out', 'checkout');
      const dataRaw = col(linha, 'Data', 'data');
      const nomeHospede = String(col(linha, 'Nome Hóspede', 'nome_hospede', 'hospede') ?? '').trim();
      const observacoes = String(col(linha, 'Observações', 'observacoes') ?? '').trim();

      if (!nomeProp) {
        detalheErros.push(`Linha ${nLinha}: Propriedade em falta.`);
        erros++;
        continue;
      }
      const prop = mapaProps.get(nomeProp.toLowerCase());
      if (!prop) {
        detalheErros.push(`Linha ${nLinha}: Propriedade "${nomeProp}" ${msgNaoEncontrada}`);
        erros++;
        continue;
      }

      // A tarefa é agendada para o check-out (ou, na falta, para a coluna Data).
      const brutoSaida = checkOutRaw ?? dataRaw;
      const dataTarefa = parseDataExcel(brutoSaida);
      if (!dataTarefa) {
        detalheErros.push(`Linha ${nLinha}: Data inválida "${brutoSaida ?? ''}".`);
        erros++;
        continue;
      }
      const checkOutISO = paraISO(dataTarefa);
      dataTarefa.setUTCHours(10, 0, 0, 0); // 10:00 UTC default

      let dataCheckIn = dataTarefa;
      let checkInISO = null;
      if (checkInRaw !== null) {
        const ci = parseDataExcel(checkInRaw);
        if (!ci) {
          detalheErros.push(`Linha ${nLinha}: Check-in inválido "${checkInRaw}".`);
          erros++;
          continue;
        }
        checkInISO = paraISO(ci);
        dataCheckIn = ci;
      }

      // Fallback de hóspedes — se vazio/zero, usa a capacidade da propriedade.
      let numHospedes = hospedes !== null ? Number(hospedes) : null;
      if (numHospedes === null || numHospedes === 0 || Number.isNaN(numHospedes)) {
        numHospedes = prop.capacidade_hospedes ?? null;
      }

      // Chave natural (idempotência): empresa + propriedade + DIA do check-out +
      // tipo limpeza + não cancelada. Compara o dia (não a hora): depois de
      // atribuída, a hora de início muda, e reimportar duplicava.
      const chave = `${prop._id}|${checkOutISO}`;
      if (chavesVistas.has(chave)) {
        ignoradas++;
        continue;
      }
      const inicioDia = new Date(dataTarefa);
      inicioDia.setUTCHours(0, 0, 0, 0);
      const existente = await Tarefa.exists({
        empresa_id: empresaId,
        propriedade_id: prop._id,
        data: { $gte: inicioDia, $lt: new Date(inicioDia.getTime() + 86400000) },
        tipo: 'limpeza',
        estado: { $ne: 'cancelada' },
      });
      if (existente) {
        ignoradas++;
        continue;
      }
      chavesVistas.add(chave);

      const novaReserva = await ReservaManual.create({
        propriedade_id: prop._id,
        parceiro_id: utilizadorId,
        empresa_id: empresaId,
        check_in: dataCheckIn,
        check_out: dataTarefa,
        hospedes: numHospedes,
        observacoes,
      });

      const novaTarefa = await Tarefa.create({
        empresa_id: empresaId,
        propriedade_id: prop._id,
        smoobu_reserva_id: null,
        origem: 'manual',
        utilizador_id: null,
        equipa_atribuida: [],
        data: dataTarefa,
        tempo_limpeza_minutos: prop.tempo_limpeza_minutos || 45,
        tipo: 'limpeza',
        estado: 'por_atribuir',
        motivo_nao_atribuicao: MOTIVO_A_ATRIBUIR,
        observacoes,
        hospedes: numHospedes,
        origem_parceiro: origemParceiro,
        checklist: prop.checklist || [],
        detalhes_reserva: {
          checkin: checkInISO,
          checkout: checkOutISO,
          pax: numHospedes,
          nome_hospede: nomeHospede || null,
        },
      });

      novaReserva.tarefa_gerada_id = novaTarefa._id;
      await novaReserva.save();
      criadas++;
      porAtribuirLista.push({
        linha: nLinha,
        tarefa: novaTarefa,
        propriedade: prop,
        rotulo: `${prop.nome} (${formatarDataPT(dataTarefa)})`,
      });
    } catch (errLinha) {
      console.error(`❌ excel.importar linha ${nLinha}:`, errLinha.message);
      detalheErros.push(`Linha ${nLinha}: erro ao processar a linha.`);
      erros++;
    }
  }

  } finally {
    await libertarLock(chaveLock, donoLock);
  }

  // Atribuição automática (mesmo motor dos outros caminhos).
  const atrib = await atribuirLote(porAtribuirLista, empresaId);
  const porAtribuir = criadas - atrib.atribuidas;

  let message = `${criadas} reserva(s) criada(s)`;
  if (criadas > 0) {
    message += ` (${atrib.atribuidas} atribuída(s), ${porAtribuir} por atribuir`;
    message += atrib.emSegundoPlano > 0 ? `, ${atrib.emSegundoPlano} a atribuir em segundo plano)` : ')';
  }
  if (ignoradas > 0) message += `, ${ignoradas} já existiam (ignoradas)`;
  if (erros > 0) message += `, ${erros} com erro`;
  message += ` (de ${linhas.length} linhas).`;

  return {
    criadas,
    ignoradas,
    erros,
    atribuidas: atrib.atribuidas,
    porAtribuir,
    emSegundoPlano: atrib.emSegundoPlano,
    detalheErros: detalheErros.slice(0, 20),
    detalheNaoAtribuidas: atrib.detalheNaoAtribuidas.slice(0, MAX_DETALHE_NAO_ATRIBUIDAS),
    totalLinhas: linhas.length,
    message,
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/gestor/reservas/exportar-excel                              */
/* ------------------------------------------------------------------ */
exports.exportarExcel = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome morada capacidade_hospedes' })
      .populate({ path: 'utilizador_id', select: 'nome' })
      .populate({ path: 'equipa_atribuida', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    const linhas = tarefas.map((t) => ({
      'Data': t.data ? formatarDataPT(t.data) : '',
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Hóspedes': t.hospedes ?? t.detalhes_reserva?.pax ?? t.propriedade_id?.capacidade_hospedes ?? '',
      'Origem': t.origem ?? '',
      'Parceiro': t.origem_parceiro ? 'Sim' : 'Não',
      'Tipo': t.tipo ?? '',
      'Estado': t.estado ?? '',
      // Todos os membros (responsável primeiro, sem repetidos); sem responsável = sem equipa.
      'Equipa': nomesDaEquipa(t),
      'Check-in': t.detalhes_reserva?.checkin ?? '',
      'Check-out': t.detalhes_reserva?.checkout ?? '',
      'Nome Hóspede': t.detalhes_reserva?.nome_hospede ?? '',
      'Observações': t.observacoes ?? '',
    }));

    return enviarXlsx(res, linhas, 'reservas_all2gether.xlsx');
  } catch (err) {
    console.error('❌ excel.exportarExcel:', err.message);
    return res.status(500).json({ erro: 'Erro ao gerar Excel.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/gestor/reservas/importar-excel                             */
/* ------------------------------------------------------------------ */
exports.importarExcel = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    const gestorId = req.user && req.user.id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }
    const lido = await lerLinhasExcel(req);
    if (lido.erro) return res.status(lido.status).json({ erro: lido.erro });

    const propriedades = await Propriedade.find({ empresa_id: empresaId, ativo: true }).lean();
    const resultado = await importarLinhas({
      linhas: lido.linhas,
      mapaProps: mapaPorNome(propriedades),
      empresaId,
      utilizadorId: gestorId,
      origemParceiro: false,
      msgNaoEncontrada: 'não encontrada.',
    });
    return res.status(200).json(resultado);
  } catch (err) {
    console.error('❌ excel.importarExcel:', err.message);
    if (err.status === 409) return res.status(409).json({ erro: err.message });
    return res.status(500).json({ erro: 'Erro ao importar Excel.' });
  }
};

/* ------------------------------------------------------------------ */
/* GET /api/parceiro/reservas/exportar-excel — Exportar (Parceiro)     */
/* Filtra estritamente por parceiro_id (+ empresa).                    */
/* ------------------------------------------------------------------ */
exports.exportarExcelParceiro = async (req, res) => {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(400).json({ erro: 'Autenticação em falta.' });
    }

    const propriedades = await Propriedade.find({
      parceiro_id: parceiroId,
      empresa_id: empresaId,
      ativo: true,
    })
      .select('_id')
      .lean();
    const propIds = propriedades.map((p) => p._id);

    if (propIds.length === 0) {
      return enviarXlsx(
        res,
        [{ 'Propriedade': '', 'Check-in': '', 'Check-out': '', 'Hóspedes': '', 'Estado': '' }],
        'minhas_reservas.xlsx'
      );
    }

    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      propriedade_id: { $in: propIds },
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    const linhas = tarefas.map((t) => ({
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Check-in': t.detalhes_reserva?.checkin ?? '',
      'Check-out': t.detalhes_reserva?.checkout ?? '',
      'Hóspedes': t.hospedes ?? t.detalhes_reserva?.pax ?? '',
      'Estado': t.estado ?? '',
    }));

    return enviarXlsx(res, linhas, 'minhas_reservas.xlsx');
  } catch (err) {
    console.error('❌ excel.exportarExcelParceiro:', err.message);
    return res.status(500).json({ erro: 'Erro ao gerar Excel.' });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/parceiro/reservas/importar-excel — Importar (Parceiro)    */
/* Só aceita propriedades do próprio parceiro (parceiro_id + empresa). */
/* ------------------------------------------------------------------ */
exports.importarExcelParceiro = async (req, res) => {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(400).json({ erro: 'Autenticação em falta.' });
    }
    const lido = await lerLinhasExcel(req);
    if (lido.erro) return res.status(lido.status).json({ erro: lido.erro });

    const propriedades = await Propriedade.find({
      parceiro_id: parceiroId,
      empresa_id: empresaId,
      ativo: true,
    }).lean();
    const resultado = await importarLinhas({
      linhas: lido.linhas,
      mapaProps: mapaPorNome(propriedades),
      empresaId,
      utilizadorId: parceiroId,
      origemParceiro: true,
      msgNaoEncontrada: 'não encontrada (ou não te pertence).',
    });
    // O motivo de não atribuição é informação interna da operação: o parceiro não a vê.
    delete resultado.detalheNaoAtribuidas;
    return res.status(200).json(resultado);
  } catch (err) {
    console.error('❌ excel.importarExcelParceiro:', err.message);
    if (err.status === 409) return res.status(409).json({ erro: err.message });
    return res.status(500).json({ erro: 'Erro ao importar Excel.' });
  }
};
