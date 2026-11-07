/**
 * Excel Controller — Exportação de Reservas/Tarefas para Excel.
 *
 * O gestor exporta todas as tarefas (com dados de reserva) e o parceiro exporta
 * só as suas casas. Não há importação: as reservas entram pelo parceiro, pelo
 * Smoobu ou à mão no ecrã do gestor.
 *
 * Rotas:
 *   GET  /api/gestor/reservas/exportar-excel     — download direto de .xlsx
 *   GET  /api/parceiro/reservas/exportar-excel   — export só das casas do parceiro
 */

const ExcelJS = require('exceljs');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const { tipoDe, ROTULOS_TIPO } = require('../utils/tipoLimpeza');

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';


/** Formata uma Data (UTC) como dd/mm/aaaa — independente do locale/ICU do Node. */
function formatarDataPT(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
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
      // Listagem leve: as fotos (base64) só vão no detalhe/prova.
      .select('-fotos_conclusao -avarias.fotos')
      .lean();

    const linhas = tarefas.map((t) => ({
      'Data': t.data ? formatarDataPT(t.data) : '',
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Hóspedes': t.hospedes ?? t.detalhes_reserva?.pax ?? t.propriedade_id?.capacidade_hospedes ?? '',
      'Origem': t.origem ?? '',
      'Parceiro': t.origem_parceiro ? 'Sim' : 'Não',
      'Tipo': t.tipo ?? '',
      'Tipo de limpeza': ROTULOS_TIPO[tipoDe(t)],
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
        [{ 'Propriedade': '', 'Tipo de limpeza': '', 'Check-in': '', 'Check-out': '', 'Hóspedes': '', 'Estado': '' }],
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
      // Listagem leve: as fotos (base64) só vão no detalhe/prova.
      .select('-fotos_conclusao -avarias.fotos')
      .lean();

    const linhas = tarefas.map((t) => ({
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Tipo de limpeza': ROTULOS_TIPO[tipoDe(t)],
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
